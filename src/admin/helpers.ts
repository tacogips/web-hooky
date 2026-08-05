/**
 * Shared request/response helpers for the admin API handlers.
 */
import { type AppError, errors } from "../core/errors";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "../core/json";
import { err, ok, type Result } from "../core/result";
import type {
  AdminKeyRecord,
  AdminUserRecord,
  ApiUserRecord,
  DestinationRecord,
  InstalledAddonRecord,
  PublicRecord,
  RelayDeliveryRecord,
  RelayDeliveryStats,
  RelayRecord,
} from "../storage/types";
import type { LoadedAddon } from "../addons/types";

/** Reads and parses a JSON request body into an object. */
export async function readJsonObjectBody(
  request: Request,
): Promise<Result<JsonObject, AppError>> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return ok({});
  }
  const parsed = parseJsonText(text);
  if (parsed.ok === false) {
    return err(
      errors.badRequest(`Request body is not valid JSON: ${parsed.error}`),
    );
  }
  if (isJsonObject(parsed.value) === false) {
    return err(errors.badRequest("Request body must be a JSON object"));
  }
  return ok(parsed.value);
}

/** Requires a non-empty string field. */
export function requireStringField(
  body: JsonObject,
  field: string,
): Result<string, AppError> {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return err(
      errors.badRequest(`Field "${field}" must be a non-empty string`),
    );
  }
  return ok(value.trim());
}

/** Reads an optional string field; `null` when absent or explicitly null. */
export function optionalStringField(
  body: JsonObject,
  field: string,
): Result<string | null, AppError> {
  const value = body[field];
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (typeof value !== "string") {
    return err(errors.badRequest(`Field "${field}" must be a string`));
  }
  const trimmed = value.trim();
  return ok(trimmed.length === 0 ? null : trimmed);
}

/** Reads an optional object field, defaulting to `{}`. */
export function optionalObjectField(
  body: JsonObject,
  field: string,
): Result<JsonObject, AppError> {
  const value = body[field];
  if (value === undefined || value === null) {
    return ok({});
  }
  if (isJsonObject(value) === false) {
    return err(errors.badRequest(`Field "${field}" must be an object`));
  }
  return ok(value);
}

/** Reads an optional positive integer field. */
export function optionalIntegerField(
  body: JsonObject,
  field: string,
): Result<number | null, AppError> {
  const value = body[field];
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (typeof value !== "number" || Number.isInteger(value) === false) {
    return err(errors.badRequest(`Field "${field}" must be an integer`));
  }
  return ok(value);
}

/** Reads an optional boolean field. */
export function optionalBooleanField(
  body: JsonObject,
  field: string,
): Result<boolean | null, AppError> {
  const value = body[field];
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (typeof value !== "boolean") {
    return err(errors.badRequest(`Field "${field}" must be a boolean`));
  }
  return ok(value);
}

/**
 * Admin projection of a destination.
 *
 * The fetch UUID is included here and nowhere else: only the destination
 * administrator may learn it.
 */
export function destinationToJson(destination: DestinationRecord): JsonObject {
  return {
    id: destination.id,
    name: destination.name,
    vendorAddon: destination.vendorAddon,
    destinationAddon: destination.destinationAddon,
    inboundUuid: destination.inboundUuid,
    inboundPath: `/${destination.vendorAddon}/${destination.inboundUuid}`,
    fetchUuid: destination.fetchUuid,
    fetchPath: `/_get/${destination.fetchUuid}`,
    streamPath: `/_ws/${destination.fetchUuid}`,
    vendorConfig: destination.vendorConfig,
    destinationConfig: destination.destinationConfig,
    retentionSeconds: destination.retentionSeconds,
    enabled: destination.enabled,
    createdAt: destination.createdAt,
    createdBy: destination.createdBy,
  };
}

export function apiUserToJson(
  user: ApiUserRecord,
  grants: readonly string[],
): JsonObject {
  return {
    id: user.id,
    label: user.label,
    enabled: user.enabled,
    createdAt: user.createdAt,
    grants: [...grants],
  };
}

export function adminKeyToJson(key: AdminKeyRecord): JsonObject {
  return {
    id: key.id,
    label: key.label,
    enabled: key.enabled,
    createdAt: key.createdAt,
  };
}

export function adminUserToJson(user: AdminUserRecord): JsonObject {
  return {
    subject: user.subject,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export function loadedAddonToJson(addon: LoadedAddon): JsonObject {
  return {
    name: addon.manifest.name,
    version: addon.manifest.version,
    kind: addon.manifest.kind,
    description: addon.manifest.description,
    source: addon.source,
    acceptsSchema: addon.manifest.acceptsSchema,
    returnsSchema: addon.manifest.returnsSchema,
    configSchema: addon.manifest.configSchema,
    hasAuthenticate: addon.module.authenticate !== undefined,
    hasTransform: addon.module.transform !== undefined,
  };
}

export function installedAddonToJson(record: InstalledAddonRecord): JsonObject {
  return {
    name: record.name,
    version: record.version,
    kind: record.kind,
    description: record.description,
    installedAt: record.installedAt,
    installedBy: record.installedBy,
  };
}

/**
 * Admin projection of a relay.
 *
 * The signing secret is never returned; only whether one is configured. It can
 * be replaced through PATCH but not read back.
 */
export function relayToJson(
  relay: RelayRecord,
  stats: RelayDeliveryStats | null = null,
): JsonObject {
  const base: JsonObject = {
    id: relay.id,
    destinationId: relay.destinationId,
    name: relay.name,
    targetUrl: relay.targetUrl,
    hasSecret: relay.secret !== null,
    enabled: relay.enabled,
    maxAttempts: relay.maxAttempts,
    backoffSeconds: relay.backoffSeconds,
    timeoutSeconds: relay.timeoutSeconds,
    createdAt: relay.createdAt,
    createdBy: relay.createdBy,
  };
  if (stats === null) {
    return base;
  }
  return {
    ...base,
    deliveryStats: {
      pending: stats.pending,
      delivered: stats.delivered,
      failed: stats.failed,
    },
  };
}

export function relayDeliveryToJson(delivery: RelayDeliveryRecord): JsonObject {
  return {
    id: delivery.id,
    relayId: delivery.relayId,
    recordId: delivery.recordId,
    t: delivery.t,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    deliveredAt: delivery.deliveredAt,
  };
}

export function publicRecordToJson(record: PublicRecord): JsonValue {
  return { t: record.t, fetched: record.fetched, payload: record.payload };
}
