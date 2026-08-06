package main

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/tacogips/web-hooky/clients/go/webhooky"
)

// Environment variables read by the CLI.
//
// This file is the only place in the client that touches the environment: the
// library takes its configuration as explicit parameters, so an embedding
// application decides where credentials come from.
const (
	envURL             = "WEBHOOKY_URL"
	envAPIKey          = "WEBHOOKY_API_KEY"
	envAPISecret       = "WEBHOOKY_API_SECRET"
	envCredential      = "WEBHOOKY_CREDENTIAL"
	envFetchUUID       = "WEBHOOKY_FETCH_UUID"
	envAdminCredential = "WEBHOOKY_ADMIN_CREDENTIAL"
	envAdminKey        = "WEBHOOKY_ADMIN_KEY"
	envAdminSecret     = "WEBHOOKY_ADMIN_SECRET"
	envTimeout         = "WEBHOOKY_TIMEOUT_SECONDS"
	envHeaders         = "WEBHOOKY_HEADERS"
)

const defaultBaseURL = "http://127.0.0.1:8787"

// globals holds the flags every command accepts.
type globals struct {
	url     string
	timeout float64
	headers headerFlag
	pretty  bool
}

// headerFlag collects repeated --header name=value flags.
type headerFlag []string

func (h *headerFlag) String() string { return strings.Join(*h, ",") }

func (h *headerFlag) Set(value string) error {
	if !strings.Contains(value, "=") {
		return errors.New(`expected "name=value"`)
	}
	*h = append(*h, value)
	return nil
}

// parseHeaderList splits a "name=value,name=value" string.
//
// A value may itself contain "=" (a base64 proxy secret, for instance), so only
// the first separator is significant.
func parseHeaderList(raw string) (map[string]string, error) {
	headers := map[string]string{}
	for _, entry := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		index := strings.Index(trimmed, "=")
		if index <= 0 {
			return nil, usageErrorf("invalid header %q: expected \"name=value\"", trimmed)
		}
		headers[strings.TrimSpace(trimmed[:index])] = strings.TrimSpace(trimmed[index+1:])
	}
	return headers, nil
}

// resolveHeaders merges WEBHOOKY_HEADERS with repeated --header flags; the
// flags win.
func resolveHeaders(flags headerFlag) (map[string]string, error) {
	headers, err := parseHeaderList(os.Getenv(envHeaders))
	if err != nil {
		return nil, err
	}
	for _, entry := range flags {
		index := strings.Index(entry, "=")
		if index <= 0 {
			return nil, usageErrorf("invalid --header %q: expected \"name=value\"", entry)
		}
		headers[strings.TrimSpace(entry[:index])] = strings.TrimSpace(entry[index+1:])
	}
	return headers, nil
}

func resolveBaseURL(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if fromEnv := os.Getenv(envURL); fromEnv != "" {
		return fromEnv
	}
	return defaultBaseURL
}

func resolveTimeout(flagValue float64) (time.Duration, error) {
	if flagValue > 0 {
		return time.Duration(flagValue * float64(time.Second)), nil
	}
	raw := strings.TrimSpace(os.Getenv(envTimeout))
	if raw == "" {
		return webhooky.DefaultTimeout, nil
	}
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || seconds <= 0 {
		return 0, usageErrorf("%s must be a positive number of seconds", envTimeout)
	}
	return time.Duration(seconds * float64(time.Second)), nil
}

// fetchClient builds a read/stream client from flags and the environment.
func (g *globals) fetchClient() (*webhooky.Client, error) {
	headers, err := resolveHeaders(g.headers)
	if err != nil {
		return nil, err
	}
	timeout, err := resolveTimeout(g.timeout)
	if err != nil {
		return nil, err
	}

	key := os.Getenv(envAPIKey)
	secret := os.Getenv(envAPISecret)
	// The combined form exists because that is what the admin API hands out
	// when a fetch API user is created.
	if key == "" && secret == "" {
		if credential := os.Getenv(envCredential); credential != "" {
			parts := strings.SplitN(credential, ":", 2)
			if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
				return nil, usageErrorf("%s must be \"<keyId>:<secret>\"", envCredential)
			}
			key, secret = parts[0], parts[1]
		}
	}
	if key == "" || secret == "" {
		return nil, usageErrorf(
			"missing fetch credentials: set %s and %s, or %s=\"<keyId>:<secret>\"",
			envAPIKey, envAPISecret, envCredential)
	}

	return webhooky.NewClient(webhooky.Config{
		BaseURL:   resolveBaseURL(g.url),
		APIKey:    key,
		APISecret: secret,
		Timeout:   timeout,
		Headers:   headers,
		UserAgent: userAgent,
	})
}

// adminClient builds an admin client from flags and the environment.
//
// The credential may be absent: a deployment fronted by an identity-provider
// proxy authenticates through headers instead, which --header supplies.
func (g *globals) adminClient() (*webhooky.AdminClient, error) {
	headers, err := resolveHeaders(g.headers)
	if err != nil {
		return nil, err
	}
	timeout, err := resolveTimeout(g.timeout)
	if err != nil {
		return nil, err
	}

	credential := os.Getenv(envAdminCredential)
	if credential == "" {
		key := os.Getenv(envAdminKey)
		secret := os.Getenv(envAdminSecret)
		if key != "" && secret != "" {
			credential = key + ":" + secret
		}
	}
	if credential == "" && len(headers) == 0 {
		return nil, usageErrorf(
			"missing admin credentials: set %s=\"<keyId>:<secret>\" (or %s and %s), "+
				"or pass identity-provider headers with --header",
			envAdminCredential, envAdminKey, envAdminSecret)
	}

	return webhooky.NewAdminClient(webhooky.Config{
		BaseURL:    resolveBaseURL(g.url),
		Credential: credential,
		Timeout:    timeout,
		Headers:    headers,
		UserAgent:  userAgent,
	})
}

// resolveFetchUUID takes the flag, else the environment.
func resolveFetchUUID(flagValue string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	if fromEnv := os.Getenv(envFetchUUID); fromEnv != "" {
		return fromEnv, nil
	}
	return "", usageErrorf("missing destination: pass --fetch-uuid or set %s", envFetchUUID)
}
