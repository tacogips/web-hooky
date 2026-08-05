/**
 * CSRF protection for the IdP-authenticated admin surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createHarness,
  type Harness,
  TEST_ADMIN_CREDENTIAL,
} from "../test-support/harness";

const IDENTITY_HEADER = "cf-access-authenticated-user-email";
const SUBJECT = "seeded@example.com";

function idpHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { [IDENTITY_HEADER]: SUBJECT, ...extra };
}

const BODY = JSON.stringify({ subject: "attacker@evil.example" });

describe("admin API CSRF protection", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      WEBHOOKY_ADMIN_AUTH: "trusted-header",
      WEBHOOKY_ADMIN_SUBJECTS: SUBJECT,
      WEBHOOKY_ADMIN_ALLOWED_ORIGINS: "https://admin.example",
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function adminUserCount(): Promise<number> {
    const listing = await harness.adminJson<{
      adminUsers: readonly unknown[];
    }>("/_admin/api/admin-users");
    return listing.adminUsers.length;
  }

  test("rejects a cross-site simple request body", async () => {
    const before = await adminUserCount();
    const response = await harness.request("/_admin/api/admin-users", {
      method: "POST",
      headers: idpHeaders({ "content-type": "text/plain;charset=UTF-8" }),
      body: BODY,
    });
    expect(response.status).toBe(403);
    expect(await adminUserCount()).toBe(before);
  });

  test("rejects a foreign Origin", async () => {
    const response = await harness.request("/_admin/api/admin-users", {
      method: "POST",
      headers: idpHeaders({
        "content-type": "application/json",
        origin: "https://evil.example",
      }),
      body: BODY,
    });
    expect(response.status).toBe(403);
  });

  test("accepts the admin UI's own same-origin request", async () => {
    const response = await harness.request("/_admin/api/admin-users", {
      method: "POST",
      headers: idpHeaders({
        "content-type": "application/json",
        origin: "http://test.local",
      }),
      body: BODY,
    });
    expect(response.status).toBe(201);
  });

  test("accepts a configured extra origin", async () => {
    const response = await harness.request("/_admin/api/admin-users", {
      method: "POST",
      headers: idpHeaders({
        "content-type": "application/json",
        origin: "https://admin.example/",
      }),
      body: BODY,
    });
    expect(response.status).toBe(201);
  });

  test("accepts a JSON request without an Origin header", async () => {
    // Non-browser clients on the IdP path send no Origin; a cross-site request
    // that sets this content type is preflighted and never reaches the handler.
    const response = await harness.request("/_admin/api/admin-users", {
      method: "POST",
      headers: idpHeaders({ "content-type": "application/json" }),
      body: BODY,
    });
    expect(response.status).toBe(201);
  });

  test("rejects a multipart upload from a foreign origin", async () => {
    const form = new FormData();
    form.append("package", new Blob([new Uint8Array([1, 2, 3])]), "addon.zip");
    const response = await harness.request("/_admin/api/addons", {
      method: "POST",
      headers: idpHeaders({ origin: "https://evil.example" }),
      body: form,
    });
    expect(response.status).toBe(403);
  });

  test("leaves reads and the admin API key path unaffected", async () => {
    const read = await harness.request("/_admin/api/destinations", {
      headers: idpHeaders({ origin: "https://evil.example" }),
    });
    expect(read.status).toBe(200);

    // The API key is never attached by a browser, so no CSRF check applies.
    const keyed = await harness.request("/_admin/api/admin-users", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_ADMIN_CREDENTIAL}`,
        "content-type": "text/plain;charset=UTF-8",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ subject: "automation@example.com" }),
    });
    expect(keyed.status).toBe(201);
  });
});
