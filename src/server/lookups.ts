/**
 * Cached lookups and consumer authorization for the fetch surfaces.
 */
import { type AppError, errors } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import { cacheKeys } from "../storage/cache";
import type { ApiUserRecord, DestinationRecord } from "../storage/types";
import type { AppContext } from "./context";
import { extractKeyCredentials, verifySecret } from "./credentials";

/**
 * Values put into the cache are produced by this module, so the parse back is a
 * straight cast; a corrupted entry simply falls back to the database.
 */
function decodeCached<T>(raw: string | null): T | null {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function findDestination(
  ctx: AppContext,
  cacheKey: string,
  load: () => Promise<DestinationRecord | null>,
): Promise<DestinationRecord | null> {
  if (ctx.config.cacheTtlSeconds > 0) {
    const cached = decodeCached<DestinationRecord>(
      await ctx.cache.get(cacheKey),
    );
    if (cached !== null) {
      return cached;
    }
  }
  const destination = await load();
  if (destination !== null && ctx.config.cacheTtlSeconds > 0) {
    await ctx.cache.set(
      cacheKey,
      JSON.stringify(destination),
      ctx.config.cacheTtlSeconds,
    );
  }
  return destination;
}

export function findDestinationByInboundUuid(
  ctx: AppContext,
  uuid: string,
): Promise<DestinationRecord | null> {
  return findDestination(ctx, cacheKeys.destinationByInbound(uuid), () =>
    ctx.persistence.destinations.findByInboundUuid(uuid),
  );
}

export function findDestinationByFetchUuid(
  ctx: AppContext,
  uuid: string,
): Promise<DestinationRecord | null> {
  return findDestination(ctx, cacheKeys.destinationByFetch(uuid), () =>
    ctx.persistence.destinations.findByFetchUuid(uuid),
  );
}

/**
 * Drops every cache entry that could hold a stale copy of a destination, and
 * hangs up the sockets that were authorized against the previous state.
 *
 * A WebSocket is authorized once, at the handshake, so disabling or deleting a
 * destination - or rotating its fetch uuid - would otherwise leave in-flight
 * sockets streaming records forever. Clients reconnect and are checked again.
 */
export async function invalidateDestination(
  ctx: AppContext,
  destination: DestinationRecord,
): Promise<void> {
  await ctx.cache.delete(
    cacheKeys.destinationByInbound(destination.inboundUuid),
  );
  await ctx.cache.delete(cacheKeys.destinationByFetch(destination.fetchUuid));
  ctx.hub.closeForDestination(
    destination.id,
    "Destination configuration changed",
  );
}

/**
 * Drops cached authorization state for an API user and closes the sockets that
 * user opened, so disabling it, rotating its secret or revoking a grant takes
 * effect on connections that are already streaming.
 */
export async function invalidateApiUser(
  ctx: AppContext,
  userId: string,
): Promise<void> {
  await ctx.cache.delete(cacheKeys.apiUser(userId));
  await ctx.cache.deleteByPrefix(`grant:${userId}:`);
  ctx.hub.closeForApiUser(userId, "API user access changed");
}

async function findApiUser(
  ctx: AppContext,
  keyId: string,
): Promise<ApiUserRecord | null> {
  const cacheKey = cacheKeys.apiUser(keyId);
  if (ctx.config.cacheTtlSeconds > 0) {
    const cached = decodeCached<ApiUserRecord>(await ctx.cache.get(cacheKey));
    if (cached !== null) {
      return cached;
    }
  }
  const user = await ctx.persistence.apiUsers.findById(keyId);
  if (user !== null && ctx.config.cacheTtlSeconds > 0) {
    await ctx.cache.set(
      cacheKey,
      JSON.stringify(user),
      ctx.config.cacheTtlSeconds,
    );
  }
  return user;
}

async function hasGrant(
  ctx: AppContext,
  userId: string,
  destinationId: string,
): Promise<boolean> {
  const cacheKey = cacheKeys.grant(userId, destinationId);
  if (ctx.config.cacheTtlSeconds > 0) {
    const cached = await ctx.cache.get(cacheKey);
    if (cached !== null) {
      return cached === "1";
    }
  }
  const granted = await ctx.persistence.apiUsers.hasGrant(
    userId,
    destinationId,
  );
  if (ctx.config.cacheTtlSeconds > 0) {
    await ctx.cache.set(
      cacheKey,
      granted ? "1" : "0",
      ctx.config.cacheTtlSeconds,
    );
  }
  return granted;
}

/**
 * Authenticates a fetch API consumer and checks that it was granted access to
 * the destination.
 */
export async function authorizeFetchConsumer(
  ctx: AppContext,
  request: Request,
  url: URL | null,
  destination: DestinationRecord,
): Promise<Result<ApiUserRecord, AppError>> {
  const credentials = extractKeyCredentials(request, url);
  if (credentials === null) {
    return err(
      errors.unauthorized(
        "Missing API credentials (Authorization: Bearer <keyId>:<secret>)",
      ),
    );
  }
  const user = await findApiUser(ctx, credentials.keyId);
  if (user === null || user.enabled === false) {
    return err(errors.unauthorized("Invalid API credentials"));
  }
  if ((await verifySecret(credentials.secret, user.secretHash)) === false) {
    return err(errors.unauthorized("Invalid API credentials"));
  }
  if ((await hasGrant(ctx, user.id, destination.id)) === false) {
    return err(
      errors.forbidden("API user is not authorized for this destination"),
    );
  }
  return ok(user);
}
