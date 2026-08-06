package webhooky

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// streamServer accepts one WebSocket, sends the frames, then closes with the
// supplied status.
func streamServer(t *testing.T, frames []string, closeStatus websocket.StatusCode) (*httptest.Server, *atomic.Value) {
	t.Helper()
	lastAuth := &atomic.Value{}
	lastAuth.Store("")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastAuth.Store(r.Header.Get("authorization") + "|" + r.URL.RawQuery)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		for _, frame := range frames {
			if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
				return
			}
		}
		_ = conn.Close(closeStatus, "test")
	}))
	t.Cleanup(server.Close)
	return server, lastAuth
}

func TestStreamDecodesRecordsAndReadyFrame(t *testing.T) {
	server, lastAuth := streamServer(t, []string{
		`{"type":"ready"}`,
		`{"type":"record","record":{"t":1,"fetched":false,"payload":{"n":1}}}`,
		`{"type":"record","record":{"t":2,"fetched":false,"payload":{"n":2}}}`,
	}, websocket.StatusNormalClosure)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ready := false
	var got []Record
	err := testClient(t, server.URL).Stream(ctx, "uuid", StreamOptions{
		MaxRecords: 2,
		OnReady:    func() { ready = true },
	}, func(record Record) error {
		got = append(got, record)
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !ready {
		t.Error("OnReady was not called for the server's ready frame")
	}
	if len(got) != 2 || got[0].T != 1 || got[1].T != 2 {
		t.Fatalf("records = %+v", got)
	}

	// The header form keeps credentials out of proxy access logs, so it is the
	// default; the query string must stay empty.
	auth, _ := lastAuth.Load().(string)
	if !strings.HasPrefix(auth, "Bearer key-1:sec-1|") {
		t.Errorf("handshake authorization = %q", auth)
	}
	if !strings.HasSuffix(auth, "|") {
		t.Errorf("handshake query = %q, want empty by default", auth)
	}
}

func TestStreamQueryCredentialsFallback(t *testing.T) {
	server, lastAuth := streamServer(t, []string{
		`{"type":"record","record":{"t":1,"fetched":false,"payload":{}}}`,
	}, websocket.StatusNormalClosure)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := testClient(t, server.URL).Stream(ctx, "uuid", StreamOptions{
		MaxRecords:       1,
		QueryCredentials: true,
	}, func(Record) error { return nil })
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	auth, _ := lastAuth.Load().(string)
	if !strings.HasPrefix(auth, "|") {
		t.Errorf("expected no Authorization header, got %q", auth)
	}
	if !strings.Contains(auth, "api_key=key-1") || !strings.Contains(auth, "api_secret=sec-1") {
		t.Errorf("query credentials missing from %q", auth)
	}
}

func TestStreamStopsOnPolicyViolation(t *testing.T) {
	// 1008 means the credential or grant was revoked. Reconnecting would only
	// hammer a server that has already refused, so the stream must end even
	// with reconnect enabled.
	server, _ := streamServer(t, []string{`{"type":"ready"}`}, websocket.StatusPolicyViolation)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := testClient(t, server.URL).Stream(ctx, "uuid", StreamOptions{
		Reconnect:      true,
		InitialBackoff: time.Millisecond,
	}, func(Record) error { return nil })

	if !errors.Is(err, ErrStreamClosedByServer) {
		t.Fatalf("Stream error = %v, want ErrStreamClosedByServer", err)
	}
}

func TestStreamHandlerErrorIsReturnedAndStopsRetrying(t *testing.T) {
	server, _ := streamServer(t, []string{
		`{"type":"record","record":{"t":1,"fetched":false,"payload":{}}}`,
	}, websocket.StatusNormalClosure)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sentinel := errors.New("caller stopped")
	err := testClient(t, server.URL).Stream(ctx, "uuid", StreamOptions{
		Reconnect:      true,
		InitialBackoff: time.Millisecond,
	}, func(Record) error { return sentinel })

	if !errors.Is(err, sentinel) {
		t.Fatalf("Stream error = %v, want the handler's own error", err)
	}
}

func TestStreamHandshakeFailureCarriesServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"kind":"forbidden","message":"Destination is disabled"}}`))
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := testClient(t, server.URL).Stream(ctx, "uuid", StreamOptions{}, func(Record) error { return nil })
	if err == nil {
		t.Fatal("expected a handshake error")
	}
	var apiError *Error
	if !asWebhookyError(err, &apiError) {
		t.Fatalf("error %v is not a *webhooky.Error", err)
	}
	if apiError.Status != http.StatusForbidden {
		t.Errorf("status = %d, want 403", apiError.Status)
	}
}

func TestBackoffIsCapped(t *testing.T) {
	initial := 500 * time.Millisecond
	max := 30 * time.Second
	if got := backoffFor(1, initial, max); got != initial {
		t.Errorf("first backoff = %v, want %v", got, initial)
	}
	if got := backoffFor(3, initial, max); got != 2*time.Second {
		t.Errorf("third backoff = %v, want 2s", got)
	}
	// A long-lived stream must not overflow into a negative or absurd delay.
	if got := backoffFor(500, initial, max); got != max {
		t.Errorf("far-out backoff = %v, want the %v ceiling", got, max)
	}
}
