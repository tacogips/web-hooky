/**
 * The HTTP transport shared by both clients.
 */
import { requestHeaders, type ResolvedConfig } from "./config.js";
import { errorFromResponse, messageOf, WebhookyError } from "./errors.js";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RequestSpec {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Marshalled as JSON when present. */
  readonly body?: unknown;
  /** A pre-encoded body, used by the multipart addon upload. */
  readonly rawBody?: Uint8Array;
  readonly contentType?: string;
  /**
   * Adds an `Origin` header matching the server.
   *
   * The server's CSRF rule accepts an identity-provider write either with a
   * matching `Origin` or with `content-type: application/json`. A multipart
   * upload cannot use the latter, so it uses the former.
   */
  readonly sendOrigin?: boolean;
}

function resolveContentType(spec: RequestSpec): string | null {
  if (spec.contentType !== undefined) {
    return spec.contentType;
  }
  if (spec.body !== undefined) {
    return "application/json";
  }
  // Bodyless writes (rotate, grant, delete) still declare JSON so the
  // identity-provider path clears the server's CSRF check.
  return SAFE_METHODS.has(spec.method) ? null : "application/json";
}

function buildUrl(config: ResolvedConfig, spec: RequestSpec): string {
  const url = `${config.urls.http}${spec.path}`;
  const entries = Object.entries(spec.query ?? {});
  if (entries.length === 0) {
    return url;
  }
  return `${url}?${new URLSearchParams(entries).toString()}`;
}

/** Percent-encodes a value used as a single URL path segment. */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Performs one request and returns the response body text.
 *
 * A 204 yields an empty string, which the decoders treat as "no value".
 */
export async function sendRequest(
  config: ResolvedConfig,
  spec: RequestSpec,
): Promise<string> {
  const headers = requestHeaders(config, resolveContentType(spec));
  if (spec.sendOrigin === true) {
    headers["origin"] = new URL(config.urls.http).origin;
  }

  const init: RequestInit = { method: spec.method, headers };
  if (spec.rawBody !== undefined) {
    init.body = spec.rawBody as BodyInit;
  } else if (spec.body !== undefined) {
    init.body = JSON.stringify(spec.body);
  }

  // AbortSignal.timeout gives the same ceiling to every request without
  // leaving a timer behind when the request finishes first.
  const timeoutMs = Math.round(config.timeoutSeconds * 1000);
  init.signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await config.fetchImpl(buildUrl(config, spec), init);
  } catch (error) {
    throw new WebhookyError(`request failed: ${messageOf(error)}`, {
      cause: error,
    });
  }

  const text = response.status === 204 ? "" : await response.text();
  if (response.ok === false) {
    throw errorFromResponse(response.status, text);
  }
  return text;
}

/** Runs a request and parses its JSON response. */
export async function requestJson<T>(
  config: ResolvedConfig,
  spec: RequestSpec,
  decode: (value: unknown) => T,
): Promise<T> {
  const text = await sendRequest(config, spec);
  if (text.trim().length === 0) {
    return decode(undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WebhookyError(`failed to decode response: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return decode(parsed);
}

/**
 * Unwraps `{ "<key>": [...] }` into a plain array.
 *
 * The envelope carries no information a typed client needs, so it is dropped
 * here rather than in every caller.
 */
export function unwrapList<T>(key: string): (value: unknown) => readonly T[] {
  return (value: unknown): readonly T[] => {
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const items = (value as Record<string, unknown>)[key];
    return Array.isArray(items) ? (items as T[]) : [];
  };
}

/** Casts a decoded object into a typed model. */
export function asObject<T>(value: unknown): T {
  return (value ?? {}) as T;
}

/** Decoder for endpoints whose body is discarded. */
export function asVoid(): undefined {
  return undefined;
}

/**
 * Drops keys whose value is `undefined` so they never reach the wire.
 *
 * The server distinguishes an absent field (keep the current value) from an
 * explicit `null` (clear it), so an unset optional must not be serialised.
 */
export function pruneUndefined<T extends object>(
  body: T,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
