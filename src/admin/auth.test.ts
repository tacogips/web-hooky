import { describe, expect, test } from "bun:test";
import { AdminAuthMode, type AppConfig, loadConfig } from "../config";
import {
  createAdminAuthProvider,
  createDevProvider,
  createDisabledProvider,
  createTrustedHeaderProvider,
} from "./auth-provider";
import { createDestination, createHarness } from "../test-support/harness";

function config(overrides: Readonly<Record<string, string>> = {}): AppConfig {
  const loaded = loadConfig(overrides);
  if (loaded.ok === false) {
    throw new Error(`Invalid test configuration: ${loaded.error.message}`);
  }
  return loaded.value;
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/_admin/api/me", { headers });
}

describe("admin auth providers", () => {
  test("trusted header provider reads the configured header", async () => {
    const provider = createTrustedHeaderProvider(config());
    const identity = await provider.authenticate(
      request({ "cf-access-authenticated-user-email": "a@example.com" }),
    );
    expect(identity?.subject).toBe("a@example.com");
    expect(await provider.authenticate(request())).toBeNull();
  });

  test("trusted header provider honours a custom header name", async () => {
    const provider = createTrustedHeaderProvider(
      config({ WEBHOOKY_ADMIN_AUTH_HEADER: "X-Identity" }),
    );
    const identity = await provider.authenticate(
      request({ "x-identity": "b@example.com" }),
    );
    expect(identity?.subject).toBe("b@example.com");
  });

  test("trusted header provider requires the proxy shared secret", async () => {
    const provider = createTrustedHeaderProvider(
      config({ WEBHOOKY_ADMIN_AUTH_SHARED_SECRET: "proxy-secret" }),
    );
    expect(
      await provider.authenticate(
        request({ "cf-access-authenticated-user-email": "a@example.com" }),
      ),
    ).toBeNull();
    const identity = await provider.authenticate(
      request({
        "cf-access-authenticated-user-email": "a@example.com",
        "x-webhooky-proxy-secret": "proxy-secret",
      }),
    );
    expect(identity?.subject).toBe("a@example.com");
  });

  test("dev provider always returns the configured subject", async () => {
    const provider = createDevProvider(
      config({ WEBHOOKY_ADMIN_DEV_SUBJECT: "dev@local" }),
    );
    expect((await provider.authenticate(request()))?.subject).toBe("dev@local");
  });

  test("disabled provider never authenticates", async () => {
    expect(await createDisabledProvider().authenticate(request())).toBeNull();
  });

  test("factory selects the provider by mode", () => {
    expect(createAdminAuthProvider(config()).name).toBe(
      AdminAuthMode.TrustedHeader,
    );
    expect(
      createAdminAuthProvider(config({ WEBHOOKY_ADMIN_AUTH: "dev" })).name,
    ).toBe(AdminAuthMode.Dev);
    expect(
      createAdminAuthProvider(config({ WEBHOOKY_ADMIN_AUTH: "disabled" })).name,
    ).toBe(AdminAuthMode.Disabled);
  });
});

describe("identity provider driven admin access", () => {
  test("a seeded subject can use the admin API without an API key", async () => {
    const harness = await createHarness({
      WEBHOOKY_ADMIN_AUTH: "trusted-header",
      WEBHOOKY_ADMIN_SUBJECTS: "seeded@example.com",
    });
    try {
      const allowed = await harness.request("/_admin/api/me", {
        headers: { "cf-access-authenticated-user-email": "seeded@example.com" },
      });
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as {
        subject: string;
        viaApiKey: boolean;
      };
      expect(body.subject).toBe("seeded@example.com");
      expect(body.viaApiKey).toBe(false);

      // An asserted identity that is not an administrator is forbidden.
      const forbidden = await harness.request("/_admin/api/me", {
        headers: { "cf-access-authenticated-user-email": "other@example.com" },
      });
      expect(forbidden.status).toBe(403);

      // No identity at all is unauthorized.
      expect((await harness.request("/_admin/api/me")).status).toBe(401);

      // The seeded subject can perform admin actions.
      const created = await harness.request("/_admin/api/destinations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-authenticated-user-email": "seeded@example.com",
        },
        body: JSON.stringify({ name: "idp", vendorAddon: "passthrough" }),
      });
      expect(created.status).toBe(201);
    } finally {
      await harness.close();
    }
  });

  test("fetch uuids are never exposed outside the admin surface", async () => {
    const harness = await createHarness();
    try {
      const destination = await createDestination(harness, {
        name: "secret uuid",
        vendorAddon: "passthrough",
      });

      // The inbound endpoint response must not leak the fetch uuid.
      const inbound = await harness.request(
        `/passthrough/${destination.inboundUuid}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(await inbound.text()).not.toContain(destination.fetchUuid);

      // Unauthenticated admin listings must not leak it either.
      const unauthenticated = await harness.request("/_admin/api/destinations");
      expect(await unauthenticated.text()).not.toContain(destination.fetchUuid);
    } finally {
      await harness.close();
    }
  });
});
