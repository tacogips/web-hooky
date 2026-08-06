package webhooky

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
)

// AdminClient drives /_admin/api.
//
// It is safe for concurrent use. An admin API key grants every admin
// capability, including reading destination fetch UUIDs, so treat a configured
// AdminClient as a full-privilege handle.
type AdminClient struct {
	transport *transport
	cfg       resolved
}

// NewAdminClient builds an admin client from an explicit configuration.
//
// Credential is "<keyId>:<secret>". It may be empty when the deployment
// authenticates through an identity-provider proxy and Headers carry the
// identity header (and, when configured, the proxy shared secret).
func NewAdminClient(cfg Config) (*AdminClient, error) {
	auth := ""
	if credential := strings.TrimSpace(cfg.Credential); credential != "" {
		if _, _, ok := splitCredential(credential); !ok {
			return nil, &Error{Message: `webhooky: Credential must be "<keyId>:<secret>"`}
		}
		auth = "Bearer " + credential
	}
	rc, err := cfg.resolve(auth)
	if err != nil {
		return nil, err
	}
	return &AdminClient{transport: newTransport(rc, nil), cfg: rc}, nil
}

// NewAdminClientWithHTTPClient is NewAdminClient with a caller-supplied
// *http.Client.
func NewAdminClientWithHTTPClient(cfg Config, httpClient *http.Client) (*AdminClient, error) {
	client, err := NewAdminClient(cfg)
	if err != nil {
		return nil, err
	}
	if httpClient != nil {
		client.transport = newTransport(client.cfg, httpClient)
	}
	return client, nil
}

const adminBase = "/_admin/api"

// Me returns the identity the server resolved for this client's credentials.
func (a *AdminClient) Me(ctx context.Context) (AdminIdentity, error) {
	return decode[AdminIdentity](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/me",
	})
}

// -- destinations ------------------------------------------------------------

type destinationListResponse struct {
	Destinations []Destination `json:"destinations"`
}

// ListDestinations returns every configured destination.
func (a *AdminClient) ListDestinations(ctx context.Context) ([]Destination, error) {
	response, err := decode[destinationListResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/destinations",
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.Destinations), nil
}

// GetDestination returns one destination by id.
func (a *AdminClient) GetDestination(ctx context.Context, id string) (Destination, error) {
	return decode[Destination](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/destinations/" + pathEscape(id),
	})
}

// CreateDestination registers a new destination and returns it, including the
// inbound UUID to hand to the vendor and the fetch UUID for consumers.
func (a *AdminClient) CreateDestination(ctx context.Context, input CreateDestinationInput) (Destination, error) {
	return decode[Destination](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/destinations",
		body:   input,
	})
}

// UpdateDestination applies a partial update. Fields left nil are untouched.
func (a *AdminClient) UpdateDestination(ctx context.Context, id string, input UpdateDestinationInput) (Destination, error) {
	return decode[Destination](ctx, a.transport, requestSpec{
		method: http.MethodPatch,
		path:   adminBase + "/destinations/" + pathEscape(id),
		body:   input,
	})
}

// DeleteDestination removes a destination and every record stored for it.
func (a *AdminClient) DeleteDestination(ctx context.Context, id string) error {
	return a.transport.send(ctx, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/destinations/" + pathEscape(id),
	})
}

// RotateFetchUUID issues a new fetch UUID, invalidating the old /_get/ and
// /_ws/ URLs and closing the sockets they authorized.
func (a *AdminClient) RotateFetchUUID(ctx context.Context, id string) (Destination, error) {
	return decode[Destination](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/destinations/" + pathEscape(id) + "/rotate-fetch-uuid",
	})
}

// ListDestinationRecords reads stored records for administration.
//
// Unlike the consumer fetch API this never marks records as fetched, and it
// works even for a disabled destination. limit 0 uses the server default.
func (a *AdminClient) ListDestinationRecords(ctx context.Context, destinationID string, limit int) ([]Record, error) {
	query := url.Values{}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	response, err := decode[recordsResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/records/" + pathEscape(destinationID),
		query:  query,
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.Records), nil
}

// -- relays ------------------------------------------------------------------

type relayListResponse struct {
	Relays []Relay `json:"relays"`
}

// ListRelays returns relays, optionally narrowed to one destination. Pass an
// empty destinationID for all of them.
func (a *AdminClient) ListRelays(ctx context.Context, destinationID string) ([]Relay, error) {
	query := url.Values{}
	if destinationID != "" {
		query.Set("destinationId", destinationID)
	}
	response, err := decode[relayListResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/relays",
		query:  query,
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.Relays), nil
}

