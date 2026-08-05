/**
 * Admin API handlers for fetch API users (key id + secret) and their grants.
 */
import { errors } from "../core/errors";
import { newKeyId, newSecret } from "../core/ids";
import type { AppContext } from "../server/context";
import { hashSecret } from "../server/credentials";
import { invalidateApiUser } from "../server/lookups";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
} from "../server/responses";
import type { ApiUserRecord } from "../storage/types";
import {
  apiUserToJson,
  optionalBooleanField,
  readJsonObjectBody,
  requireStringField,
} from "./helpers";

async function listUsers(ctx: AppContext): Promise<Response> {
  const users = await ctx.persistence.apiUsers.list();
  const withGrants = await Promise.all(
    users.map(async (user) => {
      const grants = await ctx.persistence.apiUsers.listGrants(user.id);
      return apiUserToJson(user, grants);
    }),
  );
  return jsonResponse({ users: withGrants });
}

async function createUser(
  ctx: AppContext,
  request: Request,
): Promise<Response> {
  const body = await readJsonObjectBody(request);
  if (body.ok === false) {
    return errorResponse(body.error);
  }
  const label = requireStringField(body.value, "label");
  if (label.ok === false) {
    return errorResponse(label.error);
  }

  const secret = newSecret();
  const user: ApiUserRecord = {
    id: newKeyId(),
    label: label.value,
    secretHash: await hashSecret(secret),
    enabled: true,
    createdAt: ctx.clock.nowSeconds(),
  };
  await ctx.persistence.apiUsers.create(user);

  // The secret is shown exactly once, at creation time.
  return jsonResponse(
    {
      ...apiUserToJson(user, []),
      secret,
      credential: `${user.id}:${secret}`,
    },
    201,
  );
}

async function rotateSecret(
  ctx: AppContext,
  user: ApiUserRecord,
): Promise<Response> {
  const secret = newSecret();
  const updated: ApiUserRecord = {
    ...user,
    secretHash: await hashSecret(secret),
  };
  await ctx.persistence.apiUsers.update(updated);
  await invalidateApiUser(ctx, user.id);
  const grants = await ctx.persistence.apiUsers.listGrants(user.id);
  return jsonResponse({
    ...apiUserToJson(updated, grants),
    secret,
    credential: `${updated.id}:${secret}`,
  });
}

async function setEnabled(
  ctx: AppContext,
  request: Request,
  user: ApiUserRecord,
): Promise<Response> {
  const body = await readJsonObjectBody(request);
  if (body.ok === false) {
    return errorResponse(body.error);
  }
  const enabled = optionalBooleanField(body.value, "enabled");
  if (enabled.ok === false) {
    return errorResponse(enabled.error);
  }
  const updated: ApiUserRecord = {
    ...user,
    enabled: enabled.value ?? user.enabled,
  };
  await ctx.persistence.apiUsers.update(updated);
  await invalidateApiUser(ctx, user.id);
  const grants = await ctx.persistence.apiUsers.listGrants(user.id);
  return jsonResponse(apiUserToJson(updated, grants));
}

async function handleGrant(
  ctx: AppContext,
  request: Request,
  user: ApiUserRecord,
  destinationId: string | undefined,
): Promise<Response> {
  if (destinationId === undefined) {
    return errorResponse(
      errors.notFound("Expected /users/{id}/grants/{destinationId}"),
    );
  }
  const destination =
    await ctx.persistence.destinations.findById(destinationId);
  if (destination === null) {
    return errorResponse(errors.notFound("Unknown destination"));
  }
  if (request.method === "PUT" || request.method === "POST") {
    await ctx.persistence.apiUsers.grant(
      user.id,
      destinationId,
      ctx.clock.nowSeconds(),
    );
    await invalidateApiUser(ctx, user.id);
    const grants = await ctx.persistence.apiUsers.listGrants(user.id);
    return jsonResponse(apiUserToJson(user, grants));
  }
  if (request.method === "DELETE") {
    await ctx.persistence.apiUsers.revoke(user.id, destinationId);
    await invalidateApiUser(ctx, user.id);
    const grants = await ctx.persistence.apiUsers.listGrants(user.id);
    return jsonResponse(apiUserToJson(user, grants));
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}

/** Routes `/_admin/api/users...`. */
export async function handleUsersApi(
  ctx: AppContext,
  request: Request,
  segments: readonly string[],
): Promise<Response> {
  const [, id, action, target] = segments;

  if (id === undefined) {
    if (request.method === "GET") {
      return listUsers(ctx);
    }
    if (request.method === "POST") {
      return createUser(ctx, request);
    }
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  const user = await ctx.persistence.apiUsers.findById(id);
  if (user === null) {
    return errorResponse(errors.notFound("Unknown API user"));
  }

  if (action === "rotate") {
    if (request.method !== "POST") {
      return errorResponse(
        errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
      );
    }
    return rotateSecret(ctx, user);
  }

  if (action === "grants") {
    return handleGrant(ctx, request, user, target);
  }

  if (action !== undefined) {
    return errorResponse(errors.notFound("Unknown API user action"));
  }

  if (request.method === "GET") {
    const grants = await ctx.persistence.apiUsers.listGrants(user.id);
    return jsonResponse(apiUserToJson(user, grants));
  }
  if (request.method === "PATCH") {
    return setEnabled(ctx, request, user);
  }
  if (request.method === "DELETE") {
    await ctx.persistence.apiUsers.delete(user.id);
    await invalidateApiUser(ctx, user.id);
    return noContentResponse();
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}
