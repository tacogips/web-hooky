import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { AppErrorKind } from "../core/errors";
import { hmacSha256Base64, hmacSha256Hex } from "../core/ids";
import { AddonKind, AddonSource } from "../storage/types";
import { githubAddon } from "./builtin/github";
import { envelopeAddon } from "./builtin/envelope";
import { passthroughAddon } from "./builtin/passthrough";
import { BUILTIN_ADDONS } from "./builtin/registry";
import { wrikeAddon } from "./builtin/wrike";
import { loadInstalledAddon } from "./loader";
import { isValidAddonName, parseAddonManifest } from "./manifest";
import { installAddonPackage, readAddonPackage } from "./package";
import { createAddonRegistry } from "./registry";
import type {
  AddonRequestContext,
  AddonTransformContext,
  LoadedAddon,
} from "./types";

const encoder = new TextEncoder();

function requestContext(
  overrides: Partial<AddonRequestContext> = {},
): AddonRequestContext {
  return {
    method: "POST",
    headers: {},
    rawBody: "{}",
    config: {},
    destinationId: "dest-1",
    addonName: "wrike",
    receivedAt: 1000,
    ...overrides,
  };
}

describe("addon manifest", () => {
  test("accepts valid names only", () => {
    expect(isValidAddonName("wrike")).toBe(true);
    expect(isValidAddonName("my-addon-2")).toBe(true);
    expect(isValidAddonName("_admin")).toBe(false);
    expect(isValidAddonName("Wrike")).toBe(false);
    expect(isValidAddonName("-leading")).toBe(false);
    expect(isValidAddonName("")).toBe(false);
  });

  test("parses a complete manifest", () => {
    const parsed = parseAddonManifest({
      name: "sample",
      version: "2.0.0",
      kind: "both",
      description: "example",
      entry: "addon.js",
      acceptsSchema: { type: "object" },
      returnsSchema: { type: "object" },
      configSchema: { type: "object" },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kind).toBe(AddonKind.Both);
      expect(parsed.value.entry).toBe("addon.js");
    }
  });

  test("defaults optional fields", () => {
    const parsed = parseAddonManifest({ name: "sample" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kind).toBe(AddonKind.Vendor);
      expect(parsed.value.version).toBe("0.0.0");
      expect(parsed.value.entry).toBeNull();
      expect(parsed.value.acceptsSchema).toBe(true);
    }
  });

  test("rejects an invalid kind and unsupported schemas", () => {
    expect(parseAddonManifest({ name: "a", kind: "weird" }).ok).toBe(false);
    expect(
      parseAddonManifest({ name: "a", acceptsSchema: { $ref: "#/x" } }).ok,
    ).toBe(false);
  });
});

