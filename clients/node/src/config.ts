/**
 * Client configuration and URL normalization.
 *
 * Nothing here reads `process.env`: a library caller passes credentials
 * explicitly, so one process can hold several clients with different
 * identities. Only the CLI consults `WEBHOOKY_*` variables.
 */
import { WebhookyError } from "./errors.js";

export const VERSION = "0.1.0";
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_USER_AGENT = `webhooky-node/${VERSION}`;

/** The http and ws forms of one server base URL. */
export interface BaseUrls {
  readonly http: string;
  readonly ws: string;
}

export interface FetchClientConfig {
  /** Server root, e.g. `https://hooks.example.com`. `ws://` is accepted. */
  readonly baseUrl: string;
  /** Fetch API user key id. */
  readonly apiKey: string;
  /** Fetch API user secret. */
  readonly apiSecret: string;
  /** Per-request timeout. Defaults to 30; a stream is not bounded by it. */
  readonly timeoutSeconds?: number;
  /** Extra request headers, for an IdP identity or a proxy shared secret. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  /** Replaces the global `fetch`, for tests or a custom agent. */
  readonly fetchImpl?: typeof fetch;
}

export interface AdminClientConfig {
  readonly baseUrl: string;
  /**
   * `"<keyId>:<secret>"` for an admin API key. May be omitted when the
   * deployment authenticates through an identity-provider proxy and `headers`
   * carry the identity.
   */
  readonly credential?: string;
  /** Alternative to `credential`, supplied as two halves. */
  readonly keyId?: string;
  readonly secret?: string;
  readonly timeoutSeconds?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
}

/** A validated configuration, shared by both client types. */
export interface ResolvedConfig {
  readonly urls: BaseUrls;
  readonly authorization: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly userAgent: string;
  readonly fetchImpl: typeof fetch;
}

const HTTP_SCHEMES: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["http:", ["http", "ws"]],
  ["ws:", ["http", "ws"]],
  ["https:", ["https", "wss"]],
  ["wss:", ["https", "wss"]],
]);

/**
 * Parses a base URL into its http and ws forms.
 *
 * A `ws://` base URL is accepted and mapped to `http://`; handling both here
 * saves every caller from remembering which scheme a given surface wants.
 */
export function normalizeBaseUrl(raw: string): BaseUrls {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new WebhookyError("baseUrl is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebhookyError(`baseUrl "${raw}" is not a valid URL`);
  }
  if (parsed.host.length === 0) {
    throw new WebhookyError(`baseUrl "${raw}" has no host`);
  }

  const schemes = HTTP_SCHEMES.get(parsed.protocol);
  if (schemes === undefined) {
    throw new WebhookyError(
      `baseUrl scheme "${parsed.protocol}" must be http, https, ws or wss`,
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return {
    http: `${schemes[0]}://${parsed.host}${path}`,
    ws: `${schemes[1]}://${parsed.host}${path}`,
  };
}

/** Splits `"<keyId>:<secret>"` into its two halves. */
export function splitCredential(credential: string): {
  readonly keyId: string;
  readonly secret: string;
} {
  const trimmed = (credential ?? "").trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new WebhookyError('credential must be "<keyId>:<secret>"');
  }
  return {
    keyId: trimmed.slice(0, separator),
    secret: trimmed.slice(separator + 1),
  };
}

function resolveCommon(
  baseUrl: string,
  authorization: string,
  timeoutSeconds: number | undefined,
  headers: Readonly<Record<string, string>> | undefined,
  userAgent: string | undefined,
  fetchImpl: typeof fetch | undefined,
): ResolvedConfig {
  const timeout =
    timeoutSeconds === undefined || timeoutSeconds <= 0
      ? DEFAULT_TIMEOUT_SECONDS
      : timeoutSeconds;
  const agent = (userAgent ?? "").trim();
  return {
    urls: normalizeBaseUrl(baseUrl),
    authorization,
    headers: { ...(headers ?? {}) },
    timeoutSeconds: timeout,
    userAgent: agent.length > 0 ? agent : DEFAULT_USER_AGENT,
    fetchImpl: fetchImpl ?? globalThis.fetch,
  };
}

/** Validates and normalizes a fetch client configuration. */
export function resolveFetchConfig(config: FetchClientConfig): ResolvedConfig {
  const key = (config.apiKey ?? "").trim();
  const secret = config.apiSecret ?? "";
  if (key.length === 0 || secret.length === 0) {
    throw new WebhookyError("apiKey and apiSecret are required");
  }
  return resolveCommon(
    config.baseUrl,
    `Bearer ${key}:${secret}`,
    config.timeoutSeconds,
    config.headers,
    config.userAgent,
    config.fetchImpl,
  );
}

/**
 * Validates and normalizes an admin client configuration.
 *
 * All three of a `credential`, a `keyId`/`secret` pair, and no credential at
 * all are valid: a deployment fronted by an identity-provider proxy
 * authenticates through `headers` instead.
 */
export function resolveAdminConfig(config: AdminClientConfig): ResolvedConfig {
  let credential = (config.credential ?? "").trim();
  if (credential.length === 0 && config.keyId && config.secret) {
    credential = `${config.keyId}:${config.secret}`;
  }

  let authorization = "";
  if (credential.length > 0) {
    // Validates the shape; a malformed credential should fail here rather than
    // as a puzzling 401 later.
    splitCredential(credential);
    authorization = `Bearer ${credential}`;
  } else if (Object.keys(config.headers ?? {}).length === 0) {
    throw new WebhookyError(
      'admin credentials are required: pass credential: "<keyId>:<secret>", ' +
        "or headers for an identity-provider deployment",
    );
  }

  return resolveCommon(
    config.baseUrl,
    authorization,
    config.timeoutSeconds,
    config.headers,
    config.userAgent,
    config.fetchImpl,
  );
}

/**
 * Builds the header set for one request.
 *
 * Caller-supplied headers never override the ones the client owns: an
 * `authorization` header passed through `headers` would silently defeat the
 * credentials the caller gave explicitly.
 */
export function requestHeaders(
  config: ResolvedConfig,
  contentType: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  headers["accept"] = "application/json";
  headers["user-agent"] = config.userAgent;
  if (config.authorization.length > 0) {
    headers["authorization"] = config.authorization;
  }
  if (contentType !== null) {
    headers["content-type"] = contentType;
  }
  return headers;
}
