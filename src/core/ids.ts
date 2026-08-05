/**
 * Identifier and cryptographic helpers.
 *
 * Only web-standard APIs are used (`crypto.randomUUID`, `crypto.getRandomValues`,
 * `crypto.subtle`, `TextEncoder`) so this module runs unchanged on Bun,
 * Cloudflare Workers, Vercel, and Node-compatible runtimes.
 */

const textEncoder = new TextEncoder();

/** Generates a random UUID v4. */
export function newUuid(): string {
  return crypto.randomUUID();
}

/** Generates a URL-safe random secret with the given entropy in bytes. */
export function newSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Generates a short random identifier used as an API key id. */
export function newKeyId(): string {
  return newSecret(12);
}

/** Encodes bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Encodes bytes as standard padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Encodes bytes as lowercase hexadecimal. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 of a UTF-8 string, hex encoded. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(input),
  );
  return bytesToHex(new Uint8Array(digest));
}

/** HMAC-SHA256 of a UTF-8 body under a UTF-8 secret. */
export async function hmacSha256(
  secret: string,
  body: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(body),
  );
  return new Uint8Array(signature);
}

/** HMAC-SHA256 rendered as lowercase hex. */
export async function hmacSha256Hex(
  secret: string,
  body: string,
): Promise<string> {
  return bytesToHex(await hmacSha256(secret, body));
}

/** HMAC-SHA256 rendered as standard base64. */
export async function hmacSha256Base64(
  secret: string,
  body: string,
): Promise<string> {
  return bytesToBase64(await hmacSha256(secret, body));
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first because the caller-supplied value length is not a
 * secret; the per-character comparison never short-circuits.
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