describe("addon registry", () => {
  test("enforces unique names server-wide", () => {
    const registry = createAddonRegistry(BUILTIN_ADDONS);
    const duplicate: LoadedAddon = {
      ...passthroughAddon,
      source: AddonSource.Installed,
    };
    const result = registry.register(duplicate);
    expect(result.ok).toBe(false);
  });

  test("refuses to be built with a duplicate name", () => {
    const duplicate: LoadedAddon = {
      ...passthroughAddon,
      source: AddonSource.Installed,
    };
    expect(() => createAddonRegistry([...BUILTIN_ADDONS, duplicate])).toThrow();
  });

  test("resolves addons by role", () => {
    const registry = createAddonRegistry(BUILTIN_ADDONS);
    expect(registry.requireVendor("wrike").ok).toBe(true);
    expect(registry.requireDestination("wrike").ok).toBe(false);
    expect(registry.requireDestination("envelope").ok).toBe(true);
    expect(registry.requireVendor("envelope").ok).toBe(false);
    expect(registry.requireVendor("passthrough").ok).toBe(true);
    expect(registry.requireDestination("passthrough").ok).toBe(true);
    expect(registry.requireVendor("missing").ok).toBe(false);
  });

  test("built-in addons cannot be unregistered", () => {
    const registry = createAddonRegistry(BUILTIN_ADDONS);
    expect(registry.unregister("wrike")).toBe(false);
    expect(registry.has("wrike")).toBe(true);
  });

  test("lists addons alphabetically", () => {
    const registry = createAddonRegistry(BUILTIN_ADDONS);
    const names = registry.list().map((addon) => addon.manifest.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("wrike addon", () => {
  test("accepts a hex signature in X-Hook-Signature", async () => {
    const body = JSON.stringify([{ eventType: "TaskCreated" }]);
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: { "x-hook-signature": await hmacSha256Hex("shhh", body) },
      }),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.respondWith).toBeUndefined();
    }
  });

  test("accepts a base64 signature in X-Hook-Signature", async () => {
    const body = JSON.stringify([{ eventType: "TaskCreated" }]);
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: { "x-hook-signature": await hmacSha256Base64("shhh", body) },
      }),
    );
    expect(result?.ok).toBe(true);
  });

  test("rejects a body HMAC sent only in X-Hook-Secret", async () => {
    // X-Hook-Secret is the handshake challenge, never the delivery signature:
    // a request that carries the correct HMAC there and nothing in
    // X-Hook-Signature must not authenticate.
    const body = JSON.stringify([{ eventType: "TaskCreated" }]);
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: {
          "x-hook-secret": await hmacSha256Base64("shhh", body),
        },
      }),
    );
    expect(result?.ok).toBe(false);
    if (result !== undefined && result.ok === false) {
      expect(result.status).toBe(401);
    }
  });

  test("rejects a wrong signature", async () => {
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: "{}",
        config: { secret: "shhh" },
        headers: { "x-hook-signature": "not-the-signature" },
      }),
    );
    expect(result?.ok).toBe(false);
    if (result !== undefined && result.ok === false) {
      expect(result.status).toBe(401);
    }
  });

  test("rejects a missing signature header", async () => {
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({ config: { secret: "shhh" } }),
    );
    expect(result?.ok).toBe(false);
  });

  test("reports a misconfigured destination as a server error", async () => {
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({ headers: { "x-hook-signature": "x" } }),
    );
    expect(result?.ok).toBe(false);
    if (result !== undefined && result.ok === false) {
      expect(result.status).toBe(500);
    }
  });

  test("answers the secure-webhook verification handshake", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const challenge = "cGpBc2RmMTIzNA";
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: {
          "x-hook-signature": await hmacSha256Hex("shhh", body),
          "x-hook-secret": challenge,
        },
      }),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.respondWith?.status).toBe(200);
      expect(result.respondWith?.headers["x-hook-secret"]).toBe(
        await hmacSha256Hex("shhh", challenge),
      );
    }
  });

  test("echoes the handshake reply in the encoding the signature used", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const challenge = "cGpBc2RmMTIzNA";
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: {
          "x-hook-signature": await hmacSha256Base64("shhh", body),
          "x-hook-secret": challenge,
        },
      }),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.respondWith?.headers["x-hook-secret"]).toBe(
        await hmacSha256Base64("shhh", challenge),
      );
    }
  });

  test("rejects an unsigned verification handshake", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: { "x-hook-secret": "cGpBc2RmMTIzNA" },
      }),
    );
    expect(result?.ok).toBe(false);
  });

  test("rejects a verification handshake without a challenge value", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: { "x-hook-signature": await hmacSha256Hex("shhh", body) },
      }),
    );
    expect(result?.ok).toBe(false);
    if (result !== undefined && result.ok === false) {
      expect(result.status).toBe(400);
    }
  });

  test("refuses to sign a handshake challenge containing JSON", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    // The forged delivery body the attacker wants a signature for.
    const forged = JSON.stringify([
      { eventType: "TaskCreated", taskId: "attacker" },
    ]);
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: {
          // The body signature is genuine; only the challenge is hostile.
          "x-hook-signature": await hmacSha256Hex("shhh", body),
          "x-hook-secret": forged,
        },
      }),
    );
    expect(result?.ok).toBe(false);
    if (result !== undefined && result.ok === false) {
      expect(result.status).toBe(400);
    }
  });

  test("refuses to sign a handshake challenge longer than 100 characters", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: {
          "x-hook-signature": await hmacSha256Hex("shhh", body),
          "x-hook-secret": "a".repeat(101),
        },
      }),
    );
    expect(result?.ok).toBe(false);
    if (result !== undefined && result.ok === false) {
      expect(result.status).toBe(400);
    }
  });

  test("still signs a challenge of exactly the permitted length", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const challenge = "a".repeat(100);
    const result = await wrikeAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "shhh" },
        headers: {
          "x-hook-signature": await hmacSha256Hex("shhh", body),
          "x-hook-secret": challenge,
        },
      }),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.respondWith?.headers["x-hook-secret"]).toBe(
        await hmacSha256Hex("shhh", challenge),
      );
    }
  });

  test("normalises single events into an array", () => {
    const transformed = wrikeAddon.module.transform?.(
      { eventType: "TaskCreated" },
      {
        headers: {},
        config: {},
        destinationId: "dest-1",
        addonName: "wrike",
        receivedAt: 42,
      },
    );
    expect(transformed).toEqual({
      source: "wrike",
      receivedAt: 42,
      events: [{ eventType: "TaskCreated" }],
    });
  });
});

