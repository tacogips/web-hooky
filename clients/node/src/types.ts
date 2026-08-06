/**
 * The shapes the server returns and accepts.
 *
 * Field names match the wire format exactly, so a value can be passed straight
 * to `JSON.stringify` and read back by any other client.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** One stored webhook payload, as the fetch surfaces return it. */
export interface WebhookRecord {
  /** Receipt time in unix seconds. */
  readonly t: number;
  /**
   * The flag's value *before* the reading call marked it, so a consumer can
   * tell which records it is seeing for the first time.
   */
  readonly fetched: boolean;
  readonly payload: JsonValue;
}

/**
 * The admin projection of a configured webhook endpoint.
 *
 * `fetchUuid` is returned by the admin API only: it is the secret half of the
 * read and stream URLs.
 */
export interface Destination {
  readonly id: string;
  readonly name: string;
  readonly vendorAddon: string;
  readonly destinationAddon: string | null;
  readonly inboundUuid: string;
  readonly inboundPath: string;
  readonly fetchUuid: string;
  readonly fetchPath: string;
  readonly streamPath: string;
  readonly vendorConfig: JsonObject;
  readonly destinationConfig: JsonObject;
  readonly retentionSeconds: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly createdBy: string | null;
}

export interface CreateDestinationInput {
  readonly name: string;
  readonly vendorAddon: string;
  readonly destinationAddon?: string | null;
  readonly vendorConfig?: JsonObject;
  readonly destinationConfig?: JsonObject;
  readonly retentionSeconds?: number | null;
}

/**
 * A partial destination update.
 *
 * The server distinguishes an absent field (keep the current value) from an
 * explicit `null` (clear it), so an omitted key is never sent.
 */
export interface UpdateDestinationInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly destinationAddon?: string | null;
  readonly vendorConfig?: JsonObject;
  readonly destinationConfig?: JsonObject;
  readonly retentionSeconds?: number | null;
}

/** A fetch-capable API key and the destinations it may read. */
export interface ApiUser {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly grants: readonly string[];
}

/**
 * An API user plus the secret the server returns exactly once.
 *
 * A distinct type on purpose: a listing can never be mistaken for something
 * that carries a secret.
 */
export interface CreatedApiUser extends ApiUser {
  readonly secret: string;
  readonly credential: string;
}

export interface RelayDeliveryStats {
  readonly pending: number;
  readonly delivered: number;
  readonly failed: number;
}

/**
 * A forwarding target attached to a destination.
 *
 * The signing secret is never returned; `hasSecret` reports only whether one is
 * configured.
 */
export interface Relay {
  readonly id: string;
  readonly destinationId: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly hasSecret: boolean;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
  readonly timeoutSeconds: number;
  readonly createdAt: number;
  readonly createdBy: string | null;
  readonly deliveryStats?: RelayDeliveryStats;
}

export interface CreateRelayInput {
  readonly destinationId: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly secret?: string | null;
  readonly enabled?: boolean;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface UpdateRelayInput {
  readonly name?: string;
  readonly targetUrl?: string;
  readonly secret?: string | null;
  readonly enabled?: boolean;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  readonly timeoutSeconds?: number;
}

/** Lifecycle of one relay delivery job. */
export enum RelayDeliveryStatus {
  Pending = "pending",
  Delivered = "delivered",
  Failed = "failed",
}

/** One queued delivery of one record to one relay. */
export interface RelayDelivery {
  readonly id: string;
  readonly relayId: string;
  readonly recordId: string;
  readonly t: number;
  readonly status: RelayDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deliveredAt: number | null;
}

export interface RelayDeliveryPage {
  readonly deliveries: readonly RelayDelivery[];
  readonly stats: RelayDeliveryStats;
}

/** A registered vendor or destination addon. */
export interface Addon {
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly description: string;
  readonly source: string;
  readonly acceptsSchema: JsonValue;
  readonly returnsSchema: JsonValue;
  readonly configSchema: JsonValue;
  readonly hasAuthenticate: boolean;
  readonly hasTransform: boolean;
}

/** An admin-privileged API key. */
export interface AdminKey {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** An admin key plus the secret the server returns exactly once. */
export interface CreatedAdminKey extends AdminKey {
  readonly secret: string;
  readonly credential: string;
}

/** An identity-provider subject allowed into the admin surface. */
export interface AdminUser {
  readonly subject: string;
  readonly role: string;
  readonly createdAt: number;
}

/** The identity the server resolved for the caller's credentials. */
export interface AdminIdentity {
  readonly subject: string;
  readonly viaApiKey: boolean;
  readonly keyId: string | null;
  readonly adminAuthProvider: string;
}

/** Filters for `GET /_get/{fetchUuid}`. */
export interface RecordQuery {
  /** Return only records no reader has taken yet. Defaults to `false`. */
  readonly onlyUnfetched?: boolean;
  /**
   * Mark the returned records as fetched. Defaults to `true`, matching the
   * server.
   */
  readonly markFetched?: boolean;
  /** Lower time bound: unix seconds, an ISO-8601 string, or a `Date`. */
  readonly from?: number | string | Date;
  /** Upper time bound. */
  readonly to?: number | string | Date;
  /** Maximum records; the server clamps anything above its ceiling. */
  readonly limit?: number;
}
