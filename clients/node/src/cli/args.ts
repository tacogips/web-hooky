/**
 * Argument parsing and shared CLI helpers.
 *
 * Built on `node:util`'s `parseArgs`, which both Node 22+ and Bun provide, so
 * the CLI needs no dependency.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { WebhookyAdminClient } from "../admin-client.js";
import { WebhookyFetchClient } from "../fetch-client.js";
import type { JsonObject } from "../types.js";
import {
  CLI_USER_AGENT,
  resolveAdminCredential,
  resolveBaseUrl,
  resolveFetchCredentials,
  resolveHeaders,
  resolveTimeout,
  UsageError,
} from "./env.js";

/** Options every command accepts, plus the per-command ones. */
const GLOBAL_OPTIONS = {
  url: { type: "string" },
  timeout: { type: "string" },
  header: { type: "string", multiple: true },
  pretty: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean" },
} as const;

const COMMAND_OPTIONS = {
  "fetch-uuid": { type: "string" },
  "only-unfetched": { type: "boolean" },
  "no-mark-fetched": { type: "boolean" },
  from: { type: "string" },
  to: { type: "string" },
  limit: { type: "string" },
  reconnect: { type: "boolean" },
  "max-records": { type: "string" },
  name: { type: "string" },
  label: { type: "string" },
  "vendor-addon": { type: "string" },
  "destination-addon": { type: "string" },
  "vendor-config": { type: "string" },
  "destination-config": { type: "string" },
  "retention-seconds": { type: "string" },
  enabled: { type: "string" },
  "destination-id": { type: "string" },
  "target-url": { type: "string" },
  secret: { type: "string" },
  "max-attempts": { type: "string" },
  "backoff-seconds": { type: "string" },
  "timeout-seconds": { type: "string" },
} as const;

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: Readonly<
    Record<string, string | boolean | string[] | undefined>
  >;
  /** Names the user actually typed, which is what drives partial updates. */
  readonly provided: ReadonlySet<string>;
}

/** Parses argv into positionals and flags. */
export function parseCommandLine(argv: readonly string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }

  // parseArgs reports defaults and provided values alike, so "was it typed"
  // is recovered from argv: a patch must never reset a field the caller did
  // not mention.
  const provided = new Set<string>();
  for (const token of argv) {
    if (token.startsWith("--")) {
      const name = token.slice(2).split("=")[0];
      if (name !== undefined && name.length > 0) {
        provided.add(name);
      }
    }
  }

  return {
    positionals: parsed.positionals,
    values: parsed.values as ParsedArgs["values"],
    provided,
  };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true;
}

export function headerFlags(args: ParsedArgs): readonly string[] {
  const value = args.values["header"];
  return Array.isArray(value) ? value : [];
}

export function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) === false) {
    throw new UsageError(`--${name} must be a number`);
  }
  return parsed;
}

/** Reads a `--flag true|false` value, defaulting to `true` when bare. */
export function tristateFlag(
  args: ParsedArgs,
  name: string,
): boolean | undefined {
  if (args.provided.has(name) === false) {
    return undefined;
  }
  const raw = stringFlag(args, name);
  if (raw === undefined || raw.length === 0) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new UsageError(`--${name} must be true or false`);
}

/** Requires a positional argument, naming it in the error. */
export function requirePositional(
  positionals: readonly string[],
  index: number,
  name: string,
): string {
  const value = positionals[index];
  if (value === undefined || value.length === 0) {
    throw new UsageError(`missing required argument <${name}>`);
  }
  return value;
}

/**
 * Parses an inline JSON object or `@path/to/file.json`.
 *
 * Shells make large inline JSON painful to quote, and addon configuration is
 * exactly the kind of thing that already lives in a file.
 */
export async function jsonFlag(
  args: ParsedArgs,
  name: string,
): Promise<JsonObject | undefined> {
  const raw = stringFlag(args, name);
  if (raw === undefined) {
    return undefined;
  }
  let text = raw.trim();
  if (text.startsWith("@")) {
    const path = text.slice(1);
    try {
      text = (await readFile(path, "utf8")).trim();
    } catch (error) {
      throw new UsageError(
        `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `--${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`--${name} must be a JSON object`);
  }
  return parsed as JsonObject;
}

/** Writes one JSON document to stdout. */
export function emit(value: unknown, pretty: boolean): void {
  process.stdout.write(
    `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`,
  );
}

export function buildFetchClient(args: ParsedArgs): WebhookyFetchClient {
  const { apiKey, apiSecret } = resolveFetchCredentials();
  return new WebhookyFetchClient({
    baseUrl: resolveBaseUrl(stringFlag(args, "url")),
    apiKey,
    apiSecret,
    timeoutSeconds: resolveTimeout(stringFlag(args, "timeout")),
    headers: resolveHeaders(headerFlags(args)),
    userAgent: CLI_USER_AGENT,
  });
}

export function buildAdminClient(args: ParsedArgs): WebhookyAdminClient {
  // The credential may be absent: a deployment fronted by an identity-provider
  // proxy authenticates through headers instead, which --header supplies.
  const headers = resolveHeaders(headerFlags(args));
  const credential = resolveAdminCredential(headers);
  return new WebhookyAdminClient({
    baseUrl: resolveBaseUrl(stringFlag(args, "url")),
    ...(credential.length > 0 ? { credential } : {}),
    timeoutSeconds: resolveTimeout(stringFlag(args, "timeout")),
    headers,
    userAgent: CLI_USER_AGENT,
  });
}
