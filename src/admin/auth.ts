/**
 * Admin principal resolution.
 *
 * Two credential paths are supported and checked in this order:
 *   1. an admin API key (`Authorization: Bearer <keyId>:<secret>`)
 *   2. an identity asserted by the configured external IdP provider
 *
 * IdP subjects must additionally be present in the admin user store, which is
 * seeded from startup parameters.
 */
import { type AppError, errors } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { AppContext } from "../server/context";
import {
  extractKeyCredentials,
  verifySecret,
  type KeyCredentials,
} from "../server/credentials";

export interface AdminPrincipal {
  readonly subject: string;
  readonly viaApiKey: boolean;
  readonly keyId: string | null;
}

/** Resolves an admin API key, or null when it does not identify a usable key. */
async function resolveAdminKey(
  ctx: AppContext,
  credentials: KeyCredentials,
): Promise<AdminPrincipal | null> {
  const key = await ctx.persistence.adminKeys.findById(credentials.keyId);
  if (key === null || key.enabled === false) {
    return null;
  }
  // Constant-time comparison: a presented secret must not be distinguishable
  // by how long the rejection takes.
  if ((await verifySecret(credentials.secret, key.secretHash)) === false) {
    return null;
  }
  return { subject: `admin-key:${key.id}`, viaApiKey: true, keyId: key.id };
}

export async function resolveAdminPrincipal(
  ctx: AppContext,
  request: Request,
): Promise<Result<AdminPrincipal, AppError>> {
  const credentials = extractKeyCredentials(request);
  let keyRejected = false;
  if (credentials !== null) {
    const principal = await resolveAdminKey(ctx, credentials);
    if (principal !== null) {
      return ok(principal);
    }
    // A stale or unrelated `Authorization: Bearer a:b` must not switch the IdP
    // path off: an administrator whose browser still holds an old header would
    // otherwise be locked out of an origin that authenticates them perfectly
    // well. The key error is only reported when no identity resolves either.
    keyRejected = true;
  }

  const identity = await ctx.adminAuth.authenticate(request);
  if (identity === null) {
    return err(
      errors.unauthorized(
        keyRejected
          ? "Invalid admin API key"
          : "Admin authentication required (admin API key or identity provider)",
      ),
    );
  }

  const adminUser = await ctx.persistence.adminUsers.findBySubject(
    identity.subject,
  );
  if (adminUser === null) {
    return err(
      errors.forbidden(`Subject "${identity.subject}" is not an administrator`),
    );
  }

  return ok({ subject: adminUser.subject, viaApiKey: false, keyId: null });
}