describe("github addon", () => {
  test("verifies the sha256 signature header", async () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${await hmacSha256Hex("gh", body)}`;
    const accepted = await githubAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "gh" },
        headers: { "x-hub-signature-256": signature },
      }),
    );
    expect(accepted?.ok).toBe(true);

    const rejected = await githubAddon.module.authenticate?.(
      requestContext({
        rawBody: body,
        config: { secret: "gh" },
        headers: { "x-hub-signature-256": "sha256=deadbeef" },
      }),
    );
    expect(rejected?.ok).toBe(false);
  });
});

describe("envelope addon", () => {
  test("wraps the payload with the configured label", () => {
    const wrapped = envelopeAddon.module.transform?.(
      { a: 1 },
      {
        headers: {},
        config: { label: "team-a" },
        destinationId: "dest-1",
        addonName: "envelope",
        receivedAt: 7,
      },
    );
    expect(wrapped).toEqual({ label: "team-a", receivedAt: 7, data: { a: 1 } });
  });
});

describe("addon packages", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "web-hooky-addon-"));
    dirs.push(dir);
    return dir;
  }

  function buildArchive(files: Readonly<Record<string, string>>): Uint8Array {
    const entries: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(files)) {
      entries[name] = encoder.encode(content);
    }
    return zipSync(entries);
  }

  function transformContext(addonName: string): AddonTransformContext {
    return {
      headers: {},
      config: {},
      destinationId: "d",
      addonName,
      receivedAt: 1,
    };
  }

  const manifest = JSON.stringify({
    name: "sample-addon",
    version: "1.0.0",
    kind: "vendor",
    description: "test addon",
    entry: "addon.js",
    acceptsSchema: { type: "object" },
    returnsSchema: { type: "object" },
  });

  const entryModule = `export function transform(input) {
    return { wrapped: input };
  }`;

  test("reads a well formed package", () => {
    const parsed = readAddonPackage(
      buildArchive({ "addon.json": manifest, "addon.js": entryModule }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.manifest.name).toBe("sample-addon");
    }
  });

  test("rejects an archive without a manifest", () => {
    const parsed = readAddonPackage(buildArchive({ "addon.js": entryModule }));
    expect(parsed.ok).toBe(false);
  });

  test("rejects a missing entry module", () => {
    const parsed = readAddonPackage(buildArchive({ "addon.json": manifest }));
    expect(parsed.ok).toBe(false);
  });

  test("normalises redundant ./ path segments", () => {
    const parsed = readAddonPackage(
      buildArchive({ "./addon.json": manifest, "./addon.js": entryModule }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect([...parsed.value.files.keys()].sort()).toEqual([
        "addon.js",
        "addon.json",
      ]);
    }
  });

  test("rejects path traversal entries", () => {
    const parsed = readAddonPackage(
      buildArchive({
        "addon.json": manifest,
        "addon.js": entryModule,
        "../escape.js": "bad",
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  test("rejects an empty archive", () => {
    expect(readAddonPackage(new Uint8Array()).ok).toBe(false);
  });

  test("rejects data that is not a zip archive", () => {
    expect(readAddonPackage(encoder.encode("definitely not a zip")).ok).toBe(
      false,
    );
  });

  test("installs and loads a package", async () => {
    const addonsDir = await tempDir();
    const installed = await installAddonPackage({
      addonsDir,
      archive: buildArchive({
        "addon.json": manifest,
        "addon.js": entryModule,
      }),
      installedAt: 100,
      installedBy: "admin",
    });
    expect(installed.ok).toBe(true);
    if (installed.ok === false) {
      return;
    }
    expect(installed.value.entryPath).toBe("sample-addon/addon.js");

    const loaded = await loadInstalledAddon(addonsDir, installed.value);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.source).toBe(AddonSource.Installed);
      const output = await loaded.value.module.transform?.(
        { a: 1 },
        {
          headers: {},
          config: {},
          destinationId: "d",
          addonName: "sample-addon",
          receivedAt: 1,
        },
      );
      expect(output).toEqual({ wrapped: { a: 1 } });
    }
  });

  test("rejects entries whose declared size exceeds the entry limit", () => {
    // Compressible filler: the archive stays tiny while the central directory
    // declares far more than MAX_ENTRY_BYTES, which is what the reader has to
    // refuse before anything is inflated.
    const filler = new Uint8Array(3 * 1024 * 1024);
    const parsed = readAddonPackage(
      zipSync({
        "addon.json": encoder.encode(manifest),
        "addon.js": encoder.encode(entryModule),
        "filler.bin": filler,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.error.kind).toBe(AppErrorKind.PayloadTooLarge);
    }
  });

  test("rejects entries that together exceed the decompressed total", () => {
    const filler = new Uint8Array(1_800_000);
    const entries: Record<string, Uint8Array> = {
      "addon.json": encoder.encode(manifest),
      "addon.js": encoder.encode(entryModule),
    };
    for (let index = 0; index < 10; index += 1) {
      entries[`filler-${index}.bin`] = filler;
    }
    const parsed = readAddonPackage(zipSync(entries));
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.error.kind).toBe(AppErrorKind.PayloadTooLarge);
    }
  });

  test("rejects entries whose names normalise to the same path", () => {
    const parsed = readAddonPackage(
      buildArchive({
        "addon.json": manifest,
        "addon.js": entryModule,
        "./addon.js": "export function transform() { return null; }",
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.error.kind).toBe(AppErrorKind.BadRequest);
      expect(parsed.error.message).toContain("addon.js");
    }
  });

  test("keeps hooks split across named and default exports", async () => {
    const addonsDir = await tempDir();
    const installed = await installAddonPackage({
      addonsDir,
      archive: buildArchive({
        "addon.json": manifest,
        "addon.js": `export function authenticate() {
          return { ok: false, status: 401, message: "nope" };
        }
        export default {
          transform(input) {
            return { wrapped: input };
          },
        };`,
      }),
      installedAt: 100,
      installedBy: null,
    });
    expect(installed.ok).toBe(true);
    if (installed.ok === false) {
      return;
    }

    const loaded = await loadInstalledAddon(addonsDir, installed.value);
    expect(loaded.ok).toBe(true);
    if (loaded.ok === false) {
      return;
    }
    // A dropped authenticate would leave the destination unauthenticated.
    const auth = await loaded.value.module.authenticate?.(
      requestContext({ addonName: "sample-addon" }),
    );
    expect(auth?.ok).toBe(false);
    expect(
      await loaded.value.module.transform?.(
        { a: 1 },
        transformContext("sample-addon"),
      ),
    ).toEqual({ wrapped: { a: 1 } });
  });

  test("loads the new code when an addon is reinstalled under one name", async () => {
    const addonsDir = await tempDir();

    async function installVersion(version: number): Promise<void> {
      const installed = await installAddonPackage({
        addonsDir,
        archive: buildArchive({
          "addon.json": manifest,
          "addon.js": `export function transform(input) {
            return { version: ${version}, input };
          }`,
        }),
        installedAt: 100 + version,
        installedBy: null,
      });
      expect(installed.ok).toBe(true);
      if (installed.ok === false) {
        return;
      }
      const loaded = await loadInstalledAddon(addonsDir, installed.value);
      expect(loaded.ok).toBe(true);
      if (loaded.ok === false) {
        return;
      }
      // The module specifier is the same path both times, so a cache keyed on
      // the path alone would answer the second load with the first version.
      expect(
        await loaded.value.module.transform?.(
          { a: 1 },
          transformContext("sample-addon"),
        ),
      ).toEqual({ version, input: { a: 1 } });
    }

    await installVersion(1);
    await installVersion(2);

    // Reloading may import through a throwaway copy; it must not survive.
    expect((await readdir(join(addonsDir, "sample-addon"))).sort()).toEqual([
      "addon.js",
      "addon.json",
    ]);
  });

  test("reports a module without hooks", async () => {
    const addonsDir = await tempDir();
    const installed = await installAddonPackage({
      addonsDir,
      archive: buildArchive({
        "addon.json": manifest,
        "addon.js": "export const unrelated = 1;",
      }),
      installedAt: 100,
      installedBy: null,
    });
    expect(installed.ok).toBe(true);
    if (installed.ok === false) {
      return;
    }
    const loaded = await loadInstalledAddon(addonsDir, installed.value);
    expect(loaded.ok).toBe(false);
  });
});
