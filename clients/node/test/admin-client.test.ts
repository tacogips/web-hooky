/**
 * Admin client: routes, CSRF-satisfying headers, envelope unwrapping.
 */
import { expect, test } from "bun:test";
import { WebhookyAdminClient } from "../src/admin-client.js";
import { WebhookyError } from "../src/errors.js";
import { BASE_URL, stub } from "./support.js";

function admin(fetchImpl: typeof fetch): WebhookyAdminClient {
  return new WebhookyAdminClient({
    baseUrl: BASE_URL,
    credential: "admin-1:admin-secret",
    fetchImpl,
  });
}

test("the credential must be a key/secret pair", () => {
  expect(
    () =>
      new WebhookyAdminClient({ baseUrl: BASE_URL, credential: "no-colon" }),
  ).toThrow(WebhookyError);
});

test("a credential may be absent when identity headers are supplied", () => {
  // A deployment fronted by an identity-provider proxy authenticates through
  // headers, so no credential is legitimate there.
  const client = new WebhookyAdminClient({
    baseUrl: BASE_URL,
    headers: { "cf-access-authenticated-user-email": "ops@example.com" },
  });
  expect(client.config.authorization).toBe("");
});

test("no credentials at all is rejected", () => {
  expect(() => new WebhookyAdminClient({ baseUrl: BASE_URL })).toThrow(
    WebhookyError,
  );
});

test("a keyId/secret pair is accepted", async () => {
  const { fetchImpl, seen } = stub(200, {
    subject: "admin-key:k1",
    viaApiKey: true,
  });
  const client = new WebhookyAdminClient({
    baseUrl: BASE_URL,
    keyId: "k1",
    secret: "s1",
    fetchImpl,
  });
  const identity = await client.me();

  expect(seen.headers["authorization"]).toBe("Bearer k1:s1");
  expect(identity.viaApiKey).toBe(true);
});

test("list endpoints unwrap the server's envelope", async () => {
  const { fetchImpl, seen } = stub(200, {
    destinations: [{ id: "d1", name: "prod", fetchUuid: "f1" }],
  });
  const destinations = await admin(fetchImpl).listDestinations();

  expect(seen.url).toBe(`${BASE_URL}/_admin/api/destinations`);
  expect(seen.headers["authorization"]).toBe("Bearer admin-1:admin-secret");
  expect(destinations).toHaveLength(1);
  expect(destinations[0]?.id).toBe("d1");
  expect(destinations[0]?.fetchUuid).toBe("f1");
});

test("create omits unset optionals", async () => {
  const { fetchImpl, seen } = stub(201, { id: "d1", name: "prod" });
  await admin(fetchImpl).createDestination({
    name: "prod",
    vendorAddon: "wrike",
    vendorConfig: { secret: "s" },
  });

  expect(seen.method).toBe("POST");
  expect(seen.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(seen.body)).toEqual({
    name: "prod",
    vendorAddon: "wrike",
    vendorConfig: { secret: "s" },
  });
  // An omitted optional must not appear at all, so the server keeps its default
  // rather than receiving an explicit null.
  expect(seen.body).not.toContain("destinationAddon");
});

const bodylessWrites: ReadonlyArray<
  readonly [string, (client: WebhookyAdminClient) => Promise<unknown>]
> = [
  ["rotate fetch uuid", (client) => client.rotateFetchUuid("d1")],
  ["grant", (client) => client.grantDestination("u1", "d1")],
  ["delete destination", (client) => client.deleteDestination("d1")],
  ["retry relay", (client) => client.retryRelay("r1")],
];

for (const [name, call] of bodylessWrites) {
  test(`${name} declares JSON so the IdP path clears CSRF`, async () => {
    // The server's CSRF rule accepts an identity-provider write only with a
    // matching Origin or content-type: application/json. These calls have no
    // body, so the header is the only way through.
    const { fetchImpl, seen } = stub(200, {});
    await call(admin(fetchImpl));
    expect(seen.headers["content-type"]).toBe("application/json");
  });
}

test("path segments are percent-encoded", async () => {
  // An admin subject is an email or an IdP subject and can contain characters
  // that would otherwise change the route.
  const { fetchImpl, seen } = stub(204, null);
  await admin(fetchImpl).deleteAdminUser("ops user@example.com");
  expect(seen.url).toBe(
    `${BASE_URL}/_admin/api/admin-users/ops%20user%40example.com`,
  );
});

test("the addon upload uses multipart and an Origin header", async () => {
  const { fetchImpl, seen } = stub(201, {
    name: "acme",
    version: "1.0.0",
    kind: "vendor",
  });
  const addon = await admin(fetchImpl).uploadAddon(
    "acme.zip",
    new TextEncoder().encode("PKstub"),
  );

  expect(addon.name).toBe("acme");
  expect(seen.headers["content-type"]?.startsWith("multipart/form-data")).toBe(
    true,
  );
  // Multipart cannot use the JSON content type, so the Origin header is what
  // clears the server's CSRF rule on the identity-provider path.
  expect(seen.headers["origin"]).toBe(BASE_URL);
  expect(seen.body).toContain('name="package"');
  expect(seen.body).toContain('filename="acme.zip"');
  expect(seen.body).toContain("PK");
});

test("listRelays filters by destination only when asked", async () => {
  const filtered = stub(200, { relays: [] });
  await admin(filtered.fetchImpl).listRelays("dest-9");
  expect(filtered.seen.url).toBe(
    `${BASE_URL}/_admin/api/relays?destinationId=dest-9`,
  );

  const all = stub(200, { relays: [] });
  await admin(all.fetchImpl).listRelays();
  expect(all.seen.url).toBe(`${BASE_URL}/_admin/api/relays`);
});

test("secrets returned once are decoded", async () => {
  const { fetchImpl } = stub(201, {
    id: "k1",
    label: "ci",
    enabled: true,
    createdAt: 5,
    grants: [],
    secret: "s3cr3t",
    credential: "k1:s3cr3t",
  });
  const created = await admin(fetchImpl).createApiUser("ci");

  expect(created.id).toBe("k1");
  expect(created.secret).toBe("s3cr3t");
  expect(created.credential).toBe("k1:s3cr3t");
});

test("a 204 response is not a decode error", async () => {
  const { fetchImpl } = stub(204, null);
  expect(await admin(fetchImpl).deleteRelay("r1")).toBeUndefined();
});

test("retry reports the requeued count", async () => {
  const { fetchImpl } = stub(200, { requeued: 4 });
  expect(await admin(fetchImpl).retryRelay("r1")).toBe(4);
});

test("relay deliveries decode with their stats", async () => {
  const { fetchImpl, seen } = stub(200, {
    deliveries: [
      {
        id: "dl1",
        relayId: "r1",
        recordId: "rec1",
        t: 3,
        status: "failed",
        attempts: 5,
        nextAttemptAt: 9,
        lastStatusCode: 500,
        lastError: "boom",
        createdAt: 1,
        updatedAt: 2,
        deliveredAt: null,
      },
    ],
    stats: { pending: 1, delivered: 2, failed: 3 },
  });
  const page = await admin(fetchImpl).listRelayDeliveries("r1", 10);

  expect(seen.url).toBe(`${BASE_URL}/_admin/api/relays/r1/deliveries?limit=10`);
  expect(page.stats.failed).toBe(3);
  expect(page.deliveries[0]?.lastStatusCode).toBe(500);
  expect(page.deliveries[0]?.deliveredAt).toBeNull();
});
