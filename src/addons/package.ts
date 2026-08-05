/**
 * Addon package (zip) reader and installer.
 *
 * Trust model: only administrators may upload addon packages, and installed
 * addon code is imported into the server process, so it runs with full server
 * privileges. The guards below protect against malformed or hostile archives
 * damaging the host filesystem, not against malicious addon code.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { type UnzipFileInfo, unzipSync } from "fflate";
import { type AppError, errors } from "../core/errors";
import { parseJsonText } from "../core/json";
import { err, getErrorMessage, ok, type Result } from "../core/result";
import type { InstalledAddonRecord } from "../storage/types";
import {
  manifestToJson,
  MANIFEST_FILENAME,
  parseAddonManifest,
} from "./manifest";
import type { AddonManifest } from "./types";

export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRY_COUNT = 200;
/**
 * Ceiling on the sum of every entry's decompressed size.
 *
 * The archive cap alone does not bound memory: a few hundred kilobytes of
 * compressed zeroes expand to hundreds of megabytes, and the per-entry cap
 * would still allow `MAX_ENTRY_COUNT` entries just under it.
 */
export const MAX_TOTAL_ENTRY_BYTES = 16 * 1024 * 1024;

export interface AddonPackage {
  readonly manifest: AddonManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/**
 * Rejects entry names that are absolute, escape the package root, or use
 * Windows separators.
 */
function normalizeEntryName(name: string): string | null {
  if (name.length === 0 || name.startsWith("/") || name.includes("\\")) {
    return null;
  }
  if (/^[a-zA-Z]:/.test(name)) {
    return null;
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }
  // Some archivers emit "./name"; the redundant segments are dropped rather
  // than treated as an attack.
  const cleaned = segments.filter(
    (segment) => segment !== "." && segment.length > 0,
  );
  return cleaned.length === 0 ? null : cleaned.join("/");
}

interface EntryBudget {
  rejection: AppError | null;
  count: number;
  totalBytes: number;
}

/** Raised to leave `unzipSync`; the reason is carried on the budget. */
class EntryRefused extends Error {}

/**
 * Records why an entry was refused and stops the archive walk.
 *
 * fflate offers no other way out of its loop, and the loop runs for the number
 * of entries the archive claims to hold rather than for anything measured, so
 * returning `false` would leave it walking a forged central directory long
 * after the first refusal.
 */
function refuse(budget: EntryBudget, error: AppError): never {
  budget.rejection = error;
  throw new EntryRefused();
}

/**
 * Decides whether one archive entry may be inflated.
 *
 * `unzipSync` calls this with the sizes declared in the zip central directory
 * before it allocates anything for the entry, which is the only point at which
 * a decompressed size can be refused without paying for it first.
 */
function admitEntry(budget: EntryBudget, info: UnzipFileInfo): boolean {
  if (info.name.endsWith("/")) {
    // Directory entries carry no payload and are not part of the file count.
    return false;
  }
  budget.count += 1;
  if (budget.count > MAX_ENTRY_COUNT) {
    refuse(
      budget,
      errors.badRequest(
        `Addon package contains more than ${MAX_ENTRY_COUNT} files`,
      ),
    );
  }
  const name = normalizeEntryName(info.name);
  if (name === null) {
    refuse(
      budget,
      errors.badRequest(`Addon package contains an unsafe path: ${info.name}`),
    );
  }
  if (info.originalSize > MAX_ENTRY_BYTES) {
    refuse(
      budget,
      errors.payloadTooLarge(
        `Addon package entry "${name}" exceeds ${MAX_ENTRY_BYTES} bytes`,
      ),
    );
  }
  budget.totalBytes += info.originalSize;
  if (budget.totalBytes > MAX_TOTAL_ENTRY_BYTES) {
    refuse(
      budget,
      errors.payloadTooLarge(
        `Addon package expands to more than ${MAX_TOTAL_ENTRY_BYTES} bytes`,
      ),
    );
  }
  return true;
}

/** Parses a zip archive into a validated addon package. */
export function readAddonPackage(
  archive: Uint8Array,
): Result<AddonPackage, AppError> {
  if (archive.byteLength === 0) {
    return err(errors.badRequest("Addon package is empty"));
  }
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    return err(
      errors.payloadTooLarge(
        `Addon package exceeds ${MAX_ARCHIVE_BYTES} bytes`,
      ),
    );
  }

