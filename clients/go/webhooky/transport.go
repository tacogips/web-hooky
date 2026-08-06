package webhooky

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// maxErrorBodyBytes caps how much of a failure body is read.
//
// An error path must not be a way to make the client allocate without bound,
// and no useful server message is anywhere near this long.
const maxErrorBodyBytes = 64 * 1024

// transport performs authenticated JSON requests against one server.
type transport struct {
	cfg    resolved
	client *http.Client
}

func newTransport(cfg resolved, httpClient *http.Client) *transport {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: cfg.timeout}
	}
	return &transport{cfg: cfg, client: httpClient}
}

// requestSpec describes one call.
type requestSpec struct {
	method string
	path   string
	query  url.Values
	// body, when non-nil, is marshalled as JSON.
	body any
	// rawBody and contentType send a pre-encoded body (the addon upload).
	rawBody     []byte
	contentType string
	// sendOrigin adds an Origin header matching the server.
	//
	// The server's CSRF rule accepts an identity-provider request either with a
	// matching Origin or with content-type: application/json. A multipart
	// upload cannot use the latter, so it uses the former.
	sendOrigin bool
}

// isStateChanging reports whether a method needs the CSRF-satisfying content
// type. Safe methods are exempt from the server's check.
func isStateChanging(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func (t *transport) buildURL(path string, query url.Values) string {
	built := t.cfg.httpBase + path
	if len(query) > 0 {
		built += "?" + query.Encode()
	}
	return built
}

// do performs the request and returns the response body for a 2xx.
func (t *transport) do(ctx context.Context, spec requestSpec) ([]byte, error) {
	var reader io.Reader
	contentType := spec.contentType
	switch {
	case spec.rawBody != nil:
		reader = bytes.NewReader(spec.rawBody)
	case spec.body != nil:
		encoded, err := json.Marshal(spec.body)
		if err != nil {
			return nil, &Error{Message: "failed to encode request body: " + err.Error(), Err: err}
		}
		reader = bytes.NewReader(encoded)
		contentType = "application/json"
	}

	request, err := http.NewRequestWithContext(ctx, spec.method, t.buildURL(spec.path, spec.query), reader)
	if err != nil {
		return nil, newTransportError("failed to build request", err)
	}

	for name, value := range t.cfg.headers {
		request.Header.Set(name, value)
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("user-agent", t.cfg.userAgent)
	if t.cfg.authValue != "" {
		request.Header.Set("authorization", t.cfg.authValue)
	}
	if contentType != "" {
		request.Header.Set("content-type", contentType)
	} else if isStateChanging(spec.method) {
		// Bodyless writes (rotate, grant, delete) still declare JSON so the
		// identity-provider path clears the server's CSRF check.
		request.Header.Set("content-type", "application/json")
	}
	if spec.sendOrigin {
		if origin, err := url.Parse(t.cfg.httpBase); err == nil {
			request.Header.Set("origin", origin.Scheme+"://"+origin.Host)
		}
	}

	response, err := t.client.Do(request)
	if err != nil {
		return nil, newTransportError("request failed", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes))
		return nil, newHTTPError(response.StatusCode, body)
	}
	if response.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, newTransportError("failed to read response body", err)
	}
	return body, nil
}

// decode runs a request and unmarshals the response into out.
func decode[T any](ctx context.Context, t *transport, spec requestSpec) (T, error) {
	var out T
	body, err := t.do(ctx, spec)
	if err != nil {
		return out, err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, &Error{Message: "failed to decode response: " + err.Error(), Err: err}
	}
	return out, nil
}

// send runs a request whose response body is discarded.
func (t *transport) send(ctx context.Context, spec requestSpec) error {
	_, err := t.do(ctx, spec)
	return err
}

// pathEscape escapes a value used as a single URL path segment.
func pathEscape(segment string) string {
	return url.PathEscape(segment)
}

// splitCredential splits "<keyId>:<secret>" into its two halves.
func splitCredential(credential string) (keyID string, secret string, ok bool) {
	trimmed := strings.TrimSpace(credential)
	index := strings.Index(trimmed, ":")
	if index <= 0 || index == len(trimmed)-1 {
		return "", "", false
	}
	return trimmed[:index], trimmed[index+1:], true
}
