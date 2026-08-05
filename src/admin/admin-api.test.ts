/**
 * Admin API surface tests: full parity with the admin UI capabilities.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { zipSync } from "fflate";
import { AddonKind } from "../storage/types";
import {
  createDestination,
  createHarness,
  type CreatedDestination,
  type Harness,
  TEST_ADMIN_CREDENTIAL,
} from "../test-support/harness";

interface DestinationListing {
  readonly destinations: readonly {
    readonly id: string;
    readonly name: string;
    readonly fetchUuid: string;
    readonly inboundPath: string;
  }[];
}

interface AddonListing {
  readonly addons: readonly {
    readonly name: string;
    readonly source: string;
    readonly kind: string;
  }[];
}

interface UserListing {
  readonly users: readonly {
    readonly id: string;
    readonly grants: readonly string[];
  }[];
}

interface KeyListing {
  readonly keys: readonly { readonly id: string; readonly label: string }[];
}

interface AdminUserListing {
  readonly adminUsers: readonly { readonly subject: string }[];
}

const encoder = new TextEncoder();

function sampleAddonArchive(name: string, marker = "uploaded"): Uint8Array {
  return zipSync({
    "addon.json": encoder.encode(
      JSON.stringify({
        name,
        version: "1.0.0",
        kind: "vendor",
        description: "uploaded sample",
        entry: "addon.js",
        acceptsSchema: { type: "object" },
        returnsSchema: { type: "object" },
      }),
    ),
    // The marker identifies which archive produced the installed files.
    "addon.js": encoder.encode(
      `export function transform(input) { return { ${marker}: input }; }`,
    ),
  });
}

describe("admin API", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("rejects unauthenticated requests", async () => {
    const response = await harness.request("/_admin/api/destinations");
    expect(response.status).toBe(401);
  });

  test("rejects an invalid admin key", async () => {
    const response = await harness.request("/_admin/api/destinations", {
      headers: { authorization: "Bearer test-admin-key:wrong" },
    });
    expect(response.status).toBe(401);
  });

  test("a stray bearer credential falls through to the identity provider", async () => {
    // A browser that still holds an old `Authorization` header must not lose
    // access to an origin whose IdP authenticates it perfectly well.
    const idp = await createHarness({
      WEBHOOKY_ADMIN_AUTH: "dev",
      WEBHOOKY_ADMIN_SUBJECTS: "dev@localhost",
    });
    try {
      const response = await idp.request("/_admin/api/me", {
        headers: { authorization: "Bearer a:b" },
      });
      expect(response.status).toBe(200);
      const me = (await response.json()) as {
        subject: string;
        viaApiKey: boolean;
      };
      expect(me.viaApiKey).toBe(false);
      expect(me.subject).toBe("dev@localhost");
    } finally {
      await idp.close();
    }
  });

  test("reports an invalid key when no identity resolves either", async () => {
    const response = await harness.request("/_admin/api/me", {
      headers: { authorization: "Bearer stray:credential" },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Invalid admin API key");
  });

  test("rejects a malformed percent-encoded admin subject", async () => {
    const response = await harness.admin("/_admin/api/admin-users/%ZZ", {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
  });

  test("reports the authenticated principal", async () => {
    const me = await harness.adminJson<{
      subject: string;
      viaApiKey: boolean;
    }>("/_admin/api/me");
    expect(me.viaApiKey).toBe(true);
    expect(me.subject).toContain("admin-key:");
  });

  test("issues destinations and exposes their fetch uuid to admins only", async () => {
    const created = await createDestination(harness, {
      name: "issued",
      vendorAddon: "wrike",
      vendorConfig: { secret: "abc" },
    });
    expect(created.fetchUuid).not.toBe(created.inboundUuid);

    const listing = await harness.adminJson<DestinationListing>(
      "/_admin/api/destinations",
    );
    expect(listing.destinations).toHaveLength(1);
    expect(listing.destinations[0]?.inboundPath).toBe(
      `/wrike/${created.inboundUuid}`,
    );
  });

  test("validates the vendor addon configuration on creation", async () => {
    const response = await harness.admin("/_admin/api/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", vendorAddon: "wrike" }),
    });
    expect(response.status).toBe(400);
  });

  test("rejects an unknown vendor addon", async () => {
    const response = await harness.admin("/_admin/api/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", vendorAddon: "nope" }),
    });
    expect(response.status).toBe(404);
  });

  test("rejects a destination-only addon in the vendor role", async () => {
    const response = await harness.admin("/_admin/api/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", vendorAddon: "envelope" }),
    });
    expect(response.status).toBe(400);
  });

  test("patches, rotates and deletes a destination", async () => {
    const created = await createDestination(harness, {
      name: "mutable",
      vendorAddon: "passthrough",
    });

    const patched = await harness.adminJson<{ name: string; enabled: boolean }>(
      `/_admin/api/destinations/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed", enabled: false }),
      },
    );
    expect(patched.name).toBe("renamed");
    expect(patched.enabled).toBe(false);

    const rotated = await harness.adminJson<CreatedDestination>(
      `/_admin/api/destinations/${created.id}/rotate-fetch-uuid`,
      { method: "POST" },
    );
    expect(rotated.fetchUuid).not.toBe(created.fetchUuid);

    const deleted = await harness.admin(
      `/_admin/api/destinations/${created.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);

    const missing = await harness.admin(
      `/_admin/api/destinations/${created.id}`,
    );
    expect(missing.status).toBe(404);
  });

  test("a disabled destination refuses inbound webhooks", async () => {
    const created = await createDestination(harness, {
      name: "disabled",
      vendorAddon: "passthrough",
    });
    await harness.admin(`/_admin/api/destinations/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const response = await harness.request(
      `/passthrough/${created.inboundUuid}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(403);
  });

  test("registers fetch users, manages grants, and rotates secrets", async () => {
    const destination = await createDestination(harness, {
      name: "granted",
      vendorAddon: "passthrough",
    });
    const user = await harness.adminJson<{
      id: string;
      secret: string;
      credential: string;
    }>("/_admin/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "consumer" }),
    });
    expect(user.credential).toBe(`${user.id}:${user.secret}`);

    await harness.admin(
      `/_admin/api/users/${user.id}/grants/${destination.id}`,
      {
        method: "PUT",
      },
    );
    const listed = await harness.adminJson<UserListing>("/_admin/api/users");
    expect(listed.users[0]?.grants).toEqual([destination.id]);

    // The listing never includes the secret or its hash.
    const raw = await (await harness.admin("/_admin/api/users")).text();
    expect(raw).not.toContain(user.secret);

    const rotated = await harness.adminJson<{ secret: string }>(
      `/_admin/api/users/${user.id}/rotate`,
      { method: "POST" },
    );
    expect(rotated.secret).not.toBe(user.secret);

    // The old credential no longer works.
    const denied = await harness.request(`/_get/${destination.fetchUuid}`, {
      headers: { authorization: `Bearer ${user.credential}` },
    });
    expect(denied.status).toBe(401);

    await harness.admin(
      `/_admin/api/users/${user.id}/grants/${destination.id}`,
      { method: "DELETE" },
    );
    const afterRevoke =
      await harness.adminJson<UserListing>("/_admin/api/users");
    expect(afterRevoke.users[0]?.grants).toEqual([]);

    const removed = await harness.admin(`/_admin/api/users/${user.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
  });

  test("lists built-in addons", async () => {
    const listing = await harness.adminJson<AddonListing>("/_admin/api/addons");
    const names = listing.addons.map((addon) => addon.name);
    expect(names).toContain("wrike");
    expect(names).toContain("github");
    expect(names).toContain("passthrough");
    expect(names).toContain("envelope");
  });

  test("uploads, uses and removes an addon package", async () => {
    const uploaded = await harness.adminJson<{ name: string; source: string }>(
      "/_admin/api/addons",
      {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: sampleAddonArchive("uploaded-addon"),
      },
    );
    expect(uploaded.name).toBe("uploaded-addon");
    expect(uploaded.source).toBe("installed");

    const destination = await createDestination(harness, {
      name: "uses uploaded addon",
      vendorAddon: "uploaded-addon",
    });
    const accepted = await harness.request(
      `/uploaded-addon/${destination.inboundUuid}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      },
    );
    expect(accepted.status).toBe(202);

    // An addon in use cannot be removed.
    const inUse = await harness.admin("/_admin/api/addons/uploaded-addon", {
      method: "DELETE",
    });
    expect(inUse.status).toBe(409);

    await harness.admin(`/_admin/api/destinations/${destination.id}`, {
      method: "DELETE",
    });
    const removed = await harness.admin("/_admin/api/addons/uploaded-addon", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
  });

  test("re-uploading a name keeps the installed addon intact", async () => {
    await harness.adminJson("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: sampleAddonArchive("acme"),
    });
    const entryPath = join(harness.addonsDir, "acme", "addon.js");
    const originalEntry = await Bun.file(entryPath).text();

    const conflict = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: sampleAddonArchive("acme"),
    });
    expect(conflict.status).toBe(409);

    // The rejected upload must not have touched the installation it collided
    // with: the files, the registration and the loaded module all survive.
    expect(await Bun.file(entryPath).exists()).toBe(true);
    expect(await Bun.file(entryPath).text()).toBe(originalEntry);
    const listing = await harness.adminJson<AddonListing>("/_admin/api/addons");
    expect(listing.addons.map((addon) => addon.name)).toContain("acme");

    const destination = await createDestination(harness, {
      name: "acme destination",
      vendorAddon: "acme",
    });
    const accepted = await harness.request(`/acme/${destination.inboundUuid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(accepted.status).toBe(202);
  });

  test("concurrent uploads of the same name leave the winner installed", async () => {
    // Installation replaces `<addonsDir>/<name>/` wholesale and the loser's
    // cleanup deletes that directory, so overlapping uploads must be
    // serialised: otherwise the winner stays registered with no files on disk.
    const [first, second] = await Promise.all([
      harness.admin("/_admin/api/addons", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: sampleAddonArchive("racy", "alpha"),
      }),
      harness.admin("/_admin/api/addons", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: sampleAddonArchive("racy", "beta"),
      }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const winnerMarker = first.status === 201 ? "alpha" : "beta";
    const entry = await Bun.file(
      join(harness.addonsDir, "racy", "addon.js"),
    ).text();
    expect(entry).toContain(winnerMarker);

    const listing = await harness.adminJson<AddonListing>("/_admin/api/addons");
    expect(
      listing.addons.filter((addon) => addon.name === "racy"),
    ).toHaveLength(1);

    // The registration and the files agree, so the addon still works.
    const destination = await createDestination(harness, {
      name: "racy destination",
      vendorAddon: "racy",
    });
    const accepted = await harness.request(`/racy/${destination.inboundUuid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(accepted.status).toBe(202);
  });

  test("an addon row that failed to load can be replaced after removal", async () => {
    // Simulates a restart where the installed addon could not be imported: the
    // row exists but nothing is registered.
    await harness.runtime.context.persistence.addons.create({
      name: "ghost",
      version: "1.0.0",
      kind: AddonKind.Vendor,
      description: "unloadable",
      entryPath: "ghost/addon.js",
      manifest: {},
      installedAt: 1,
      installedBy: null,
    });

    const conflict = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: sampleAddonArchive("ghost"),
    });
    expect(conflict.status).toBe(409);

    const removed = await harness.admin("/_admin/api/addons/ghost", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);

    const reinstalled = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: sampleAddonArchive("ghost"),
    });
    expect(reinstalled.status).toBe(201);
  });

  test("rejects an addon whose name collides with a built-in", async () => {
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: sampleAddonArchive("wrike"),
    });
    expect(response.status).toBe(409);
  });

  test("rejects an unreadable addon archive", async () => {
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: encoder.encode("not a zip file"),
    });
    expect(response.status).toBe(400);
  });

  test("refuses to remove a built-in addon", async () => {
    const response = await harness.admin("/_admin/api/addons/wrike", {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
  });

  test("issues and revokes admin API keys", async () => {
    const issued = await harness.adminJson<{
      id: string;
      credential: string;
    }>("/_admin/api/admin-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "automation" }),
    });

    // The freshly issued key works on its own.
    const usingNewKey = await harness.request("/_admin/api/me", {
      headers: { authorization: `Bearer ${issued.credential}` },
    });
    expect(usingNewKey.status).toBe(200);

    const listing = await harness.adminJson<KeyListing>(
      "/_admin/api/admin-keys",
    );
    expect(listing.keys.map((key) => key.id)).toContain(issued.id);

    const revoked = await harness.admin(`/_admin/api/admin-keys/${issued.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);

    const afterRevoke = await harness.request("/_admin/api/me", {
      headers: { authorization: `Bearer ${issued.credential}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  test("manages admin identities", async () => {
    await harness.admin("/_admin/api/admin-users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "person@example.com" }),
    });
    const listing = await harness.adminJson<AdminUserListing>(
      "/_admin/api/admin-users",
    );
    expect(listing.adminUsers.map((user) => user.subject)).toContain(
      "person@example.com",
    );

    const deleted = await harness.admin(
      "/_admin/api/admin-users/person%40example.com",
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
  });

  test("admin record inspection never marks records fetched", async () => {
    const destination = await createDestination(harness, {
      name: "inspected",
      vendorAddon: "passthrough",
    });
    await harness.request(`/passthrough/${destination.inboundUuid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });

    const inspected = await harness.adminJson<{
      records: readonly { fetched: boolean }[];
    }>(`/_admin/api/records/${destination.id}`);
    expect(inspected.records).toHaveLength(1);
    expect(inspected.records[0]?.fetched).toBe(false);

    const again = await harness.adminJson<{
      records: readonly { fetched: boolean }[];
    }>(`/_admin/api/records/${destination.id}`);
    expect(again.records[0]?.fetched).toBe(false);
  });

  test("rejects unknown admin resources and methods", async () => {
    expect((await harness.admin("/_admin/api/unknown")).status).toBe(404);
    expect(
      (await harness.admin("/_admin/api/destinations", { method: "PUT" }))
        .status,
    ).toBe(405);
  });

  test("serves an admin UI placeholder when the bundle is absent", async () => {
    const response = await harness.request("/_admin/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("the bootstrap admin credential is the configured one", async () => {
    const response = await harness.request("/_admin/api/me", {
      headers: { authorization: `Bearer ${TEST_ADMIN_CREDENTIAL}` },
    });
    expect(response.status).toBe(200);
  });
});
