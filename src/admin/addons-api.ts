/**
 * Admin API handlers for addon listing, package upload and removal.
 */
import { loadInstalledAddon } from "../addons/loader";
import {
  type AddonPackage,
  installParsedAddonPackage,
  MAX_ARCHIVE_BYTES,
  readAddonPackage,
  removeAddonFiles,
} from "../addons/package";
import { createKeyedLock } from "../core/async";
import { type AppError, errors } from "../core/errors";
import { err, getErrorMessage, ok, type Result } from "../core/result";
import type { AppContext } from "../server/context";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
} from "../server/responses";
import { AddonSource } from "../storage/types";
import type { AdminPrincipal } from "./auth";
import { loadedAddonToJson } from "./helpers";

const ZIP_CONTENT_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

/**
 * Allowance for multipart framing (boundary lines and part headers) on top of
 * the archive itself, so a package of exactly `MAX_ARCHIVE_BYTES` still fits.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const TOO_LARGE_MESSAGE = `Addon package exceeds ${MAX_ARCHIVE_BYTES} bytes`;

/**
 * Buffers the request body, refusing anything over `limit`.
 *
 * `arrayBuffer()` and `formData()` read the whole body into memory before the
 * package limits can be applied, so an admin credential would be enough to
 * force an arbitrarily large allocation. The declared length is checked first
 * when the client sends one, and the stream is abandoned as soon as the bytes
 * read pass the limit for clients that do not.
 */
async function readBodyWithLimit(
  request: Request,
  limit: number,
): Promise<Result<Uint8Array, AppError>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isInteger(length) === false || length < 0) {
      return err(errors.badRequest("Invalid Content-Length header"));
    }
    if (length > limit) {
      return err(errors.payloadTooLarge(TOO_LARGE_MESSAGE));
    }
  }

  const body = request.body;
  if (body === null) {
    return ok(new Uint8Array());
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return err(errors.payloadTooLarge(TOO_LARGE_MESSAGE));
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    return err(
      errors.badRequest(
        `Failed to read upload body: ${getErrorMessage(error)}`,
      ),
    );
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(buffer);
}

/**
 * Reads the uploaded archive from either a `multipart/form-data` field named
 * `package` or a raw request body.
 */
async function readArchive(
  request: Request,
): Promise<Result<Uint8Array, AppError>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const body = await readBodyWithLimit(
      request,
      MAX_ARCHIVE_BYTES + MULTIPART_OVERHEAD_BYTES,
    );
    if (body.ok === false) {
      return err(body.error);
    }
    // Parsing the capped bytes instead of the live request keeps the platform
    // multipart parser from buffering an unbounded body itself.
    let form: FormData;
    try {
      form = await new Response(body.value, {
        headers: { "content-type": contentType },
      }).formData();
    } catch (error) {
      return err(
        errors.badRequest(
          `Malformed multipart upload: ${getErrorMessage(error)}`,
        ),
      );
    }
    const file = form.get("package");
    if (file === null || typeof file === "string") {
      return err(
        errors.badRequest(
          'Multipart upload must include a "package" file field',
        ),
      );
    }
    return ok(new Uint8Array(await file.arrayBuffer()));
  }
  const baseType = contentType.split(";")[0]?.trim() ?? "";
  if (baseType.length > 0 && ZIP_CONTENT_TYPES.has(baseType) === false) {
    return err(
      errors.badRequest(
        `Unsupported content type "${baseType}"; expected a zip archive`,
      ),
    );
  }
  return readBodyWithLimit(request, MAX_ARCHIVE_BYTES);
}

/**
 * Serialises installation per addon name.
 *
 * The conflict check, the install and the registration are separate awaits, so
 * two overlapping uploads of the same name could both pass the check; the loser
 * would then overwrite the winner's directory and, on its own cleanup path,
 * delete it. The key includes the addons directory because the lock is
 * process-wide and several runtimes (tests, embedded use) can coexist.
 */
const installLock = createKeyedLock();

