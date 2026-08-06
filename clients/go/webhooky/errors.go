package webhooky

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Error is a failed web-hooky call.
//
// The server renders every failure as {"error":{"kind","message","details"?}},
// so Kind is the machine-readable discriminator and Status the HTTP status. A
// transport or protocol failure that never reached the server carries Status 0
// and an empty Kind, which is how a caller tells "the server said no" apart
// from "the server was not reachable".
type Error struct {
	// Status is the HTTP status code, or 0 for a transport failure.
	Status int
	// Kind is the server's error kind, or "" when the response carried none.
	Kind string
	// Message describes the failure.
	Message string
	// Details is the optional machine-readable detail the server attached.
	Details json.RawMessage
	// Err is the underlying transport error, when there was one.
	Err error
}

// Error kinds emitted by the server, mirroring src/core/errors.ts.
const (
	KindBadRequest       = "bad_request"
	KindUnauthorized     = "unauthorized"
	KindForbidden        = "forbidden"
	KindNotFound         = "not_found"
	KindMethodNotAllowed = "method_not_allowed"
	KindConflict         = "conflict"
	KindPayloadTooLarge  = "payload_too_large"
	KindUnprocessable    = "unprocessable_entity"
	KindNotImplemented   = "not_implemented"
	KindInternal         = "internal"
)

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("webhooky: ")
	if e.Status > 0 {
		fmt.Fprintf(&b, "%d ", e.Status)
	}
	if e.Kind != "" {
		fmt.Fprintf(&b, "(%s) ", e.Kind)
	}
	b.WriteString(e.Message)
	return b.String()
}

// Unwrap exposes the transport error to errors.Is/errors.As.
func (e *Error) Unwrap() error { return e.Err }

// IsNotFound reports whether err is a 404 from the server.
func IsNotFound(err error) bool { return hasKind(err, KindNotFound) }

// IsUnauthorized reports whether err is a 401 from the server.
func IsUnauthorized(err error) bool { return hasKind(err, KindUnauthorized) }

// IsForbidden reports whether err is a 403 from the server.
func IsForbidden(err error) bool { return hasKind(err, KindForbidden) }

func hasKind(err error, kind string) bool {
	var target *Error
	if !errors.As(err, &target) {
		return false
	}
	return target.Kind == kind
}

// errorEnvelope is the server's failure body.
type errorEnvelope struct {
	Error struct {
		Kind    string          `json:"kind"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	} `json:"error"`
}

// newHTTPError builds an Error from a non-2xx response body.
//
// A body that is not the server envelope (a proxy's HTML error page, an empty
// 502) still has to produce something actionable, so the status becomes the
// message in that case.
func newHTTPError(status int, body []byte) *Error {
	var envelope errorEnvelope
	if len(body) > 0 && json.Unmarshal(body, &envelope) == nil && envelope.Error.Message != "" {
		return &Error{
			Status:  status,
			Kind:    envelope.Error.Kind,
			Message: envelope.Error.Message,
			Details: envelope.Error.Details,
		}
	}
	snippet := strings.TrimSpace(string(body))
	if len(snippet) > 200 {
		snippet = snippet[:200] + "..."
	}
	if snippet == "" {
		return &Error{Status: status, Message: fmt.Sprintf("request failed with status %d", status)}
	}
	return &Error{Status: status, Message: fmt.Sprintf("request failed with status %d: %s", status, snippet)}
}

// newTransportError wraps a failure that never produced an HTTP status.
func newTransportError(message string, err error) *Error {
	return &Error{Message: message + ": " + err.Error(), Err: err}
}
