/**
 * Admin API handlers for relays (webhook forwarding) and their deliveries.
 */
import { type AppError, errors } from "../core/errors";
import { newUuid } from "../core/ids";
import type { JsonObject } from "../core/json";
import { err, ok, type Result } from "../core/result";
import type { AppContext } from "../server/context";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
} from "../server/responses";
import type { RelayRecord } from "../storage/types";
import type { AdminPrincipal } from "./auth";
import {
  optionalBooleanField,
  optionalIntegerField,
  optionalStringField,
  readJsonObjectBody,
  relayDeliveryToJson,
  relayToJson,
  requireStringField,
} from "./helpers";

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Relay targets are chosen by administrators, so only the scheme is
 * constrained: everything else (including internal addresses) is a deliberate
 * operator decision.
 */
function parseTargetUrl(raw: string): Result<string, AppError> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return err(errors.badRequest(`Field "targetUrl" is not a valid URL`));
  }
  if (ALLOWED_PROTOCOLS.has(parsed.protocol) === false) {
    return err(
      errors.badRequest('Field "targetUrl" must use http:// or https://'),
    );
  }
  return ok(parsed.toString());
}

function positiveInteger(
  body: JsonObject,
  field: string,
  fallback: number,
): Result<number, AppError> {
  const value = optionalIntegerField(body, field);
  if (value.ok === false) {
    return err(value.error);
  }
  if (value.value === null) {
    return ok(fallback);
  }
  if (value.value < 1) {
    return err(errors.badRequest(`Field "${field}" must be at least 1`));
  }
  return ok(value.value);
}

/**
 * A request that outlives the delivery lease would let a second worker claim a
 * delivery whose attempt is still open, duplicating the outbound POST.
 */
function checkTimeoutAgainstLease(
  ctx: AppContext,
  timeoutSeconds: number,
): Result<null, AppError> {
  const lease = ctx.config.relay.leaseSeconds;
  if (timeoutSeconds >= lease) {
    return err(
      errors.badRequest(
        `Field "timeoutSeconds" must be below the delivery lease of ${lease}s ` +
          "(WEBHOOKY_RELAY_LEASE_SECONDS)",
      ),
    );
  }
  return ok(null);
}

async function createRelay(
  ctx: AppContext,
  request: Request,
  principal: AdminPrincipal,
): Promise<Response> {
  const body = await readJsonObjectBody(request);
  if (body.ok === false) {
    return errorResponse(body.error);
  }

  const destinationId = requireStringField(body.value, "destinationId");
  if (destinationId.ok === false) {
    return errorResponse(destinationId.error);
  }
  const destination = await ctx.persistence.destinations.findById(
    destinationId.value,
  );
  if (destination === null) {
    return errorResponse(errors.notFound("Unknown destination"));
  }

  const name = requireStringField(body.value, "name");
  if (name.ok === false) {
    return errorResponse(name.error);
  }
  const rawTarget = requireStringField(body.value, "targetUrl");
  if (rawTarget.ok === false) {
    return errorResponse(rawTarget.error);
  }
  const targetUrl = parseTargetUrl(rawTarget.value);
  if (targetUrl.ok === false) {
    return errorResponse(targetUrl.error);
  }
  const secret = optionalStringField(body.value, "secret");
  if (secret.ok === false) {
    return errorResponse(secret.error);
  }
  const enabled = optionalBooleanField(body.value, "enabled");
  if (enabled.ok === false) {
    return errorResponse(enabled.error);
  }

  const defaults = ctx.config.relay;
  const maxAttempts = positiveInteger(
    body.value,
    "maxAttempts",
    defaults.defaultMaxAttempts,
  );
  if (maxAttempts.ok === false) {
    return errorResponse(maxAttempts.error);
  }
  const backoffSeconds = positiveInteger(
    body.value,
    "backoffSeconds",
    defaults.defaultBackoffSeconds,
  );
  if (backoffSeconds.ok === false) {
    return errorResponse(backoffSeconds.error);
  }
  const timeoutSeconds = positiveInteger(
    body.value,
    "timeoutSeconds",
    defaults.defaultTimeoutSeconds,
  );
  if (timeoutSeconds.ok === false) {
    return errorResponse(timeoutSeconds.error);
  }
  const timeoutAllowed = checkTimeoutAgainstLease(ctx, timeoutSeconds.value);
  if (timeoutAllowed.ok === false) {
    return errorResponse(timeoutAllowed.error);
  }

  const relay: RelayRecord = {
    id: newUuid(),
    destinationId: destination.id,
    name: name.value,
    targetUrl: targetUrl.value,
    secret: secret.value,
    enabled: enabled.value ?? true,
    maxAttempts: maxAttempts.value,
    backoffSeconds: backoffSeconds.value,
    timeoutSeconds: timeoutSeconds.value,
    createdAt: ctx.clock.nowSeconds(),
    createdBy: principal.subject,
  };
  await ctx.persistence.relays.create(relay);
  return jsonResponse(relayToJson(relay), 201);
}

