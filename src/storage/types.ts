/**
 * Persisted entity shapes shared by every storage adapter implementation.
 */
import type { JsonObject, JsonValue } from "../core/json";

export enum AddonKind {
  Vendor = "vendor",
  Destination = "destination",
  Both = "both",
}

export enum AddonSource {
  Builtin = "builtin",
  Installed = "installed",
}

export enum AdminRole {
  Admin = "admin",
}

/** A configured webhook endpoint. */
export interface DestinationRecord {
  readonly id: string;
  readonly name: string;
  /** Vendor addon name; appears in the inbound URL. */
  readonly vendorAddon: string;
  /** Optional destination-level addon applied after the vendor addon. */
  readonly destinationAddon: string | null;
  /** UUID handed to the vendor: `/{vendorAddon}/{inboundUuid}`. */
  readonly inboundUuid: string;
  /** Secret UUID used by `/_get/` and `/_ws/`; admin-only. */
  readonly fetchUuid: string;
  readonly vendorConfig: JsonObject;
  readonly destinationConfig: JsonObject;
  /** Per-destination retention override in seconds; null uses the global value. */
  readonly retentionSeconds: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly createdBy: string | null;
}

/** A received webhook payload. */
export interface WebhookRecord {
  readonly id: string;
  readonly destinationId: string;
  /** Receipt time as unix seconds. */
  readonly t: number;
  readonly fetched: boolean;
  readonly payload: JsonValue;
}

/** The public projection returned by the fetch APIs. */
export interface PublicRecord {
  readonly t: number;
  readonly fetched: boolean;
  readonly payload: JsonValue;
}

/** A fetch-capable API user (key id + hashed secret). */
export interface ApiUserRecord {
  readonly id: string;
  readonly label: string;
  readonly secretHash: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** An admin-privileged API key. */
export interface AdminKeyRecord {
  readonly id: string;
  readonly label: string;
  readonly secretHash: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** An identity (IdP subject) allowed to use the admin surface. */
export interface AdminUserRecord {
  readonly subject: string;
  readonly role: AdminRole;
  readonly createdAt: number;
}

/** An addon package installed from an uploaded zip archive. */
export interface InstalledAddonRecord {
  readonly name: string;
  readonly version: string;
  readonly kind: AddonKind;
  readonly description: string;
  /** Entry module path relative to the addons directory. */
  readonly entryPath: string;
  readonly manifest: JsonObject;
  readonly installedAt: number;
  readonly installedBy: string | null;
}

/** Lifecycle of one relay delivery job. */
export enum RelayDeliveryStatus {
  Pending = "pending",
  Delivered = "delivered",
  Failed = "failed",
}

/**
 * A forwarding target attached to a destination.
 *
 * Every record accepted by the destination is queued for delivery to
 * `targetUrl`, signed with `secret` when one is configured, and retried with
 * exponential backoff up to `maxAttempts` times.
 */
export interface RelayRecord {
  readonly id: string;
  readonly destinationId: string;
  readonly name: string;
  readonly targetUrl: string;
  /** HMAC-SHA256 signing secret for outbound requests; null disables signing. */
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  /** Base delay of the exponential backoff, in seconds. */
  readonly backoffSeconds: number;
  readonly timeoutSeconds: number;
  readonly createdAt: number;
  readonly createdBy: string | null;
}

/**
 * One queued delivery of one record to one relay.
 *
 * The payload is snapshotted at enqueue time so retention deletion of the
 * source record cannot strand an undelivered job.
 */
export interface RelayDeliveryRecord {
  readonly id: string;
  readonly relayId: string;
  readonly destinationId: string;
  readonly recordId: string;
  /** Receipt time of the source record. */
  readonly t: number;
  readonly payload: JsonValue;
  readonly status: RelayDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deliveredAt: number | null;
}

/** Delivery counts per status for one relay. */
export interface RelayDeliveryStats {
  readonly pending: number;
  readonly delivered: number;
  readonly failed: number;
}

/** Query parameters accepted by the record store. */
export interface RecordQuery {
  readonly destinationId: string;
  readonly onlyUnfetched: boolean;
  readonly from: number | null;
  readonly to: number | null;
  readonly limit: number;
}

/** Converts a stored record into the public `{ t, fetched, payload }` shape. */
export function toPublicRecord(record: WebhookRecord): PublicRecord {
  return { t: record.t, fetched: record.fetched, payload: record.payload };
}
