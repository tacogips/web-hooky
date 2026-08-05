/**
 * Admin API handlers for admin API keys and admin users.
 */
import { errors } from "../core/errors";
import { newKeyId, newSecret } from "../core/ids";
import type { AppContext } from "../server/context";
import { hashSecret } from "../server/credentials";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
} from "../server/responses";
import {
  AdminRole,
  type AdminKeyRecord,
  type AdminUserRecord,
} from "../storage/types";
import {
  adminKeyToJson,
  adminUserToJson,
  readJsonObjectBody,
  requireStringField,
} from "./helpers";

/**
 * Decodes a percent-encoded path segment.
 *
 * `decodeURIComponent` throws on malformed input such as `%ZZ`, which would
 * otherwise surface as a 500 for what is simply a bad request.
 */
function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function createAdminKey(
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
  const key: AdminKeyRecord = {
    id: newKeyId(),
    label: label.value,
    secretHash: await hashSecret(secret),
    enabled: true,
    createdAt: ctx.clock.nowSeconds(),
  };
  await ctx.persistence.adminKeys.create(key);

  // The secret is shown exactly once, at creation time.
  return jsonResponse(
    { ...adminKeyToJson(key), secret, credential: `${key.id}:${secret}` },
    201,
  );
}

/** Routes `/_admin/api/admin-keys...`. */
export async function handleAdminKeysApi(
  ctx: AppContext,
  request: Request,
  segments: readonly string[],
): Promise<Response> {
  const [, id] = segments;

  if (id === undefined) {
    if (request.method === "GET") {
      const keys = await ctx.persistence.adminKeys.list();
      return jsonResponse({ keys: keys.map(adminKeyToJson) });
    }
    if (request.method === "POST") {
      return createAdminKey(ctx, request);
    }
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  if (request.method === "DELETE") {
    const deleted = await ctx.persistence.adminKeys.delete(id);
    if (deleted === false) {
      return errorResponse(errors.notFound("Unknown admin key"));
    }
    return noContentResponse();
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}

/** Routes `/_admin/api/admin-users...`. */
export async function handleAdminUsersApi(
  ctx: AppContext,
  request: Request,
  segments: readonly string[],
): Promise<Response> {
  const [, subject] = segments;

  if (subject === undefined) {
    if (request.method === "GET") {
      const users = await ctx.persistence.adminUsers.list();
      return jsonResponse({ adminUsers: users.map(adminUserToJson) });
    }
    if (request.method === "POST") {
      const body = await readJsonObjectBody(request);
      if (body.ok === false) {
        return errorResponse(body.error);
      }
      const value = requireStringField(body.value, "subject");
      if (value.ok === false) {
        return errorResponse(value.error);
      }
      const user: AdminUserRecord = {
        subject: value.value,
        role: AdminRole.Admin,
        createdAt: ctx.clock.nowSeconds(),
      };
      await ctx.persistence.adminUsers.upsert(user);
      return jsonResponse(adminUserToJson(user), 201);
    }
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  if (request.method === "DELETE") {
    const decoded = decodePathSegment(subject);
    if (decoded === null) {
      return errorResponse(
        errors.badRequest("Admin user subject is not valid percent-encoding"),
      );
    }
    const deleted = await ctx.persistence.adminUsers.delete(decoded);
    if (deleted === false) {
      return errorResponse(errors.notFound("Unknown admin user"));
    }
    return noContentResponse();
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}