async function patchRelay(
  ctx: AppContext,
  request: Request,
  existing: RelayRecord,
): Promise<Response> {
  const body = await readJsonObjectBody(request);
  if (body.ok === false) {
    return errorResponse(body.error);
  }

  const name = optionalStringField(body.value, "name");
  if (name.ok === false) {
    return errorResponse(name.error);
  }
  const enabled = optionalBooleanField(body.value, "enabled");
  if (enabled.ok === false) {
    return errorResponse(enabled.error);
  }

  let targetUrl = existing.targetUrl;
  if ("targetUrl" in body.value) {
    const raw = requireStringField(body.value, "targetUrl");
    if (raw.ok === false) {
      return errorResponse(raw.error);
    }
    const parsed = parseTargetUrl(raw.value);
    if (parsed.ok === false) {
      return errorResponse(parsed.error);
    }
    targetUrl = parsed.value;
  }

  // An explicit null clears the secret; omitting the field keeps it.
  let secret = existing.secret;
  if ("secret" in body.value) {
    const provided = optionalStringField(body.value, "secret");
    if (provided.ok === false) {
      return errorResponse(provided.error);
    }
    secret = provided.value;
  }

  const maxAttempts = positiveInteger(
    body.value,
    "maxAttempts",
    existing.maxAttempts,
  );
  if (maxAttempts.ok === false) {
    return errorResponse(maxAttempts.error);
  }
  const backoffSeconds = positiveInteger(
    body.value,
    "backoffSeconds",
    existing.backoffSeconds,
  );
  if (backoffSeconds.ok === false) {
    return errorResponse(backoffSeconds.error);
  }
  const timeoutSeconds = positiveInteger(
    body.value,
    "timeoutSeconds",
    existing.timeoutSeconds,
  );
  if (timeoutSeconds.ok === false) {
    return errorResponse(timeoutSeconds.error);
  }
  const timeoutAllowed = checkTimeoutAgainstLease(ctx, timeoutSeconds.value);
  if (timeoutAllowed.ok === false) {
    return errorResponse(timeoutAllowed.error);
  }

  const updated: RelayRecord = {
    ...existing,
    name: name.value ?? existing.name,
    targetUrl,
    secret,
    enabled: enabled.value ?? existing.enabled,
    maxAttempts: maxAttempts.value,
    backoffSeconds: backoffSeconds.value,
    timeoutSeconds: timeoutSeconds.value,
  };
  await ctx.persistence.relays.update(updated);
  return jsonResponse(relayToJson(updated));
}

async function listRelays(ctx: AppContext, url: URL): Promise<Response> {
  const destinationId = url.searchParams.get("destinationId");
  const relays =
    destinationId === null || destinationId.length === 0
      ? await ctx.persistence.relays.list()
      : await ctx.persistence.relays.listForDestination(destinationId);

  const withStats: JsonObject[] = [];
  for (const relay of relays) {
    const stats = await ctx.persistence.relayDeliveries.statsForRelay(relay.id);
    withStats.push(relayToJson(relay, stats));
  }
  return jsonResponse({ relays: withStats });
}

async function listDeliveries(
  ctx: AppContext,
  url: URL,
  relay: RelayRecord,
): Promise<Response> {
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit =
    rawLimit === null
      ? ctx.config.defaultFetchLimit
      : Number.parseInt(rawLimit, 10);
  if (Number.isFinite(parsedLimit) === false || parsedLimit < 1) {
    return errorResponse(
      errors.badRequest('Parameter "limit" must be a positive integer'),
    );
  }
  const deliveries = await ctx.persistence.relayDeliveries.listForRelay(
    relay.id,
    Math.min(parsedLimit, ctx.config.maxFetchLimit),
  );
  const stats = await ctx.persistence.relayDeliveries.statsForRelay(relay.id);
  return jsonResponse({
    deliveries: deliveries.map(relayDeliveryToJson),
    stats: {
      pending: stats.pending,
      delivered: stats.delivered,
      failed: stats.failed,
    },
  });
}

/** Routes `/_admin/api/relays...`. */
export async function handleRelaysApi(
  ctx: AppContext,
  request: Request,
  url: URL,
  segments: readonly string[],
  principal: AdminPrincipal,
): Promise<Response> {
  const [, id, action] = segments;

  if (id === undefined) {
    if (request.method === "GET") {
      return listRelays(ctx, url);
    }
    if (request.method === "POST") {
      return createRelay(ctx, request, principal);
    }
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  const relay = await ctx.persistence.relays.findById(id);
  if (relay === null) {
    return errorResponse(errors.notFound("Unknown relay"));
  }

  if (action === "deliveries") {
    if (request.method !== "GET") {
      return errorResponse(
        errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
      );
    }
    return listDeliveries(ctx, url, relay);
  }

  if (action === "retry") {
    if (request.method !== "POST") {
      return errorResponse(
        errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
      );
    }
    const requeued = await ctx.persistence.relayDeliveries.requeueFailed(
      relay.id,
      ctx.clock.nowSeconds(),
    );
    return jsonResponse({ requeued });
  }

  if (action !== undefined) {
    return errorResponse(errors.notFound("Unknown relay action"));
  }

  if (request.method === "GET") {
    const stats = await ctx.persistence.relayDeliveries.statsForRelay(relay.id);
    return jsonResponse(relayToJson(relay, stats));
  }
  if (request.method === "PATCH") {
    return patchRelay(ctx, request, relay);
  }
  if (request.method === "DELETE") {
    await ctx.persistence.relays.delete(relay.id);
    return noContentResponse();
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}
