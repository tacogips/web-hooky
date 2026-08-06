package webhooky

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// capture records what the stub server saw, so a test can assert on the
// request the client built rather than only on the value it returned.
type capture struct {
	method      string
	path        string
	rawURI      string
	rawQuery    string
	auth        string
	contentType string
	origin      string
	userAgent   string
	body        string
	headers     http.Header
}

// stubServer answers every request with status and body, recording the last
// request it received.
func stubServer(t *testing.T, status int, body string) (*httptest.Server, *capture) {
	t.Helper()
	seen := &capture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buffer := make([]byte, 0, 1024)
		chunk := make([]byte, 1024)
		for {
			n, err := r.Body.Read(chunk)
			buffer = append(buffer, chunk[:n]...)
			if err != nil {
				break
			}
		}
		seen.method = r.Method
		seen.path = r.URL.Path
		seen.rawURI = r.RequestURI
		seen.rawQuery = r.URL.RawQuery
		seen.auth = r.Header.Get("authorization")
		seen.contentType = r.Header.Get("content-type")
		seen.origin = r.Header.Get("origin")
		seen.userAgent = r.Header.Get("user-agent")
		seen.headers = r.Header.Clone()
		seen.body = string(buffer)

		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		if body != "" {
			_, _ = w.Write([]byte(body))
		}
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{BaseURL: baseURL, APIKey: "key-1", APISecret: "sec-1"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func testAdmin(t *testing.T, baseURL string) *AdminClient {
	t.Helper()
	client, err := NewAdminClient(Config{BaseURL: baseURL, Credential: "admin-1:admin-secret"})
	if err != nil {
		t.Fatalf("NewAdminClient: %v", err)
	}
	return client
}

func TestNormalizeBase(t *testing.T) {
	cases := []struct {
		raw      string
		wantHTTP string
		wantWS   string
	}{
		{"http://localhost:8787", "http://localhost:8787", "ws://localhost:8787"},
		{"https://hooks.example.com/", "https://hooks.example.com", "wss://hooks.example.com"},
		{"wss://hooks.example.com//", "https://hooks.example.com", "wss://hooks.example.com"},
		{"http://localhost:8787/prefix/", "http://localhost:8787/prefix", "ws://localhost:8787/prefix"},
	}
	for _, testCase := range cases {
		httpBase, wsBase, err := normalizeBase(testCase.raw)
		if err != nil {
			t.Fatalf("normalizeBase(%q): %v", testCase.raw, err)
		}
		if httpBase != testCase.wantHTTP || wsBase != testCase.wantWS {
			t.Errorf("normalizeBase(%q) = (%q, %q), want (%q, %q)",
				testCase.raw, httpBase, wsBase, testCase.wantHTTP, testCase.wantWS)
		}
	}
}

func TestNormalizeBaseRejectsBadInput(t *testing.T) {
	for _, raw := range []string{"", "   ", "ftp://example.com", "not a url at all"} {
		if _, _, err := normalizeBase(raw); err == nil {
			t.Errorf("normalizeBase(%q) accepted an invalid base URL", raw)
		}
	}
}

func TestNewClientRequiresCredentials(t *testing.T) {
	if _, err := NewClient(Config{BaseURL: "http://localhost"}); err != ErrMissingFetchCredentials {
		t.Errorf("NewClient without credentials = %v, want ErrMissingFetchCredentials", err)
	}
	if _, err := NewClient(Config{APIKey: "a", APISecret: "b"}); err != ErrMissingBaseURL {
		t.Errorf("NewClient without base URL = %v, want ErrMissingBaseURL", err)
	}
}

func TestRecordsSendsBearerAndDefaultQuery(t *testing.T) {
	server, seen := stubServer(t, 200, `{"records":[{"t":10,"fetched":false,"payload":{"a":1}}]}`)
	records, err := testClient(t, server.URL).Records(context.Background(), "fetch-uuid", RecordQuery{})
	if err != nil {
		t.Fatalf("Records: %v", err)
	}

	if seen.path != "/_get/fetch-uuid" {
		t.Errorf("path = %q, want /_get/fetch-uuid", seen.path)
	}
	// A default query must send nothing: the server's own defaults apply.
	if seen.rawQuery != "" {
		t.Errorf("query = %q, want empty for a default query", seen.rawQuery)
	}
	if seen.auth != "Bearer key-1:sec-1" {
		t.Errorf("authorization = %q", seen.auth)
	}
	if !strings.HasPrefix(seen.userAgent, "webhooky-go/") {
		t.Errorf("user-agent = %q, want the default client agent", seen.userAgent)
	}
	if len(records) != 1 || records[0].T != 10 || records[0].Fetched {
		t.Fatalf("records = %+v", records)
	}
	if string(records[0].Payload) != `{"a":1}` {
		t.Errorf("payload = %s", records[0].Payload)
	}
}

func TestRecordsQueryParameters(t *testing.T) {
	server, seen := stubServer(t, 200, `{"records":[]}`)
	_, err := testClient(t, server.URL).Records(context.Background(), "uuid", RecordQuery{
		OnlyUnfetched: true,
		KeepUnfetched: true,
		From:          time.Unix(100, 0),
		To:            time.Unix(200, 0),
		Limit:         25,
	})
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	for _, want := range []string{"only_unfetched=true", "mark_fetched=false", "from=100", "to=200", "limit=25"} {
		if !strings.Contains(seen.rawQuery, want) {
			t.Errorf("query %q is missing %q", seen.rawQuery, want)
		}
	}
}

func TestRecordsReturnsEmptySliceNotNil(t *testing.T) {
	server, _ := stubServer(t, 200, `{"records":[]}`)
	records, err := testClient(t, server.URL).Records(context.Background(), "uuid", RecordQuery{})
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	// A caller marshalling this must get [] rather than null.
	if records == nil {
		t.Fatal("Records returned nil for an empty result")
	}
	encoded, _ := json.Marshal(records)
	if string(encoded) != "[]" {
		t.Errorf("marshalled empty result = %s, want []", encoded)
	}
}

func TestErrorEnvelopeIsDecoded(t *testing.T) {
	server, _ := stubServer(t, 403, `{"error":{"kind":"forbidden","message":"API user is not authorized for this destination"}}`)
	_, err := testClient(t, server.URL).Records(context.Background(), "uuid", RecordQuery{})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !IsForbidden(err) {
		t.Errorf("IsForbidden(%v) = false", err)
	}

	var apiError *Error
	if !asWebhookyError(err, &apiError) {
		t.Fatalf("error %v is not a *webhooky.Error", err)
	}
	if apiError.Status != 403 || apiError.Kind != KindForbidden {
		t.Errorf("status/kind = %d/%q", apiError.Status, apiError.Kind)
	}
	if !strings.Contains(apiError.Message, "not authorized") {
		t.Errorf("message = %q", apiError.Message)
	}
}

func TestNonEnvelopeErrorBodyStillReports(t *testing.T) {
	// A proxy answering with HTML must not produce an empty, useless error.
	server, _ := stubServer(t, 502, "<html>bad gateway</html>")
	_, err := testClient(t, server.URL).Records(context.Background(), "uuid", RecordQuery{})
	var apiError *Error
	if !asWebhookyError(err, &apiError) {
		t.Fatalf("error %v is not a *webhooky.Error", err)
	}
	if apiError.Status != 502 || apiError.Kind != "" {
		t.Errorf("status/kind = %d/%q, want 502/\"\"", apiError.Status, apiError.Kind)
	}
	if !strings.Contains(apiError.Message, "502") {
		t.Errorf("message = %q, want it to name the status", apiError.Message)
	}
}

func TestExtraHeadersAreSent(t *testing.T) {
	server, seen := stubServer(t, 200, `{"records":[]}`)
	client, err := NewClient(Config{
		BaseURL:   server.URL,
		APIKey:    "k",
		APISecret: "s",
		Headers:   map[string]string{"cf-access-authenticated-user-email": "ops@example.com"},
		UserAgent: "custom-agent/9",
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := client.Records(context.Background(), "uuid", RecordQuery{}); err != nil {
		t.Fatalf("Records: %v", err)
	}
	if got := seen.headers.Get("cf-access-authenticated-user-email"); got != "ops@example.com" {
		t.Errorf("identity header = %q", got)
	}
	if seen.userAgent != "custom-agent/9" {
		t.Errorf("user-agent = %q", seen.userAgent)
	}
}

// asWebhookyError is a local errors.As helper that keeps the test readable.
func asWebhookyError(err error, target **Error) bool {
	for err != nil {
		if typed, ok := err.(*Error); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}