async function installUploadedAddon(
  ctx: AppContext,
  parsedPackage: AddonPackage,
  principal: AdminPrincipal,
): Promise<Response> {
  const name = parsedPackage.manifest.name;

  if (ctx.registry.has(name)) {
    return errorResponse(
      errors.conflict(`Addon "${name}" is already registered`),
    );
  }
  // An addons row without a registry entry means a previously installed addon
  // failed to load at startup. Overwriting it silently would hide the failure,
  // so the operator must remove it first.
  if ((await ctx.persistence.addons.findByName(name)) !== null) {
    return errorResponse(
      errors.conflict(
        `Addon "${name}" is already installed but failed to load; remove it first`,
      ),
    );
  }

  const installed = await installParsedAddonPackage({
    addonsDir: ctx.config.addonsDir,
    package: parsedPackage,
    installedAt: ctx.clock.nowSeconds(),
    installedBy: principal.subject,
  });
  if (installed.ok === false) {
    return errorResponse(installed.error);
  }

  const record = installed.value;
  const loaded = await loadInstalledAddon(ctx.config.addonsDir, record);
  if (loaded.ok === false) {
    await removeAddonFiles(ctx.config.addonsDir, record.name);
    return errorResponse(loaded.error);
  }

  const registered = ctx.registry.register(loaded.value);
  if (registered.ok === false) {
    await removeAddonFiles(ctx.config.addonsDir, record.name);
    return errorResponse(registered.error);
  }

  try {
    await ctx.persistence.addons.create(record);
  } catch (error) {
    ctx.registry.unregister(record.name);
    await removeAddonFiles(ctx.config.addonsDir, record.name);
    return errorResponse(
      errors.internal(`Failed to record addon: ${getErrorMessage(error)}`),
    );
  }

  return jsonResponse(loadedAddonToJson(loaded.value), 201);
}

async function uploadAddon(
  ctx: AppContext,
  request: Request,
  principal: AdminPrincipal,
): Promise<Response> {
  const archive = await readArchive(request);
  if (archive.ok === false) {
    return errorResponse(archive.error);
  }

  // The archive is parsed and the name conflict resolved before anything is
  // written: installation replaces `<addonsDir>/<name>/` wholesale, so a
  // conflict discovered afterwards would have already destroyed the files of
  // the addon that legitimately owns that name.
  const parsed = readAddonPackage(archive.value);
  if (parsed.ok === false) {
    return errorResponse(parsed.error);
  }

  return installLock.run(
    `${ctx.config.addonsDir}\u0000${parsed.value.manifest.name}`,
    () => installUploadedAddon(ctx, parsed.value, principal),
  );
}

async function deleteAddon(ctx: AppContext, name: string): Promise<Response> {
  const addon = ctx.registry.get(name);
  if (addon === null) {
    // Recovery path for an installed addon that failed to load at startup: the
    // row exists but nothing is registered, and without this the operator could
    // neither use nor replace the name.
    const orphan = await ctx.persistence.addons.findByName(name);
    if (orphan === null) {
      return errorResponse(errors.notFound(`Unknown addon "${name}"`));
    }
    await ctx.persistence.addons.delete(name);
    await removeAddonFiles(ctx.config.addonsDir, name);
    return noContentResponse();
  }
  if (addon.source === AddonSource.Builtin) {
    return errorResponse(
      errors.badRequest(`Built-in addon "${name}" cannot be removed`),
    );
  }
  const usage = await ctx.persistence.destinations.countUsingAddon(name);
  if (usage > 0) {
    return errorResponse(
      errors.conflict(
        `Addon "${name}" is used by ${usage} destination(s); remove them first`,
      ),
    );
  }
  ctx.registry.unregister(name);
  await ctx.persistence.addons.delete(name);
  await removeAddonFiles(ctx.config.addonsDir, name);
  return noContentResponse();
}

/** Routes `/_admin/api/addons...`. */
export async function handleAddonsApi(
  ctx: AppContext,
  request: Request,
  segments: readonly string[],
  principal: AdminPrincipal,
): Promise<Response> {
  const [, name] = segments;

  if (name === undefined) {
    if (request.method === "GET") {
      return jsonResponse({
        addons: ctx.registry.list().map(loadedAddonToJson),
      });
    }
    if (request.method === "POST") {
      if (ctx.canInstallAddons === false) {
        return errorResponse(
          errors.notImplemented(
            "This deployment cannot install addon packages: it has no writable " +
              "filesystem and cannot import a module at runtime. Only built-in " +
              "addons are available; ship additional addons in the bundle.",
          ),
        );
      }
      return uploadAddon(ctx, request, principal);
    }
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  if (request.method === "GET") {
    const addon = ctx.registry.get(name);
    if (addon === null) {
      return errorResponse(errors.notFound(`Unknown addon "${name}"`));
    }
    return jsonResponse(loadedAddonToJson(addon));
  }
  if (request.method === "DELETE") {
    return deleteAddon(ctx, name);
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}
