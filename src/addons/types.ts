/**
 * Addon contract.
 *
 * An addon adapts one webhook source (vendor level) or post-processes payloads
 * for one destination (destination level). Addons receive only the data they
 * need: headers, the raw body, and destination-supplied configuration.
 */
import type { JsonObject, JsonValue } from "../core/json";
import type { JsonSchema } from "../schema/types";
import type { AddonKind, AddonSource } from "../storage/types";

export interface AddonManifest {
  /** Unique server-wide addon name; appears in inbound URLs. */
  readonly name: string;
  readonly version: string;
  readonly kind: AddonKind;
  readonly description: string;
  /** Entry module relative to the package root; null for built-in addons. */
  readonly entry: string | null;
  /** JSON Schema describing the data the addon accepts. */
  readonly acceptsSchema: JsonSchema;
  /** JSON Schema describing the data the addon returns. */
  readonly returnsSchema: JsonSchema;
  /** Optional JSON Schema validating the per-destination config object. */
  readonly configSchema: JsonSchema | null;
}

export interface AddonRequestContext {
  readonly method: string;
  /** Lower-cased request headers. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly config: JsonObject;
  readonly destinationId: string;
  readonly addonName: string;
  readonly receivedAt: number;
}

/**
 * A response an addon asks the server to send instead of processing the
 * request further.
 *
 * Some vendors require a handshake before they will register a webhook (Wrike
 * echoes back a derived `X-Hook-Secret`), so an addon must be able to shape the
 * response. A request answered this way is never parsed, transformed,
 * persisted, broadcast or relayed.
 */
export interface AddonResponse {
  /** HTTP status; must be in the 200-599 range. */
  readonly status: number;
  /** Response headers; names are lower-cased by the server. */
  readonly headers: Readonly<Record<string, string>>;
  /** Response body, or null for an empty body. */
  readonly body: string | null;
}

export type AddonAuthResult =
  | { readonly ok: true; readonly respondWith?: AddonResponse }
  | { readonly ok: false; readonly status: number; readonly message: string };

export interface AddonTransformContext {
  readonly headers: Readonly<Record<string, string>>;
  readonly config: JsonObject;
  readonly destinationId: string;
  readonly addonName: string;
  readonly receivedAt: number;
}

export interface AddonModule {
  authenticate?(
    ctx: AddonRequestContext,
  ): Promise<AddonAuthResult> | AddonAuthResult;
  transform?(
    input: JsonValue,
    ctx: AddonTransformContext,
  ): Promise<JsonValue> | JsonValue;
}

export interface LoadedAddon {
  readonly manifest: AddonManifest;
  readonly module: AddonModule;
  readonly source: AddonSource;
}

/** Helper for addon authors: an accepted request. */
export const addonAuthOk: AddonAuthResult = { ok: true };

/** Helper for addon authors: a rejected request. */
export function addonAuthFailed(
  message: string,
  status = 401,
): AddonAuthResult {
  return { ok: false, status, message };
}

/**
 * Helper for addon authors: an authenticated request the addon answers itself
 * (vendor handshakes). Nothing downstream of authentication runs.
 */
export function addonAuthHandled(response: AddonResponse): AddonAuthResult {
  return { ok: true, respondWith: response };
}