  const budget: EntryBudget = { rejection: null, count: 0, totalBytes: 0 };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      filter: (info) => admitEntry(budget, info),
    });
  } catch (error) {
    // A refused entry aborts the walk, so its reason is what stopped the read
    // and takes precedence over anything fflate reports about the archive.
    return err(
      budget.rejection ??
        errors.badRequest(
          `Addon package is not a readable zip archive: ${getErrorMessage(error)}`,
        ),
    );
  }

  const files = new Map<string, Uint8Array>();
  for (const [rawName, content] of Object.entries(entries)) {
    const name = normalizeEntryName(rawName);
    if (name === null) {
      return err(
        errors.badRequest(`Addon package contains an unsafe path: ${rawName}`),
      );
    }
    // The declared size was already checked; this guards against an archive
    // whose central directory understates what the entry actually inflates to.
    if (content.byteLength > MAX_ENTRY_BYTES) {
      return err(
        errors.payloadTooLarge(
          `Addon package entry "${name}" exceeds ${MAX_ENTRY_BYTES} bytes`,
        ),
      );
    }
    // Distinct raw names can normalise to the same path ("a" and "./a"); the
    // last one would otherwise silently replace the first, which is a way to
    // hide the real content of an entry from anyone reading the archive.
    if (files.has(name)) {
      return err(
        errors.badRequest(
          `Addon package contains duplicate entries for "${name}"`,
        ),
      );
    }
    files.set(name, content);
  }

  const manifestBytes = files.get(MANIFEST_FILENAME);
  if (manifestBytes === undefined) {
    return err(
      errors.badRequest(
        `Addon package must contain ${MANIFEST_FILENAME} at the archive root`,
      ),
    );
  }

  const manifestJson = parseJsonText(new TextDecoder().decode(manifestBytes));
  if (manifestJson.ok === false) {
    return err(
      errors.badRequest(`${MANIFEST_FILENAME}: ${manifestJson.error}`),
    );
  }
  const manifest = parseAddonManifest(manifestJson.value);
  if (manifest.ok === false) {
    return err(errors.badRequest(manifest.error));
  }
  if (manifest.value.entry === null) {
    return err(
      errors.badRequest(
        `${MANIFEST_FILENAME} must declare an "entry" module for uploaded addons`,
      ),
    );
  }
  const entryName = normalizeEntryName(manifest.value.entry);
  if (entryName === null || files.has(entryName) === false) {
    return err(
      errors.badRequest(
        `Entry module "${manifest.value.entry}" is missing from the addon package`,
      ),
    );
  }

  return ok({ manifest: manifest.value, files });
}

export interface InstallAddonOptions {
  readonly addonsDir: string;
  readonly archive: Uint8Array;
  readonly installedAt: number;
  readonly installedBy: string | null;
}

export interface InstallParsedAddonOptions {
  readonly addonsDir: string;
  readonly package: AddonPackage;
  readonly installedAt: number;
  readonly installedBy: string | null;
}

/**
 * Unpacks an already-parsed package into `<addonsDir>/<name>/` and returns the
 * record to persist. Any partially written directory is removed on failure.
 *
 * This call is destructive: it replaces `<addonsDir>/<name>/` wholesale.
 * Callers must therefore reject a name collision with an installed addon
 * *before* invoking it; by the time it runs, any directory under that name is
 * an orphan left behind by a previous failure.
 */
export async function installParsedAddonPackage(
  options: InstallParsedAddonOptions,
): Promise<Result<InstalledAddonRecord, AppError>> {
  const { manifest, files } = options.package;
  const targetDir = join(options.addonsDir, manifest.name);

  try {
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    for (const [name, content] of files) {
      const absolute = join(targetDir, ...name.split("/"));
      if (absolute.startsWith(targetDir + sep) === false) {
        throw new Error(
          `Refusing to write outside the addon directory: ${name}`,
        );
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    return err(
      errors.internal(
        `Failed to install addon package: ${getErrorMessage(error)}`,
      ),
    );
  }

  const entry = manifest.entry ?? MANIFEST_FILENAME;
  return ok({
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description,
    entryPath: `${manifest.name}/${entry}`,
    manifest: manifestToJson(manifest),
    installedAt: options.installedAt,
    installedBy: options.installedBy,
  });
}

/** Parses an archive and installs it. See `installParsedAddonPackage`. */
export async function installAddonPackage(
  options: InstallAddonOptions,
): Promise<Result<InstalledAddonRecord, AppError>> {
  const parsed = readAddonPackage(options.archive);
  if (parsed.ok === false) {
    return err(parsed.error);
  }
  return installParsedAddonPackage({
    addonsDir: options.addonsDir,
    package: parsed.value,
    installedAt: options.installedAt,
    installedBy: options.installedBy,
  });
}

/** Removes an installed addon's files from disk. */
export async function removeAddonFiles(
  addonsDir: string,
  addonName: string,
): Promise<void> {
  await rm(join(addonsDir, addonName), { recursive: true, force: true });
}
