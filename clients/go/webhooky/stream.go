package webhooky

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

// StreamOptions configures Client.Stream.
type StreamOptions struct {
	// Reconnect keeps the stream alive across transport failures, with capped
	// exponential backoff. A policy-violation close (1008) always ends the
	// stream even when this is set: the server closes with that code when the
	// credential or grant was revoked, and retrying would only hammer a server
	// that has already refused.
	Reconnect bool

	// InitialBackoff and MaxBackoff bound the reconnect delay.
	InitialBackoff time.Duration
	MaxBackoff     time.Duration

	// QueryCredentials sends the key pair as ?api_key=&api_secret= instead of
	// an Authorization header. The header is the default because a query
	// string ends up in proxy and server access logs; use this only where a
	// proxy strips Authorization from upgrade requests.
	QueryCredentials bool

	// OnReady fires when the server sends its {"type":"ready"} frame, once per
	// successful connection. Optional.
	OnReady func()

	// OnReconnect fires before each retry with the attempt number (starting at
	// 1) and the error that closed the previous connection. Optional.
	OnReconnect func(attempt int, err error)

	// MaxRecords stops the stream after this many records. 0 means unlimited.
	MaxRecords int
}

const (
	defaultInitialBackoff = 500 * time.Millisecond
	defaultMaxBackoff     = 30 * time.Second
	// maxStreamFrameBytes caps one inbound frame. Records are JSON payloads a
	// vendor sent; the server's own inbound body cap defaults to 1 MiB, and
	// this leaves generous headroom above it.
	maxStreamFrameBytes = 8 * 1024 * 1024
)

// ErrStreamClosedByServer is returned when the server closed the socket with a
// policy violation (1008), which means the credential or the grant behind this
// stream is no longer valid. Reconnecting will not help.
var ErrStreamClosedByServer = errors.New("webhooky: stream closed by server policy (credential or grant revoked)")

// streamFrame is one message from the server.
type streamFrame struct {
	Type   string `json:"type"`
	Record Record `json:"record"`
}

// Stream opens the WebSocket stream and calls handler for every record.
//
// It blocks until the context is cancelled, the handler returns an error, the
// record limit is reached, or - with Reconnect off - the connection drops. A
// handler error is returned as-is, so returning a sentinel is how a caller
// stops the loop deliberately.
func (c *Client) Stream(ctx context.Context, fetchUUID string, opts StreamOptions, handler func(Record) error) error {
	initial := opts.InitialBackoff
	if initial <= 0 {
		initial = defaultInitialBackoff
	}
	maxBackoff := opts.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = defaultMaxBackoff
	}

	delivered := 0
	attempt := 0
	for {
		err := c.streamOnce(ctx, fetchUUID, opts, handler, &delivered)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// A revoked credential and a handler error are both terminal: neither
		// is fixed by trying again.
		var stopped *handlerError
		if errors.As(err, &stopped) {
			return stopped.err
		}
		if errors.Is(err, ErrStreamClosedByServer) {
			return err
		}
		if !opts.Reconnect {
			return err
		}

		attempt++
		if opts.OnReconnect != nil {
			opts.OnReconnect(attempt, err)
		}
		delay := backoffFor(attempt, initial, maxBackoff)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// handlerError marks a failure that came from the caller's handler rather than
// from the connection, so the retry loop does not treat it as transport trouble
// and retry a stream the caller wanted stopped.
type handlerError struct{ err error }

func (h *handlerError) Error() string { return h.err.Error() }
func (h *handlerError) Unwrap() error { return h.err }

func backoffFor(attempt int, initial, max time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	// Shift by attempt-1, guarding the exponent so a long-lived stream cannot
	// overflow the duration.
	exponent := math.Min(float64(attempt-1), 20)
	delay := time.Duration(float64(initial) * math.Pow(2, exponent))
	if delay > max || delay <= 0 {
		return max
	}
	return delay
}

// streamURL builds the /_ws/ URL, adding query credentials when asked.
func (c *Client) streamURL(fetchUUID string, queryCredentials bool) string {
	built := c.cfg.wsBase + "/_ws/" + pathEscape(fetchUUID)
	if !queryCredentials {
		return built
	}
	keyID, secret, ok := splitCredential(trimBearer(c.cfg.authValue))
	if !ok {
		return built
	}
	values := url.Values{}
	values.Set("api_key", keyID)
	values.Set("api_secret", secret)
	return built + "?" + values.Encode()
}

func trimBearer(value string) string {
	const prefix = "Bearer "
	if len(value) > len(prefix) && value[:len(prefix)] == prefix {
		return value[len(prefix):]
	}
	return value
}

// streamOnce runs one connection to exhaustion.
func (c *Client) streamOnce(
	ctx context.Context,
	fetchUUID string,
	opts StreamOptions,
	handler func(Record) error,
	delivered *int,
) error {
	header := http.Header{}
	for name, value := range c.cfg.headers {
		header.Set(name, value)
	}
	header.Set("user-agent", c.cfg.userAgent)
	if !opts.QueryCredentials {
		header.Set("authorization", c.cfg.authValue)
	}

	conn, response, err := websocket.Dial(ctx, c.streamURL(fetchUUID, opts.QueryCredentials), &websocket.DialOptions{
		HTTPHeader: header,
	})
	if err != nil {
		// A rejected handshake carries the server's JSON error body, which is
		// far more useful than "bad handshake".
		if response != nil {
			return newHTTPError(response.StatusCode, readHandshakeBody(response))
		}
		return newTransportError("failed to open stream", err)
	}
	defer func() { _ = conn.CloseNow() }()
	conn.SetReadLimit(maxStreamFrameBytes)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusPolicyViolation {
				return ErrStreamClosedByServer
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return newTransportError("stream read failed", err)
		}

		var frame streamFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			return &Error{Message: "failed to decode stream frame: " + err.Error(), Err: err}
		}
		switch frame.Type {
		case "ready":
			if opts.OnReady != nil {
				opts.OnReady()
			}
		case "record":
			if err := handler(frame.Record); err != nil {
				return &handlerError{err: err}
			}
			*delivered++
			if opts.MaxRecords > 0 && *delivered >= opts.MaxRecords {
				_ = conn.Close(websocket.StatusNormalClosure, "done")
				return nil
			}
		default:
			// Unknown frame types are ignored so a server that grows a new
			// frame kind does not break an older client.
		}
	}
}

func readHandshakeBody(response *http.Response) []byte {
	if response.Body == nil {
		return nil
	}
	defer func() { _ = response.Body.Close() }()
	body := make([]byte, 0, 512)
	buffer := make([]byte, 512)
	for len(body) < maxErrorBodyBytes {
		n, err := response.Body.Read(buffer)
		body = append(body, buffer[:n]...)
		if err != nil {
			break
		}
	}
	return body
}
