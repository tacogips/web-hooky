/**
 * Loader for installed addon packages.
 *
 * Uses dynamic `import()`, which requires a runtime with filesystem module
 * loading (Bun, Node). Serverless targets that forbid it must ship addons in
 * the deployment bundle; see `design-docs/specs/notes.md`.
 */
import { copyFile, readFile, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type AppError, errors } from "../core/errors";
import { bytesToHex } from "../core/ids";
import { err, getErrorMessage, ok, type Result } from "../core/result";
import { AddonSource, type InstalledAddonRecord } from "../storage/types";
import { parseAddonManifest } from "./manifest";
import type { AddonModule, LoadedAddon } from "./types";

interface ImportedModule {
  readonly default?: unknown;
  readonly authenticate?: unknown;
  readonly transform?: unknown;
}

type AuthenticateHook = NonNullable<AddonModule["authenticate"]>;
type TransformHook = NonNullable<AddonModule["transform"]>;

/** Reads the hook functions carried by one exported object. */
function collectHooks(candidate: unknown): AddonModule {
  if (typeof candidate !== "object" || candidate === null) {
    return {};
  }
  const record = candidate as Record<string, unknown>;
  const authenticate = record["authenticate"];
  const transform = record["transform"];
  return {
    ...(typeof authenticate === "function"
      ? { authenticate: authenticate as AuthenticateHook }
      : {}),
    ...(typeof transform === "function"
      ? { transform: transform as TransformHook }
      : {}),
  };
}

/**
 * Merges the hooks found on the default export with those exported by name.
 *
 * Both sources are always consulted: an addon may export `authenticate` by name
 * and a default object holding only `transform`. Stopping at the first object
 * that carries any hook would drop the other one, and a dropped `authenticate`
 * silently turns the destination into an unauthenticated endpoint, because the
 * pipeline reads a missing hook as "no authentication required".
 *
 * When both sources define the same hook the default export wins, matching the
 * precedence the loader has always applied.
 */
function extractModule(imported: ImportedModule): AddonModule | null {
  const merged: AddonModule = {
    ...collectHooks(imported),
    ...collectHooks(imported.default),
  };
  if (merged.authenticate === undefined && merged.transform === undefined) {
    return null;
  }
  return merged;
}

/** Content digest of the entry module. */
async function entryDigest(entryFile: string): Promise<string> {
  const contents = await readFile(entryFile);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(contents),
  );
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

/** Digest of the entry file each already-imported path was loaded from. */
const importedEntries = new Map<string, string>();

let reloadCounter = 0;

/**
 * Imports the entry module, reloading it when the file changed since the last
 * import from the same path.
 *
 * `import()` caches by specifier for the lifetime of the process and neither
 * Bun nor Node lets that cache be invalidated, so uninstalling an addon and
 * installing a different package under the same name would keep running the
 * old code while the registry advertises the new manifest and schemas. A query
 * string does not help: Bun resolves `file:` specifiers to the path and ignores
 * anything after it.
 *
 * Changed contents are therefore imported through a throwaway copy next to the
 * original, which the runtime treats as a separate module. The copy lives in
 * the addon's own directory so that relative imports inside the entry resolve
 * exactly as they would for the real file, and it is removed once the import
 * has been compiled. Only this first load is fresh: sibling modules the entry
 * imports by relative path keep whatever the cache already holds for them.
 */
async function importAddonEntry(
  entryFile: string,
  digest: string,
): Promise<unknown> {
  const previous = importedEntries.get(entryFile);
  if (previous === undefined || previous === digest) {
    const imported: unknown = await import(pathToFileURL(entryFile).href);
    importedEntries.set(entryFile, digest);
    return imported;
  }

  reloadCounter += 1;
  const copy = join(
    dirname(entryFile),
    `.reload-${digest}-${reloadCounter}${extname(entryFile)}`,
  );
  await copyFile(entryFile, copy);
  try {
    const imported: unknown = await import(pathToFileURL(copy).href);
    importedEntries.set(entryFile, digest);
    return imported;
  } finally {
    await rm(copy, { force: true }).catch(() => undefined);
  }
}

/** Loads one installed addon from disk. */
export async function loadInstalledAddon(
  addonsDir: string,
  record: InstalledAddonRecord,
): Promise<Result<LoadedAddon, AppError>> {
  const manifest = parseAddonManifest(record.manifest);
  if (manifest.ok === false) {
    return err(
      errors.internal(
        `Stored manifest for addon "${record.name}" is invalid: ${manifest.error}`,
      ),
    );
  }

  if (isAbsolute(record.entryPath)) {
    return err(
      errors.internal(`Addon "${record.name}" has an absolute entry path`),
    );
  }
  const root = resolve(addonsDir);
  const entryFile = resolve(join(root, record.entryPath));
  if (entryFile.startsWith(`${root}${sep}`) === false) {
    return err(
      errors.internal(
        `Addon "${record.name}" entry path escapes the addons directory`,
      ),
    );
  }

  try {
    // Only the validated path is ever read or imported; the reload copy the
    // import may go through is derived from it, not from caller input.
    const digest = await entryDigest(entryFile);
    const imported = (await importAddonEntry(
      entryFile,
      digest,
    )) as ImportedModule;
    const addonModule = extractModule(imported);
    if (addonModule === null) {
      return err(
        errors.internal(
          `Addon "${record.name}" does not export authenticate or transform`,
        ),
      );
    }
    return ok({
      manifest: manifest.value,
      module: addonModule,
      source: AddonSource.Installed,
    });
  } catch (error) {
    return err(
      errors.internal(
        `Failed to load addon "${record.name}": ${getErrorMessage(error)}`,
      ),
    );
  }
}
