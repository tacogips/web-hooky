/**
 * Router edge cases and the last-resort error surface.
 *
 * These paths are the safety net under everything else: the 404 fallbacks that
 * keep probing requests out of the handlers, the WebSocket upgrade guards, and
 * the top-level catch that converts an unhandled throw into a referenced,
 * detail-free 500. The catch-all matters most - it is the final line of the
 * "never leak internals" guarantee, and nothing else exercises it because the
 * pipeline catches its own failures earlier.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hmacSha256Hex } from "../core/ids";
import {
  createAuthorizedUser,
  createDestination,
  createHarness,
  type CreatedApiUser,
  type CreatedDestination,
  type Harness,
} from "../test-support/harness";
import { createApp } from "./app";
import type { AppContext } from "./context";

const SECRET = "routing-test-secret";
const LEAKY_DETAIL = "postgres://user:hunter2@internal-db/records";

let harness: Harness;
let destination: CreatedDestination;
let consumer: CreatedApiUser;

beforeAll(async () => {
  harness = await createHarness();
  destination = await createDestination(harness, {
    name: "routing destination",
    vendorAddon: "wrike",
    vendorConfig: { secret: SECRET },
  });
  consumer = await createAuthorizedUser(harness, destination.id);
});

afterAll(async () => {
  await harness.close();
});

function consumerSecret(): string {
  return consumer.credential.split(":")[1] ?? "";
}

describe("routing fallbacks", () => {
  test("the root path answers with a service banner", async () => {
    const response = await harness.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "web-hooky", status: "ok" });
  });

  test("unknown underscore-prefixed paths are 404", async () => {
    const response = await harness.request("/_nonsense");
    expect(response.status).toBe(404);
  });

  test("extra path segments under _get are 404", async () => {
    const response = await harness.request(
      `/_get/${destination.fetchUuid}/extra`,
    );
    expect(response.status).toBe(404);
  });

  test("extra path segments under _ws are 404", async () => {
    const response = await harness.request(
      `/_ws/${destination.fetchUuid}/extra`,
    );
    expect(response.status).toBe(404);
  });

  test("a bare vendor segment is 404", async () => {
    const response = await harness.request("/wrike");
    expect(response.status).toBe(404);
  });

  test("three segments under a vendor are 404", async () => {
    const response = await harness.request(
      `/wrike/${destination.inboundUuid}/extra`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});

describe("WebSocket upgrade guards", () => {
  function wsPath(): string {
    return `/_ws/${destination.fetchUuid}?api_key=${consumer.id}&api_secret=${encodeURIComponent(consumerSecret())}`;
  }

  test("an authorized upgrade on a server without upgrade support is a 500", async () => {
    // harness.request drives app.fetch with server = null, which models a
    // runtime that cannot upgrade at all.
    const response = await harness.request(wsPath());
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Internal server error (reference");
    expect(body).not.toContain("upgrade");
  });

  test("a request the server declines to upgrade is a 400", async () => {
    const response = await harness.runtime.app.fetch(
      new Request(`http://test.local${wsPath()}`),
      { upgrade: () => false },
    );
    expect(response?.status).toBe(400);
    const body = await response?.text();
    expect(body).toContain("Expected a WebSocket upgrade request");
  });

  test("a successful upgrade returns null and attaches the api user", async () => {
    let attached: unknown = null;
    const response = await harness.runtime.app.fetch(
      new Request(`http://test.local${wsPath()}`),
      {
        upgrade: (_request, options) => {
          attached = options.data;
          return true;
        },
      },
    );
    expect(response).toBeNull();
    expect(attached).toEqual({
      destinationId: destination.id,
      apiUserId: consumer.id,
    });
  });
});

describe("unhandled-error catch-all", () => {
  test("a throwing store surfaces as a referenced 500 without its detail", async () => {
    const context = harness.runtime.context;
    // Same context, but every persistence access detonates with a message that
    // must never reach the caller. Cache lookups still run first, so the cache
    // is bypassed to guarantee the throwing path is taken.
    const broken: AppContext = {
      ...context,
      config: { ...context.config, cacheTtlSeconds: 0 },
      persistence: new Proxy(context.persistence, {
        get(): never {
          throw new Error(LEAKY_DETAIL);
        },
      }),
    };
    const app = createApp(broken);

    const body = JSON.stringify({ probe: true });
    const response = await app.fetch(
      new Request(`http://test.local/wrike/${destination.inboundUuid}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hook-signature": await hmacSha256Hex(SECRET, body),
        },
        body,
      }),
      null,
    );

    expect(response?.status).toBe(500);
    const text = (await response?.text()) ?? "";
    expect(text).toContain("Internal server error (reference");
    expect(text).not.toContain(LEAKY_DETAIL);
    expect(text).not.toContain("hunter2");
  });
});

describe("github end-to-end", () => {
  test("a signed delivery flows through auth, validation and transform", async () => {
    const ghSecret = "gh-e2e-secret";
    const gh = await createDestination(harness, {
      name: "github destination",
      vendorAddon: "github",
      vendorConfig: { secret: ghSecret },
    });
    const reader = await createAuthorizedUser(harness, gh.id);

    const payload = JSON.stringify({ action: "opened", number: 12 });
    const accepted = await harness.request(`/github/${gh.inboundUuid}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${await hmacSha256Hex(ghSecret, payload)}`,
      },
      body: payload,
    });
    expect(accepted.status).toBe(202);

    const rejected = await harness.request(`/github/${gh.inboundUuid}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: payload,
    });
    expect(rejected.status).toBe(401);

    const unsigned = await harness.request(`/github/${gh.inboundUuid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(unsigned.status).toBe(401);

    const secret = reader.credential.split(":")[1] ?? "";
    const fetched = await harness.request(`/_get/${gh.fetchUuid}`, {
      headers: { authorization: `Bearer ${reader.id}:${secret}` },
    });
    const listing = (await fetched.json()) as {
      records: readonly { payload: Record<string, unknown> }[];
    };
    expect(listing.records).toHaveLength(1);
    const record = listing.records[0]?.payload;
    expect(record?.["source"]).toBe("github");
    expect(record?.["event"]).toBe("pull_request");
    expect(record?.["payload"]).toEqual({ action: "opened", number: 12 });
  });
});
