/**
 * API key/secret credential extraction shared by the fetch and admin surfaces.
 *
 * Accepted forms:
 *   Authorization: Bearer <keyId>:<secret>
 *   X-Api-Key: <keyId> / X-Api-Secret: <secret>
 *   ?api_key=<keyId>&api_secret=<secret>   (WebSocket handshakes only)
 */
import { sha256Hex, timingSafeEqualString } from "../core/ids";

export interface KeyCredentials {
  readonly keyId: string;
  readonly secret: string;
}

function fromAuthorizationHeader(value: string | null): KeyCredentials | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  const prefix = "bearer ";
  if (trimmed.toLowerCase().startsWith(prefix) === false) {
    return null;
  }
  const token = trimmed.slice(prefix.length).trim();
  const separator = token.indexOf(":");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  return {
    keyId: token.slice(0, separator),
    secret: token.slice(separator + 1),
  };
}

function fromHeaderPair(request: Request): KeyCredentials | null {
  const keyId = request.headers.get("x-api-key");
  const secret = request.headers.get("x-api-secret");
  if (keyId === null || secret === null) {
    return null;
  }
  if (keyId.length === 0 || secret.length === 0) {
    return null;
  }
  return { keyId, secret };
}

function fromQuery(url: URL | null): KeyCredentials | null {
  if (url === null) {
    return null;
  }
  const keyId = url.searchParams.get("api_key");
  const secret = url.searchParams.get("api_secret");
  if (keyId === null || secret === null) {
    return null;
  }
  if (keyId.length === 0 || secret.length === 0) {
    return null;
  }
  return { keyId, secret };
}

/**
 * Extracts credentials from a request.
 *
 * `url` is only supplied for WebSocket handshakes, where browsers cannot set
 * request headers.
 */
export function extractKeyCredentials(
  request: Request,
  url: URL | null = null,
): KeyCredentials | null {
  return (
    fromAuthorizationHeader(request.headers.get("authorization")) ??
    fromHeaderPair(request) ??
    fromQuery(url)
  );
}

/**
 * Compares a presented secret with a stored hash in constant time.
 *
 * Secrets are 256-bit random values, so a salted KDF adds no meaningful
 * resistance: SHA-256 of the secret is used as the stored verifier.
 */
export async function verifySecret(
  presented: string,
  storedHash: string,
): Promise<boolean> {
  const hash = await sha256Hex(presented);
  return timingSafeEqualString(hash, storedHash);
}

/** Hashes a freshly issued secret for storage. */
export function hashSecret(secret: string): Promise<string> {
  return sha256Hex(secret);
}
