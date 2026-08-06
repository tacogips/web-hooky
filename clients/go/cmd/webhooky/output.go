package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// emit writes one JSON document to stdout.
func emit(global *globals, value any) error {
	encoder := json.NewEncoder(os.Stdout)
	if global.pretty {
		encoder.SetIndent("", "  ")
	}
	// The server's payloads are already-escaped JSON; re-escaping < > & would
	// mangle a webhook body that legitimately contains HTML.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("failed to write output: %w", err)
	}
	return nil
}

// lineWriter emits newline-delimited JSON, flushed per record so a stream
// composes with `jq` and `head` instead of sitting in a buffer.
type lineWriter struct {
	buffered *bufio.Writer
	encoder  *json.Encoder
}

func newLineWriter() *lineWriter {
	buffered := bufio.NewWriter(os.Stdout)
	encoder := json.NewEncoder(buffered)
	encoder.SetEscapeHTML(false)
	return &lineWriter{buffered: buffered, encoder: encoder}
}

func (w *lineWriter) write(value any) error {
	if err := w.encoder.Encode(value); err != nil {
		return fmt.Errorf("failed to write output: %w", err)
	}
	return w.buffered.Flush()
}

// parseJSONArg reads a JSON value given inline or as "@path/to/file.json".
//
// Shells make large inline JSON painful to quote correctly, and configuration
// for an addon is exactly the kind of thing that lives in a file already.
func parseJSONArg(raw string) (json.RawMessage, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "@") {
		path := trimmed[1:]
		contents, err := os.ReadFile(path)
		if err != nil {
			return nil, usageErrorf("failed to read %s: %v", path, err)
		}
		trimmed = strings.TrimSpace(string(contents))
	}
	if !json.Valid([]byte(trimmed)) {
		return nil, usageErrorf("value is not valid JSON: %s", truncate(trimmed, 80))
	}
	return json.RawMessage(trimmed), nil
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

// parseTimeArg accepts unix seconds or an RFC 3339 timestamp, matching what the
// server's `from`/`to` parameters take.
func parseTimeArg(raw, flagName string) (time.Time, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return time.Time{}, nil
	}
	if seconds, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		return time.Unix(seconds, 0), nil
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, usageErrorf("--%s must be unix seconds or an RFC 3339 timestamp", flagName)
	}
	return parsed, nil
}

// stringPtr and friends turn "flag was provided" into the pointer fields the
// partial-update inputs use, so an unset flag stays absent from the request
// body rather than being sent as a zero value.
func stringPtr(value string) *string { return &value }
func boolPtr(value bool) *bool       { return &value }
func int64Ptr(value int64) *int64    { return &value }
