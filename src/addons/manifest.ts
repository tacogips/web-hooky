/**
 * Addon manifest parsing and validation.
 */
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  readString,
} from "../core/json";
import { err, ok, type Result } from "../core/result";
import { parseJsonSchema } from "../schema/validate";
import type { JsonSchema } from "../schema/types";
import { AddonKind } from "../storage/types";
import type { AddonManifest } from "./types";

/**
 * Addon names are lower-case, dash separated, and must not collide with the
 * reserved `_`-prefixed routes (`/_get`, `/_ws`, `/_admin`).
 */
export const ADDON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const MANIFEST_FILENAME = "addon.json";

/** Validates an addon name in isolation. */
export function isValidAddonName(name: string): boolean {
  return ADDON_NAME_PATTERN.test(name);
}

function parseKind(value: string): AddonKind | null {
  switch (value) {
    case AddonKind.Vendor:
      return AddonKind.Vendor;
    case AddonKind.Destination:
      return AddonKind.Destination;
    case AddonKind.Both:
      return AddonKind.Both;
    default:
      return null;
  }
}

function parseSchemaField(
  source: JsonObject,
  key: string,
  fallback: JsonSchema,
): Result<JsonSchema, string> {
  const raw = source[key];
  if (raw === undefined) {
    return ok(fallback);
  }
  const parsed = parseJsonSchema(raw);
  if (parsed.ok === false) {
    return err(`${key}: ${parsed.error}`);
  }
  return ok(parsed.value);
}

/** Parses and validates a manifest document. */
export function parseAddonManifest(
  value: JsonValue,
): Result<AddonManifest, string> {
  if (isJsonObject(value) === false) {
    return err("Manifest must be a JSON object");
  }

  const name = readString(value, "name");
  if (name === null || isValidAddonName(name) === false) {
    return err(
      'Manifest field "name" must match [a-z0-9][a-z0-9-]* (max 63 chars)',
    );
  }

  const version = readString(value, "version") ?? "0.0.0";
  const kindRaw = readString(value, "kind") ?? AddonKind.Vendor;
  const kind = parseKind(kindRaw);
  if (kind === null) {
    return err(
      `Manifest field "kind" must be one of vendor, destination, both (got ${kindRaw})`,
    );
  }

  const description = readString(value, "description") ?? "";
  const entryRaw = value["entry"];
  const entry =
    entryRaw === undefined || entryRaw === null
      ? null
      : typeof entryRaw === "string"
        ? entryRaw
        : undefined;
  if (entry === undefined) {
    return err('Manifest field "entry" must be a string when present');
  }

  const accepts = parseSchemaField(value, "acceptsSchema", true);
  if (accepts.ok === false) {
    return err(accepts.error);
  }
  const returns = parseSchemaField(value, "returnsSchema", true);
  if (returns.ok === false) {
    return err(returns.error);
  }

  const configRaw = value["configSchema"];
  let configSchema: JsonSchema | null = null;
  if (configRaw !== undefined && configRaw !== null) {
    const parsed = parseJsonSchema(configRaw);
    if (parsed.ok === false) {
      return err(`configSchema: ${parsed.error}`);
    }
    configSchema = parsed.value;
  }

  return ok({
    name,
    version,
    kind,
    description,
    entry,
    acceptsSchema: accepts.value,
    returnsSchema: returns.value,
    configSchema,
  });
}

/** True when the addon may be used as the vendor-level addon of a route. */
export function supportsVendorRole(manifest: AddonManifest): boolean {
  return manifest.kind === AddonKind.Vendor || manifest.kind === AddonKind.Both;
}

/** True when the addon may be used as a destination-level addon. */
export function supportsDestinationRole(manifest: AddonManifest): boolean {
  return (
    manifest.kind === AddonKind.Destination || manifest.kind === AddonKind.Both
  );
}

/** Serialises a manifest back into a JSON object for storage/display. */
export function manifestToJson(manifest: AddonManifest): JsonObject {
  return {
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description,
    entry: manifest.entry,
    acceptsSchema: manifest.acceptsSchema,
    returnsSchema: manifest.returnsSchema,
    configSchema: manifest.configSchema,
  };
}
