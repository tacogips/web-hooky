/**
 * Cross-site request forgery defence for the admin API.
 *
 * Admin API keys are not ambient credentials: a browser never attaches them by
 * itself, so key-authenticated requests need no CSRF check. Identities asserted
 * by an IdP proxy (Cloudflare Access, Vercel, GCP IAP) *are* ambient - they ride
 * on a cookie the browser sends automatically - so a page the administrator
 * visits could otherwise drive `/_admin/api` on their behalf.
 *
 * Two rules cover the browser attack surface for state-changing methods:
 *
 *   1. When an `Origin` header is present it must be this deployment's own
 *      origin or an explicitly configured one. Browsers send `Origin` on every
 *      cross-site POST/PUT/PATCH/DELETE, so this catches forms and `fetch`.
 *   2. Without an `Origin` header, only `application/json` bodies are accepted.
 *      A cross-site request that sets that content type is not a CORS "simple
 *      request", so it is preflighted, and the preflight fails because no CORS
 *      response headers are ever emitted. Form encodings (`text/plain`,
 *      `application/x-www-form-urlencoded`, `multipart/form-data`), which need
 *      no preflight, are rejected on this path.
 */
import type { AppConfig } from "../config";
import { type AppError, errors } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { AdminPrincipal } from "./auth";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

function baseContentType(request: Request): string {
  const raw = request.headers.get("content-type") ?? "";
  return (raw.split(";")[0] ?? "").trim().toLowerCase();
}

/** Rejects IdP-authenticated admin mutations that could be cross-site forged. */
export function checkAdminCsrf(
  config: AppConfig,
  request: Request,
  principal: AdminPrincipal,
): Result<null, AppError> {
  if (principal.viaApiKey) {
    return ok(null);
  }
  if (SAFE_METHODS.has(request.method)) {
    return ok(null);
  }

  const origin = request.headers.get("origin");
  if (origin !== null && origin.trim().length > 0) {
    const allowed = new Set<string>([
      normalizeOrigin(new URL(request.url).origin),
      ...config.adminAllowedOrigins,
    ]);
    if (allowed.has(normalizeOrigin(origin)) === false) {
      return err(
        errors.forbidden(
          `Cross-origin admin request from "${origin}" is not allowed`,
        ),
      );
    }
    return ok(null);
  }

  if (baseContentType(request) !== "application/json") {
    return err(
      errors.forbidden(
        'Admin writes without an "Origin" header require content-type: application/json',
      ),
    );
  }
  return ok(null);
}
