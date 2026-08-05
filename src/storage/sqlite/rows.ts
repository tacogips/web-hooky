/**
 * Row shapes returned by the SQL driver and their mappers to domain records.
 */
import { isJsonObject, type JsonObject, parseJsonText } from "../../core/json";
import { intToBool } from "../sql-driver";
import {
  AddonKind,
  AdminRole,
  RelayDeliveryStatus,
  type AdminKeyRecord,
  type AdminUserRecord,
  type ApiUserRecord,
  type DestinationRecord,
  type InstalledAddonRecord,
  type RelayDeliveryRecord,
  type RelayRecord,
  type WebhookRecord,
} from "../types";

export interface DestinationRow {
  readonly id: string;
  readonly name: string;
  readonly vendor_addon: string;
  readonly destination_addon: string | null;
  readonly inbound_uuid: string;
  readonly fetch_uuid: string;
  readonly vendor_config: string;
  readonly destination_config: string;
  readonly retention_seconds: number | null;
  readonly enabled: number;
  readonly created_at: number;
  readonly created_by: string | null;
}

export interface RecordRow {
  readonly id: string;
  readonly destination_id: string;
  readonly t: number;
  readonly fetched: number;
  readonly payload: string;
}

export interface ApiUserRow {
  readonly id: string;
  readonly label: string;
  readonly secret_hash: string;
  readonly enabled: number;
  readonly created_at: number;
}

export type AdminKeyRow = ApiUserRow;

export interface AdminUserRow {
  readonly subject: string;
  readonly role: string;
  readonly created_at: number;
}

export interface InstalledAddonRow {
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly description: string;
  readonly entry_path: string;
  readonly manifest: string;
  readonly installed_at: number;
  readonly installed_by: string | null;
}

export interface RelayRow {
  readonly id: string;
  readonly destination_id: string;
  readonly name: string;
  readonly target_url: string;
  readonly secret: string | null;
  readonly enabled: number;
  readonly max_attempts: number;
  readonly backoff_seconds: number;
  readonly timeout_seconds: number;
  readonly created_at: number;
  readonly created_by: string | null;
}

export interface RelayDeliveryRow {
  readonly id: string;
  readonly relay_id: string;
  readonly destination_id: string;
  readonly record_id: string;
  readonly t: number;
  readonly payload: string;
  readonly status: string;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly last_status_code: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly delivered_at: number | null;
}

export interface CountRow {
  readonly count: number;
}

export interface StatusCountRow {
  readonly status: string;
  readonly count: number;
}

/** Parses a JSON text column into an object, falling back to `{}`. */
export function parseObjectColumn(text: string): JsonObject {
  const parsed = parseJsonText(text);
  if (parsed.ok === false || isJsonObject(parsed.value) === false) {
    return {};
  }
  return parsed.value;
}

export function toDestination(row: DestinationRow): DestinationRecord {
  return {
    id: row.id,
    name: row.name,
    vendorAddon: row.vendor_addon,
    destinationAddon: row.destination_addon,
    inboundUuid: row.inbound_uuid,
    fetchUuid: row.fetch_uuid,
    vendorConfig: parseObjectColumn(row.vendor_config),
    destinationConfig: parseObjectColumn(row.destination_config),
    retentionSeconds: row.retention_seconds,
    enabled: intToBool(row.enabled),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function toWebhookRecord(row: RecordRow): WebhookRecord {
  const parsed = parseJsonText(row.payload);
  return {
    id: row.id,
    destinationId: row.destination_id,
    t: row.t,
    fetched: intToBool(row.fetched),
    payload: parsed.ok ? parsed.value : null,
  };
}

export function toApiUser(row: ApiUserRow): ApiUserRecord {
  return {
    id: row.id,
    label: row.label,
    secretHash: row.secret_hash,
    enabled: intToBool(row.enabled),
    createdAt: row.created_at,
  };
}

export function toAdminKey(row: AdminKeyRow): AdminKeyRecord {
  return toApiUser(row);
}

export function toAdminUser(row: AdminUserRow): AdminUserRecord {
  // `admin` is currently the only role; unknown values are normalised to it so
  // a hand-edited database cannot produce an unrepresentable record.
  return {
    subject: row.subject,
    role: AdminRole.Admin,
    createdAt: row.created_at,
  };
}

export function toInstalledAddon(row: InstalledAddonRow): InstalledAddonRecord {
  return {
    name: row.name,
    version: row.version,
    kind: parseAddonKind(row.kind),
    description: row.description,
    entryPath: row.entry_path,
    manifest: parseObjectColumn(row.manifest),
    installedAt: row.installed_at,
    installedBy: row.installed_by,
  };
}

export function toRelay(row: RelayRow): RelayRecord {
  return {
    id: row.id,
    destinationId: row.destination_id,
    name: row.name,
    targetUrl: row.target_url,
    secret: row.secret,
    enabled: intToBool(row.enabled),
    maxAttempts: row.max_attempts,
    backoffSeconds: row.backoff_seconds,
    timeoutSeconds: row.timeout_seconds,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function toRelayDelivery(row: RelayDeliveryRow): RelayDeliveryRecord {
  const parsed = parseJsonText(row.payload);
  return {
    id: row.id,
    relayId: row.relay_id,
    destinationId: row.destination_id,
    recordId: row.record_id,
    t: row.t,
    payload: parsed.ok ? parsed.value : null,
    status: parseRelayDeliveryStatus(row.status),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

/** Unknown values are normalised to `failed` so they are never re-attempted. */
export function parseRelayDeliveryStatus(value: string): RelayDeliveryStatus {
  switch (value) {
    case RelayDeliveryStatus.Pending:
      return RelayDeliveryStatus.Pending;
    case RelayDeliveryStatus.Delivered:
      return RelayDeliveryStatus.Delivered;
    default:
      return RelayDeliveryStatus.Failed;
  }
}

function parseAddonKind(value: string): AddonKind {
  switch (value) {
    case AddonKind.Vendor:
      return AddonKind.Vendor;
    case AddonKind.Destination:
      return AddonKind.Destination;
    default:
      return AddonKind.Both;
  }
}
