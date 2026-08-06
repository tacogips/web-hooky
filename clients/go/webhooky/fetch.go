package webhooky

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client reads and streams records from one web-hooky server.
//
// It is safe for concurrent use.
type Client struct {
	transport *transport
	cfg       resolved
}

// NewClient builds a fetch client from an explicit configuration.
//
// BaseURL, APIKey and APISecret are required; everything else has a default.
func NewClient(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.APIKey) == "" || strings.TrimSpace(cfg.APISecret) == "" {
		return nil, ErrMissingFetchCredentials
	}
	rc, err := cfg.resolve(bearerFromPair(strings.TrimSpace(cfg.APIKey), cfg.APISecret))
	if err != nil {
		return nil, err
	}
	return &Client{transport: newTransport(rc, nil), cfg: rc}, nil
}

// NewClientWithHTTPClient is NewClient with a caller-supplied *http.Client, for
// custom transports, proxies or test doubles. The client's own Timeout is used
// as given; Config.Timeout is ignored.
func NewClientWithHTTPClient(cfg Config, httpClient *http.Client) (*Client, error) {
	client, err := NewClient(cfg)
	if err != nil {
		return nil, err
	}
	if httpClient != nil {
		client.transport = newTransport(client.cfg, httpClient)
	}
	return client, nil
}

// RecordQuery filters GET /_get/{fetchUuid}.
//
// The zero value asks for the server's defaults: every record, newest first,
// marked as fetched by this call.
type RecordQuery struct {
	// OnlyUnfetched returns only records no reader has taken yet.
	OnlyUnfetched bool
	// KeepUnfetched leaves the returned records unmarked (mark_fetched=false).
	//
	// Phrased as an opt-out because the server marks by default, so the zero
	// value of this struct matches the server's own default behaviour.
	KeepUnfetched bool
	// From and To bound the receipt time, inclusive. Zero means unbounded.
	From time.Time
	To   time.Time
	// Limit caps the number of records; 0 uses the server's default. The
	// server clamps anything above its configured ceiling.
	Limit int
}

func (q RecordQuery) values() url.Values {
	values := url.Values{}
	if q.OnlyUnfetched {
		values.Set("only_unfetched", "true")
	}
	if q.KeepUnfetched {
		values.Set("mark_fetched", "false")
	}
	if !q.From.IsZero() {
		values.Set("from", strconv.FormatInt(q.From.Unix(), 10))
	}
	if !q.To.IsZero() {
		values.Set("to", strconv.FormatInt(q.To.Unix(), 10))
	}
	if q.Limit > 0 {
		values.Set("limit", strconv.Itoa(q.Limit))
	}
	return values
}

type recordsResponse struct {
	Records []Record `json:"records"`
}

// Records reads stored records for a destination, newest first.
//
// Unless the query opts out, the server marks what it returns as fetched; the
// Fetched field on each record reflects the value from before that marking.
func (c *Client) Records(ctx context.Context, fetchUUID string, query RecordQuery) ([]Record, error) {
	response, err := decode[recordsResponse](ctx, c.transport, requestSpec{
		method: http.MethodGet,
		path:   "/_get/" + pathEscape(fetchUUID),
		query:  query.values(),
	})
	if err != nil {
		return nil, err
	}
	if response.Records == nil {
		return []Record{}, nil
	}
	return response.Records, nil
}
