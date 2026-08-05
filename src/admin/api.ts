/**
 * Admin API router mounted at `/_admin/api`.
 *
 * Everything the admin UI can do is available here, so an admin-privileged API
 * key gives full programmatic parity with the UI.
 */
import { errors } from "../core/errors";
import type { AppContext } from "../server/context";
import { errorResponse, jsonResponse } from "../server/responses";
import { handleAddonsApi } from "./addons-api";
import { resolveAdminPrincipal } from "./auth";
import { checkAdminCsrf } from "./csrf";
import { handleDestinationsApi } from "./destinations-api";
import { handleAdminKeysApi, handleAdminUsersApi } from "./keys-api";
import { handleRelaysApi } from "./relays-api";
import { handleUsersApi } from "./users-api";

/**
 * Routes an admin API request.
 *
 * `segments` are the path segments after `/_admin/api`.
 */
export async function handleAdminApi(
  ctx: AppContext,
  request: Request,
  segments: readonly string[],
): Promise<Response> {
  const principal = await resolveAdminPrincipal(ctx, request);
  if (principal.ok === false) {
    return errorResponse(principal.error);
  }
  const csrf = checkAdminCsrf(ctx.config, request, principal.value);
  if (csrf.ok === false) {
    return errorResponse(csrf.error);
  }

  const url = new URL(request.url);
  const resource = segments[0];

  switch (resource) {
    case undefined:
      return jsonResponse({
        name: "web-hooky admin api",
        resources: [
          "me",
          "destinations",
          "records",
          "relays",
          "users",
          "addons",
          "admin-keys",
          "admin-users",
        ],
      });
    case "me":
      return jsonResponse({
        subject: principal.value.subject,
        viaApiKey: principal.value.viaApiKey,
        keyId: principal.value.keyId,
        adminAuthProvider: ctx.adminAuth.name,
      });
    case "destinations":
    case "records":
      return handleDestinationsApi(
        ctx,
        request,
        url,
        segments,
        principal.value,
      );
    case "relays":
      return handleRelaysApi(ctx, request, url, segments, principal.value);
    case "users":
      return handleUsersApi(ctx, request, segments);
    case "addons":
      return handleAddonsApi(ctx, request, segments, principal.value);
    case "admin-keys":
      return handleAdminKeysApi(ctx, request, segments);
    case "admin-users":
      return handleAdminUsersApi(ctx, request, segments);
    default:
      return errorResponse(
        errors.notFound(`Unknown admin API resource "${resource}"`),
      );
  }
}