// GetRelay returns one relay with its delivery statistics.
func (a *AdminClient) GetRelay(ctx context.Context, id string) (Relay, error) {
	return decode[Relay](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/relays/" + pathEscape(id),
	})
}

// CreateRelay attaches a forwarding target to a destination.
func (a *AdminClient) CreateRelay(ctx context.Context, input CreateRelayInput) (Relay, error) {
	return decode[Relay](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/relays",
		body:   input,
	})
}

// UpdateRelay applies a partial update. A Secret pointing at an empty string
// clears the signing secret; a nil Secret keeps the current one.
func (a *AdminClient) UpdateRelay(ctx context.Context, id string, input UpdateRelayInput) (Relay, error) {
	return decode[Relay](ctx, a.transport, requestSpec{
		method: http.MethodPatch,
		path:   adminBase + "/relays/" + pathEscape(id),
		body:   input,
	})
}

// DeleteRelay removes a relay.
func (a *AdminClient) DeleteRelay(ctx context.Context, id string) error {
	return a.transport.send(ctx, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/relays/" + pathEscape(id),
	})
}

// ListRelayDeliveries returns recent deliveries and the relay's totals.
func (a *AdminClient) ListRelayDeliveries(ctx context.Context, id string, limit int) (RelayDeliveryPage, error) {
	query := url.Values{}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	page, err := decode[RelayDeliveryPage](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/relays/" + pathEscape(id) + "/deliveries",
		query:  query,
	})
	if err != nil {
		return RelayDeliveryPage{}, err
	}
	page.Deliveries = orEmpty(page.Deliveries)
	return page, nil
}

// RetryRelay requeues this relay's failed deliveries.
func (a *AdminClient) RetryRelay(ctx context.Context, id string) (RequeueResult, error) {
	return decode[RequeueResult](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/relays/" + pathEscape(id) + "/retry",
	})
}

// -- fetch API users ---------------------------------------------------------

type apiUserListResponse struct {
	Users []APIUser `json:"users"`
}

// ListAPIUsers returns every fetch API user with its grants.
func (a *AdminClient) ListAPIUsers(ctx context.Context) ([]APIUser, error) {
	response, err := decode[apiUserListResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/users",
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.Users), nil
}

// GetAPIUser returns one fetch API user.
func (a *AdminClient) GetAPIUser(ctx context.Context, id string) (APIUser, error) {
	return decode[APIUser](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/users/" + pathEscape(id),
	})
}

// CreateAPIUser mints a key/secret pair. The secret is returned exactly once,
// here; it cannot be read back afterwards.
func (a *AdminClient) CreateAPIUser(ctx context.Context, label string) (CreatedAPIUser, error) {
	return decode[CreatedAPIUser](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/users",
		body:   map[string]string{"label": label},
	})
}

// RotateAPIUserSecret issues a new secret and invalidates the previous one,
// closing the streams it authorized.
func (a *AdminClient) RotateAPIUserSecret(ctx context.Context, id string) (CreatedAPIUser, error) {
	return decode[CreatedAPIUser](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/users/" + pathEscape(id) + "/rotate",
	})
}

// SetAPIUserEnabled enables or disables a fetch API user.
func (a *AdminClient) SetAPIUserEnabled(ctx context.Context, id string, enabled bool) (APIUser, error) {
	return decode[APIUser](ctx, a.transport, requestSpec{
		method: http.MethodPatch,
		path:   adminBase + "/users/" + pathEscape(id),
		body:   map[string]bool{"enabled": enabled},
	})
}

// DeleteAPIUser removes a fetch API user and its grants.
func (a *AdminClient) DeleteAPIUser(ctx context.Context, id string) error {
	return a.transport.send(ctx, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/users/" + pathEscape(id),
	})
}

// GrantDestination authorizes a fetch API user to read a destination.
func (a *AdminClient) GrantDestination(ctx context.Context, userID, destinationID string) (APIUser, error) {
	return decode[APIUser](ctx, a.transport, requestSpec{
		method: http.MethodPut,
		path:   adminBase + "/users/" + pathEscape(userID) + "/grants/" + pathEscape(destinationID),
	})
}

// RevokeDestination withdraws a grant and closes the streams it authorized.
func (a *AdminClient) RevokeDestination(ctx context.Context, userID, destinationID string) (APIUser, error) {
	return decode[APIUser](ctx, a.transport, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/users/" + pathEscape(userID) + "/grants/" + pathEscape(destinationID),
	})
}

