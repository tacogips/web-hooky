// Package webhooky is the Go client for a web-hooky server.
//
// It covers the three surfaces a consumer of the server uses: reading stored
// records (GET /_get/{fetchUuid}), streaming them (WS /_ws/{fetchUuid}), and
// administration (/_admin/api).
//
// Nothing in this package reads the process environment. Credentials, the base
// URL, timeouts and extra headers are passed explicitly, so one process can
// hold several clients with different identities and tests need no environment
// fixture. The bundled CLI (cmd/webhooky) is the only place that consults
// WEBHOOKY_* variables, and it builds the very same Config.
package webhooky

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Version is reported in the default User-Agent.
const Version = "0.1.0"

// DefaultTimeout applies when Config.Timeout is zero.
const DefaultTimeout = 30 * time.Second

// Config configures both client types.
//
// A fetch client authenticates with APIKey/APISecret; an admin client
// authenticates with Credential ("<keyId>:<secret>"), or with Headers alone
// when the deployment puts an identity-provider proxy in front of the origin.
type Config struct {
	// BaseURL is the server root, for example "https://hooks.example.com".
	// A ws:// or wss:// URL is accepted and mapped to its http equivalent.
	BaseURL string

	// APIKey and APISecret identify a fetch API user. Required by NewClient.
	APIKey    string
	APISecret string

	// Credential is "<keyId>:<secret>" for an admin API key. Optional for
	// NewAdminClient when Headers carry an IdP identity instead.
	Credential string

	// Timeout bounds a single HTTP request. Zero means DefaultTimeout.
	// It does not bound a stream, which is long-lived by nature.
	Timeout time.Duration

	// Headers are merged into every request. Use them for an IdP identity
	// header and a proxy shared secret. They never override the
	// Authorization header this client sets.
	Headers map[string]string

	// UserAgent overrides the default "webhooky-go/<version>".
	UserAgent string
}

// resolved is a validated Config: the parsed base URL, the authorization value
// to send, and the header set to merge.
type resolved struct {
	httpBase  string
	wsBase    string
	authValue string
	headers   map[string]string
	timeout   time.Duration
	userAgent string
}

// ErrMissingBaseURL is returned when Config.BaseURL is empty.
var ErrMissingBaseURL = errors.New("webhooky: BaseURL is required")

// ErrMissingFetchCredentials is returned when a fetch client has no key pair.
var ErrMissingFetchCredentials = errors.New("webhooky: APIKey and APISecret are required")

// normalizeBase parses BaseURL and returns its http and ws forms.
//
// Accepting a ws:// base URL costs one switch here and saves every caller from
// having to remember which scheme a given surface wants.
func normalizeBase(raw string) (httpBase string, wsBase string, err error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", "", ErrMissingBaseURL
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", "", fmt.Errorf("webhooky: BaseURL is not a valid URL: %w", err)
	}
	if parsed.Host == "" {
		return "", "", fmt.Errorf("webhooky: BaseURL %q has no host", raw)
	}

	httpScheme := ""
	wsScheme := ""
	switch parsed.Scheme {
	case "http", "ws":
		httpScheme, wsScheme = "http", "ws"
	case "https", "wss":
		httpScheme, wsScheme = "https", "wss"
	default:
		return "", "", fmt.Errorf("webhooky: BaseURL scheme %q must be http, https, ws or wss", parsed.Scheme)
	}

	httpURL := *parsed
	httpURL.Scheme = httpScheme
	wsURL := *parsed
	wsURL.Scheme = wsScheme
	return strings.TrimRight(httpURL.String(), "/"), strings.TrimRight(wsURL.String(), "/"), nil
}

func (c Config) resolve(authValue string) (resolved, error) {
	httpBase, wsBase, err := normalizeBase(c.BaseURL)
	if err != nil {
		return resolved{}, err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	userAgent := strings.TrimSpace(c.UserAgent)
	if userAgent == "" {
		userAgent = "webhooky-go/" + Version
	}
	headers := make(map[string]string, len(c.Headers))
	for name, value := range c.Headers {
		headers[name] = value
	}
	return resolved{
		httpBase:  httpBase,
		wsBase:    wsBase,
		authValue: authValue,
		headers:   headers,
		timeout:   timeout,
		userAgent: userAgent,
	}, nil
}

// bearerFromPair builds the Authorization value for a key/secret pair.
func bearerFromPair(keyID, secret string) string {
	return "Bearer " + keyID + ":" + secret
}
