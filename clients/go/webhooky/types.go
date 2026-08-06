package webhooky

import "encoding/json"

// Record is one stored webhook payload as the fetch surfaces return it.
type Record struct {
	// T is the receipt time in unix seconds.
	T int64 `json:"t"`
	// Fetched is the flag's value *before* the reading call marked it, so a
	// consumer can tell which records it is seeing for the first time.
	Fetched bool `json:"fetched"`
	// Payload is the stored body, after the addon pipeline.
	Payload json.RawMessage `json:"payload"`
}

// Destination is the admin projection of a configured webhook endpoint.
//
// FetchUUID and the paths derived from it are returned by the admin API only:
// anyone holding it, plus a granted API user, can read the destination's
// records.
type Destination struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	VendorAddon       string          `json:"vendorAddon"`
	DestinationAddon  *string         `json:"destinationAddon"`
	InboundUUID       string          `json:"inboundUuid"`
	InboundPath       string          `json:"inboundPath"`
	FetchUUID         string          `json:"fetchUuid"`
	FetchPath         string          `json:"fetchPath"`
	StreamPath        string          `json:"streamPath"`
	VendorConfig      json.RawMessage `json:"vendorConfig"`
	DestinationConfig json.RawMessage `json:"destinationConfig"`
	RetentionSeconds  *int64          `json:"retentionSeconds"`
	Enabled           bool            `json:"enabled"`
	CreatedAt         int64           `json:"createdAt"`
	CreatedBy         *string         `json:"createdBy"`
}

// CreateDestinationInput is the body of POST /_admin/api/destinations.
type CreateDestinationInput struct {
	Name              string          `json:"name"`
	VendorAddon       string          `json:"vendorAddon"`
	DestinationAddon  *string         `json:"destinationAddon,omitempty"`
	VendorConfig      json.RawMessage `json:"vendorConfig,omitempty"`
	DestinationConfig json.RawMessage `json:"destinationConfig,omitempty"`
	RetentionSeconds  *int64          `json:"retentionSeconds,omitempty"`
}

// UpdateDestinationInput is the body of PATCH /_admin/api/destinations/{id}.
//
// Every field is a pointer because the server distinguishes "absent" (keep the
// current value) from "present and null" (clear it): a nil field is omitted
// from the request entirely.
type UpdateDestinationInput struct {
	Name              *string         `json:"name,omitempty"`
	Enabled           *bool           `json:"enabled,omitempty"`
	DestinationAddon  *string         `json:"destinationAddon,omitempty"`
	VendorConfig      json.RawMessage `json:"vendorConfig,omitempty"`
	DestinationConfig json.RawMessage `json:"destinationConfig,omitempty"`
	RetentionSeconds  *int64          `json:"retentionSeconds,omitempty"`
}

// APIUser is a fetch-capable API key and the destinations it may read.
type APIUser struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Enabled   bool     `json:"enabled"`
	CreatedAt int64    `json:"createdAt"`
	Grants    []string `json:"grants"`
}

// CreatedAPIUser additionally carries the secret, which the server returns
// exactly once - at creation and at rotation. It is never listed again.
type CreatedAPIUser struct {
	APIUser
	Secret     string `json:"secret"`
	Credential string `json:"credential"`
}

// RelayDeliveryStats counts one relay's deliveries by status.
type RelayDeliveryStats struct {
	Pending   int64 `json:"pending"`
	Delivered int64 `json:"delivered"`
	Failed    int64 `json:"failed"`
}

// Relay is a forwarding target attached to a destination.
//
// The signing secret is never returned; HasSecret reports only whether one is
// configured. It can be replaced through an update but not read back.
type Relay struct {
	ID             string              `json:"id"`
	DestinationID  string              `json:"destinationId"`
	Name           string              `json:"name"`
	TargetURL      string              `json:"targetUrl"`
	HasSecret      bool                `json:"hasSecret"`
	Enabled        bool                `json:"enabled"`
	MaxAttempts    int64               `json:"maxAttempts"`
	BackoffSeconds int64               `json:"backoffSeconds"`
	TimeoutSeconds int64               `json:"timeoutSeconds"`
	CreatedAt      int64               `json:"createdAt"`
	CreatedBy      *string             `json:"createdBy"`
	DeliveryStats  *RelayDeliveryStats `json:"deliveryStats,omitempty"`
}