// -- addons ------------------------------------------------------------------

type addonListResponse struct {
	Addons []Addon `json:"addons"`
}

// ListAddons returns every registered addon, built-in and installed.
func (a *AdminClient) ListAddons(ctx context.Context) ([]Addon, error) {
	response, err := decode[addonListResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/addons",
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.Addons), nil
}

// GetAddon returns one addon by name.
func (a *AdminClient) GetAddon(ctx context.Context, name string) (Addon, error) {
	return decode[Addon](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/addons/" + pathEscape(name),
	})
}

// UploadAddon installs an addon package (a zip archive with addon.json at its
// root).
//
// Uploaded addon code is imported into the server process and therefore fully
// trusted. Deployments without a writable filesystem answer 501.
func (a *AdminClient) UploadAddon(ctx context.Context, fileName string, archive []byte) (Addon, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	header := make(textproto.MIMEHeader)
	header.Set("content-disposition",
		`form-data; name="package"; filename="`+escapeQuotes(fileName)+`"`)
	header.Set("content-type", "application/zip")
	part, err := writer.CreatePart(header)
	if err != nil {
		return Addon{}, &Error{Message: "failed to build upload: " + err.Error(), Err: err}
	}
	if _, err := part.Write(archive); err != nil {
		return Addon{}, &Error{Message: "failed to build upload: " + err.Error(), Err: err}
	}
	if err := writer.Close(); err != nil {
		return Addon{}, &Error{Message: "failed to build upload: " + err.Error(), Err: err}
	}

	// Multipart cannot use the JSON content type that satisfies the server's
	// CSRF rule, so this request carries a matching Origin instead.
	return decode[Addon](ctx, a.transport, requestSpec{
		method:      http.MethodPost,
		path:        adminBase + "/addons",
		rawBody:     buffer.Bytes(),
		contentType: writer.FormDataContentType(),
		sendOrigin:  true,
	})
}

// DeleteAddon removes an installed addon. Built-in addons cannot be removed,
// and an addon still used by a destination is refused.
func (a *AdminClient) DeleteAddon(ctx context.Context, name string) error {
	return a.transport.send(ctx, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/addons/" + pathEscape(name),
	})
}

// -- admin keys and admin users ----------------------------------------------

type adminKeyListResponse struct {
	Keys []AdminKey `json:"keys"`
}

// ListAdminKeys returns every admin API key, without secrets.
func (a *AdminClient) ListAdminKeys(ctx context.Context) ([]AdminKey, error) {
	response, err := decode[adminKeyListResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/admin-keys",
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.Keys), nil
}

// CreateAdminKey mints an admin API key. The secret is returned exactly once.
// The new key carries the same privileges as the one that created it.
func (a *AdminClient) CreateAdminKey(ctx context.Context, label string) (CreatedAdminKey, error) {
	return decode[CreatedAdminKey](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/admin-keys",
		body:   map[string]string{"label": label},
	})
}

// DeleteAdminKey revokes an admin API key.
func (a *AdminClient) DeleteAdminKey(ctx context.Context, id string) error {
	return a.transport.send(ctx, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/admin-keys/" + pathEscape(id),
	})
}

type adminUserListResponse struct {
	AdminUsers []AdminUser `json:"adminUsers"`
}

// ListAdminUsers returns the identity-provider subjects allowed into the admin
// surface.
func (a *AdminClient) ListAdminUsers(ctx context.Context) ([]AdminUser, error) {
	response, err := decode[adminUserListResponse](ctx, a.transport, requestSpec{
		method: http.MethodGet,
		path:   adminBase + "/admin-users",
	})
	if err != nil {
		return nil, err
	}
	return orEmpty(response.AdminUsers), nil
}

// CreateAdminUser admits an identity-provider subject.
func (a *AdminClient) CreateAdminUser(ctx context.Context, subject string) (AdminUser, error) {
	return decode[AdminUser](ctx, a.transport, requestSpec{
		method: http.MethodPost,
		path:   adminBase + "/admin-users",
		body:   map[string]string{"subject": subject},
	})
}

// DeleteAdminUser removes an identity-provider subject.
func (a *AdminClient) DeleteAdminUser(ctx context.Context, subject string) error {
	return a.transport.send(ctx, requestSpec{
		method: http.MethodDelete,
		path:   adminBase + "/admin-users/" + pathEscape(subject),
	})
}

// orEmpty replaces a nil slice with an empty one, so a caller marshalling the
// result gets [] rather than null.
func orEmpty[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

func escapeQuotes(value string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value)
}
