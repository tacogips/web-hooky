/**
 * Environment handling for the CLI.
 *
 * This module is the only place in the client that reads `process.env`; the
 * library takes its configuration as explicit parameters.
 */
import { DEFAULT_TIMEOUT_SECONDS, VERSION } from "../config.js";

export const ENV_URL = "WEBHOOKY_URL";
export const ENV_API_KEY = "WEBHOOKY_API_KEY";
export const ENV_API_SECRET = "WEBHOOKY_API_SECRET";
export const ENV_CREDENTIAL = "WEBHOOKY_CREDENTIAL";
export const ENV_FETCH_UUID = "WEBHOOKY_FETCH_UUID";
export const ENV_ADMIN_CREDENTIAL = "WEBHOOKY_ADMIN_CREDENTIAL";
export const ENV_ADMIN_KEY = "WEBHOOKY_ADMIN_KEY";
export const ENV_ADMIN_SECRET = "WEBHOOKY_ADMIN_SECRET";
export const ENV_TIMEOUT = "WEBHOOKY_TIMEOUT_SECONDS";
export const ENV_HEADERS = "WEBHOOKY_HEADERS";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const CLI_USER_AGENT = `webhooky-node-cli/${VERSION}`;

/** The command was invoked incorrectly; the process exits with code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Reads an environment variable, treating an empty value as unset. */
function env(name: string): string {
  const value = process.env[name];
  return value === undefined ? "" : value.trim();
}

/**
 * Splits `name=value`.
 *
 * Only the first separator is significant: a value can itself contain `=`, as a
 * base64 proxy secret does.
 */
function splitHeader(entry: string): readonly [string, string] {
  const separator = entry.indexOf("=");
  if (separator <= 0) {
    throw new UsageError(`invalid header "${entry}": expected "name=value"`);
  }
  return [
    entry.slice(0, separator).trim(),
    entry.slice(separator + 1).trim(),
  ] as const;
}

/** Merges `WEBHOOKY_HEADERS` with repeated `--header` flags; flags win. */
export function resolveHeaders(
  flagValues: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of env(ENV_HEADERS).split(",")) {
    if (entry.trim().length > 0) {
      const [name, value] = splitHeader(entry.trim());
      headers[name] = value;
    }
  }
  for (const entry of flagValues) {
    const [name, value] = splitHeader(entry);
    headers[name] = value;
  }
  return headers;
}

export function resolveBaseUrl(flagValue: string | undefined): string {
  return flagValue ?? (env(ENV_URL) || DEFAULT_BASE_URL);
}

export function resolveTimeout(flagValue: string | undefined): number {
  const raw = flagValue ?? env(ENV_TIMEOUT);
  if (raw.length === 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) === false || seconds <= 0) {
    const source = flagValue === undefined ? ENV_TIMEOUT : "--timeout";
    throw new UsageError(`${source} must be a positive number of seconds`);
  }
  return seconds;
}

/** Reads the fetch API user's key and secret, in either accepted form. */
export function resolveFetchCredentials(): {
  readonly apiKey: string;
  readonly apiSecret: string;
} {
  let apiKey = env(ENV_API_KEY);
  let apiSecret = env(ENV_API_SECRET);

  if (apiKey.length === 0 && apiSecret.length === 0) {
    // The combined form is what the admin API hands out when a fetch API user
    // is created, so it is accepted verbatim.
    const credential = env(ENV_CREDENTIAL);
    if (credential.length > 0) {
      const separator = credential.indexOf(":");
      if (separator <= 0 || separator === credential.length - 1) {
        throw new UsageError(`${ENV_CREDENTIAL} must be "<keyId>:<secret>"`);
      }
      apiKey = credential.slice(0, separator);
      apiSecret = credential.slice(separator + 1);
    }
  }

  if (apiKey.length === 0 || apiSecret.length === 0) {
    throw new UsageError(
      `missing fetch credentials: set ${ENV_API_KEY} and ${ENV_API_SECRET}, ` +
        `or ${ENV_CREDENTIAL}="<keyId>:<secret>"`,
    );
  }
  return { apiKey, apiSecret };
}

/** Reads the admin credential, which may be absent on the IdP path. */
export function resolveAdminCredential(
  headers: Readonly<Record<string, string>>,
): string {
  let credential = env(ENV_ADMIN_CREDENTIAL);
  if (credential.length === 0) {
    const keyId = env(ENV_ADMIN_KEY);
    const secret = env(ENV_ADMIN_SECRET);
    if (keyId.length > 0 && secret.length > 0) {
      credential = `${keyId}:${secret}`;
    }
  }
  if (credential.length === 0 && Object.keys(headers).length === 0) {
    throw new UsageError(
      `missing admin credentials: set ${ENV_ADMIN_CREDENTIAL}="<keyId>:<secret>" ` +
        `(or ${ENV_ADMIN_KEY} and ${ENV_ADMIN_SECRET}), or pass ` +
        "identity-provider headers with --header",
    );
  }
  return credential;
}

export function resolveFetchUuid(flagValue: string | undefined): string {
  const uuid = flagValue ?? env(ENV_FETCH_UUID);
  if (uuid.length === 0) {
    throw new UsageError(
      `missing destination: pass --fetch-uuid or set ${ENV_FETCH_UUID}`,
    );
  }
  return uuid;
}