// CreateRelayInput is the body of POST /_admin/api/relays.
type CreateRelayInput struct {
	DestinationID  string  `json:"destinationId"`
	Name           string  `json:"name"`
	TargetURL      string  `json:"targetUrl"`
	Secret         *string `json:"secret,omitempty"`
	Enabled        *bool   `json:"enabled,omitempty"`
	MaxAttempts    *int64  `json:"maxAttempts,omitempty"`
	BackoffSeconds *int64  `json:"backoffSeconds,omitempty"`
	TimeoutSeconds *int64  `json:"timeoutSeconds,omitempty"`
}

// UpdateRelayInput is the body of PATCH /_admin/api/relays/{id}.
type UpdateRelayInput struct {
	Name           *string `json:"name,omitempty"`
	TargetURL      *string `json:"targetUrl,omitempty"`
	Secret         *string `json:"secret,omitempty"`
	Enabled        *bool   `json:"enabled,omitempty"`
	MaxAttempts    *int64  `json:"maxAttempts,omitempty"`
	BackoffSeconds *int64  `json:"backoffSeconds,omitempty"`
	TimeoutSeconds *int64  `json:"timeoutSeconds,omitempty"`
}

// RelayDeliveryStatus is the lifecycle state of one delivery job.
type RelayDeliveryStatus string

const (
	DeliveryPending   RelayDeliveryStatus = "pending"
	DeliveryDelivered RelayDeliveryStatus = "delivered"
	DeliveryFailed    RelayDeliveryStatus = "failed"
)

// RelayDelivery is one queued delivery of one record to one relay.
type RelayDelivery struct {
	ID             string              `json:"id"`
	RelayID        string              `json:"relayId"`
	RecordID       string              `json:"recordId"`
	T              int64               `json:"t"`
	Status         RelayDeliveryStatus `json:"status"`
	Attempts       int64               `json:"attempts"`
	NextAttemptAt  int64               `json:"nextAttemptAt"`
	LastStatusCode *int64              `json:"lastStatusCode"`
	LastError      *string             `json:"lastError"`
	CreatedAt      int64               `json:"createdAt"`
	UpdatedAt      int64               `json:"updatedAt"`
	DeliveredAt    *int64              `json:"deliveredAt"`
}

// RelayDeliveryPage is the result of listing a relay's deliveries.
type RelayDeliveryPage struct {
	Deliveries []RelayDelivery    `json:"deliveries"`
	Stats      RelayDeliveryStats `json:"stats"`
}

// Addon is a registered vendor or destination addon.
type Addon struct {
	Name            string          `json:"name"`
	Version         string          `json:"version"`
	Kind            string          `json:"kind"`
	Description     string          `json:"description"`
	Source          string          `json:"source"`
	AcceptsSchema   json.RawMessage `json:"acceptsSchema"`
	ReturnsSchema   json.RawMessage `json:"returnsSchema"`
	ConfigSchema    json.RawMessage `json:"configSchema"`
	HasAuthenticate bool            `json:"hasAuthenticate"`
	HasTransform    bool            `json:"hasTransform"`
}

// AdminKey is an admin-privileged API key.
type AdminKey struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Enabled   bool   `json:"enabled"`
	CreatedAt int64  `json:"createdAt"`
}

// CreatedAdminKey additionally carries the secret, returned exactly once.
type CreatedAdminKey struct {
	AdminKey
	Secret     string `json:"secret"`
	Credential string `json:"credential"`
}

// AdminUser is an identity-provider subject allowed into the admin surface.
type AdminUser struct {
	Subject   string `json:"subject"`
	Role      string `json:"role"`
	CreatedAt int64  `json:"createdAt"`
}

// AdminIdentity is the caller's own identity, from GET /_admin/api/me.
type AdminIdentity struct {
	Subject           string  `json:"subject"`
	ViaAPIKey         bool    `json:"viaApiKey"`
	KeyID             *string `json:"keyId"`
	AdminAuthProvider string  `json:"adminAuthProvider"`
}

// RequeueResult reports how many failed deliveries a retry call requeued.
type RequeueResult struct {
	Requeued int64 `json:"requeued"`
}
