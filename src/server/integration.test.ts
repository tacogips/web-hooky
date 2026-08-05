/**
 * End-to-end tests over the real HTTP surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { hmacSha256Base64, hmacSha256Hex } from "../core/ids";
import type { JsonValue } from "../core/json";
import { createFixedClock } from "../core/time";
import {
  createAuthorizedUser,
  createDestination,
  createHarness,
  type CreatedApiUser,
  type CreatedDestination,
  type Harness,
  postWrikeWebhook,
} from "../test-support/harness";

interface FetchResponseBody {
  readonly records: readonly {
    readonly t: number;
    readonly fetched: boolean;
    readonly payload: JsonValue;
  }[];
}

const WEBHOOK_SECRET = "wrike-webhook-secret";

describe("inbound webhook and fetch API", () => {
  let harness: Harness;
  let destination: CreatedDestination;
  let consumer: CreatedApiUser;

  beforeEach(async () => {
    harness = await createHarness();
    destination = await createDestination(harness, {
      name: "wrike destination",
      vendorAddon: "wrike",
      vendorConfig: { secret: WEBHOOK_SECRET },
    });
    consumer = await createAuthorizedUser(harness, destination.id);
  });

  afterEach(async () => {
    await harness.close();
  });

  function fetchRecords(search = ""): Promise<Response> {
    return harness.request(`/_get/${destination.fetchUuid}${search}`, {
      headers: { authorization: `Bearer ${consumer.credential}` },
    });
  }

  test("accepts a signed webhook and stores the transformed payload", async () => {
    const response = await postWrikeWebhook(
      harness,
      destination.inboundUuid,
      WEBHOOK_SECRET,
      [{ eventType: "TaskCreated", taskId: "T1" }],
    );
    expect(response.status).toBe(202);

    const fetched = await fetchRecords();
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as FetchResponseBody;
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.fetched).toBe(false);
    expect(body.records[0]?.payload).toMatchObject({
      source: "wrike",
      events: [{ eventType: "TaskCreated", taskId: "T1" }],
    });
  });

  test("rejects a webhook with an invalid signature and stores nothing", async () => {
    const response = await postWrikeWebhook(
      harness,
      destination.inboundUuid,
      WEBHOOK_SECRET,
      [{ eventType: "TaskCreated" }],
      "invalid-signature",
    );
    expect(response.status).toBe(401);

    const body = (await (await fetchRecords()).json()) as FetchResponseBody;
    expect(body.records).toHaveLength(0);
  });

  test("rejects a body HMAC sent in X-Hook-Secret instead of X-Hook-Signature", async () => {
    const body = JSON.stringify([{ eventType: "TaskCreated" }]);
    const response = await harness.request(
      `/wrike/${destination.inboundUuid}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hook-secret": await hmacSha256Base64(WEBHOOK_SECRET, body),
        },
        body,
      },
    );
    expect(response.status).toBe(401);

    const stored = (await (await fetchRecords()).json()) as FetchResponseBody;
    expect(stored.records).toHaveLength(0);
  });

  test("answers the Wrike secure-webhook handshake without storing it", async () => {
    const body = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const challenge = "aRandomAlphanumericValue";
    const response = await harness.request(
      `/wrike/${destination.inboundUuid}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hook-signature": await hmacSha256Hex(WEBHOOK_SECRET, body),
          "x-hook-secret": challenge,
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-hook-secret")).toBe(
      await hmacSha256Hex(WEBHOOK_SECRET, challenge),
    );

    const stored = (await (await fetchRecords()).json()) as FetchResponseBody;
    expect(stored.records).toHaveLength(0);
  });

  test("refuses to act as a signing oracle for a replayed handshake", async () => {
    // The handshake body is a constant, so its signature never rotates and must
    // be assumed public. The attack is to replay that pair with a chosen
    // challenge and read back hmacSha256(secret, challenge).
    const handshakeBody = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const handshakeSignature = await hmacSha256Hex(
      WEBHOOK_SECRET,
      handshakeBody,
    );
    const forgedBody = JSON.stringify([
      { eventType: "TaskCreated", taskId: "attacker" },
    ]);
    // The value the attacker is trying to extract: a valid delivery signature.
    const oracleValue = await hmacSha256Hex(WEBHOOK_SECRET, forgedBody);

    const handshake = await harness.request(
      `/wrike/${destination.inboundUuid}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hook-signature": handshakeSignature,
          "x-hook-secret": forgedBody,
        },
        body: handshakeBody,
      },
    );
    expect(handshake.status).toBe(400);
    expect(handshake.headers.get("x-hook-secret")).toBeNull();
    // Nothing in the rejection leaks the signature over the forged body.
    expect(await handshake.text()).not.toContain(oracleValue);

    // Without the oracle the attacker only holds the handshake signature, which
    // does not authenticate the forged delivery.
    const forged = await harness.request(`/wrike/${destination.inboundUuid}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hook-signature": handshakeSignature,
      },
      body: forgedBody,
    });
    expect(forged.status).toBe(401);

    const stored = (await (await fetchRecords()).json()) as FetchResponseBody;
    expect(stored.records).toHaveLength(0);
  });

  test("rejects a webhook sent to a mismatched addon prefix", async () => {
    const response = await harness.request(
      `/github/${destination.inboundUuid}`,
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(404);
  });

  test("rejects a body larger than the configured cap", async () => {
    const small = await createHarness({ WEBHOOKY_MAX_BODY_BYTES: "32" });
    try {
      const created = await createDestination(small, {
        name: "small",
        vendorAddon: "passthrough",
      });
      const response = await small.request(
        `/passthrough/${created.inboundUuid}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ padding: "x".repeat(200) }),
        },
      );
      expect(response.status).toBe(413);
    } finally {
      await small.close();
    }
  });

  test("rejects an oversized streamed body that declares no length", async () => {
    const small = await createHarness({ WEBHOOKY_MAX_BODY_BYTES: "32" });
    try {
      const created = await createDestination(small, {
        name: "small-stream",
        vendorAddon: "passthrough",
      });
      const encoder = new TextEncoder();
      let emitted = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= 8) {
            controller.close();
            return;
          }
          emitted += 1;
          controller.enqueue(encoder.encode("x".repeat(16)));
        },
      });
      const response = await small.request(
        `/passthrough/${created.inboundUuid}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          duplex: "half",
        } as RequestInit,
      );
      expect(response.status).toBe(413);
      // The stream is abandoned as soon as the cap is passed, so the remaining
      // chunks are never pulled into memory.
      expect(emitted).toBeLessThan(8);
    } finally {
      await small.close();
    }
  });

  test("returns records in descending receipt order", async () => {
    for (const id of ["A", "B", "C"]) {
      const response = await postWrikeWebhook(
        harness,
        destination.inboundUuid,
        WEBHOOK_SECRET,
        [{ eventType: id }],
      );
      expect(response.status).toBe(202);
    }

    const body = (await (await fetchRecords()).json()) as FetchResponseBody;
    const times = body.records.map((entry) => entry.t);
    expect([...times]).toEqual([...times].sort((a, b) => b - a));
  });

  test("marks returned records as fetched", async () => {
    await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
      { eventType: "one" },
    ]);

    const first = (await (
      await fetchRecords("?only_unfetched=true")
    ).json()) as FetchResponseBody;
    expect(first.records).toHaveLength(1);

    const second = (await (
      await fetchRecords("?only_unfetched=true")
    ).json()) as FetchResponseBody;
    expect(second.records).toHaveLength(0);

    const all = (await (await fetchRecords()).json()) as FetchResponseBody;
    expect(all.records[0]?.fetched).toBe(true);
  });

  test("mark_fetched=false leaves records unfetched", async () => {
    await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
      { eventType: "one" },
    ]);
    await fetchRecords("?mark_fetched=false");
    const again = (await (
      await fetchRecords("?only_unfetched=true&mark_fetched=false")
    ).json()) as FetchResponseBody;
    expect(again.records).toHaveLength(1);
  });

  test("honours limit and receipt datetime range filters", async () => {
    for (let index = 0; index < 3; index += 1) {
      await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
        { eventType: `event-${index}` },
      ]);
    }

    const limited = (await (
      await fetchRecords("?limit=2&mark_fetched=false")
    ).json()) as FetchResponseBody;
    expect(limited.records).toHaveLength(2);

    const future = (await (
      await fetchRecords("?from=4102444800&mark_fetched=false")
    ).json()) as FetchResponseBody;
    expect(future.records).toHaveLength(0);

    const past = (await (
      await fetchRecords("?to=0&mark_fetched=false")
    ).json()) as FetchResponseBody;
    expect(past.records).toHaveLength(0);
  });

  test("rejects fetch requests without credentials", async () => {
    const response = await harness.request(`/_get/${destination.fetchUuid}`);
    expect(response.status).toBe(401);
  });

  test("rejects fetch requests from an unauthorized user", async () => {
    const other = await harness.adminJson<CreatedApiUser>("/_admin/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "no-grants" }),
    });
    const response = await harness.request(`/_get/${destination.fetchUuid}`, {
      headers: { authorization: `Bearer ${other.credential}` },
    });
    expect(response.status).toBe(403);
  });

  test("does not accept query-string credentials on _get", async () => {
    const [keyId, ...rest] = consumer.credential.split(":");
    const response = await harness.request(
      `/_get/${destination.fetchUuid}?api_key=${keyId}&api_secret=${encodeURIComponent(rest.join(":"))}`,
    );
    expect(response.status).toBe(401);
  });

  test("rejects fetch requests with a wrong secret", async () => {
    const response = await harness.request(`/_get/${destination.fetchUuid}`, {
      headers: { authorization: `Bearer ${consumer.id}:wrong-secret` },
    });
    expect(response.status).toBe(401);
  });

  test("returns 404 for an unknown fetch uuid", async () => {
    const response = await harness.request("/_get/does-not-exist", {
      headers: { authorization: `Bearer ${consumer.credential}` },
    });
    expect(response.status).toBe(404);
  });

  test("a disabled destination stops ingest and both fetch surfaces", async () => {
    await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
      { eventType: "TaskCreated", taskId: "T1" },
    ]);

    const patched = await harness.admin(
      `/_admin/api/destinations/${destination.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(patched.status).toBe(200);

    const inbound = await postWrikeWebhook(
      harness,
      destination.inboundUuid,
      WEBHOOK_SECRET,
      [{ eventType: "TaskCreated", taskId: "T2" }],
    );
    expect(inbound.status).toBe(403);
    expect((await fetchRecords()).status).toBe(403);

    // Administrators can still read the stored records.
    const inspected = await harness.adminJson<FetchResponseBody>(
      `/_admin/api/records/${destination.id}`,
    );
    expect(inspected.records).toHaveLength(1);

    // Re-enabling restores both surfaces.
    await harness.admin(`/_admin/api/destinations/${destination.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect((await fetchRecords()).status).toBe(200);
  });

  test("keeps the schema mismatch detail in the 422 sent to the vendor", async () => {
    // The sender can act on this one, so it must say what was rejected.
    const response = await postWrikeWebhook(
      harness,
      destination.inboundUuid,
      WEBHOOK_SECRET,
      "a string payload",
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("does not match its schema");
  });

  test("exposes a health endpoint", async () => {
    const response = await harness.request("/_health");
    expect(response.status).toBe(200);
  });
});

describe("public error surface", () => {
  test("answers an addon failure without leaking its detail", async () => {
    // The message an addon throws can carry connection strings, file paths or
    // upstream errors, and `/{vendor}/{uuid}` is reachable by anyone.
    const encoder = new TextEncoder();
    const harness = await createHarness();
    try {
      const installed = await harness.admin("/_admin/api/addons", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: zipSync({
          "addon.json": encoder.encode(
            JSON.stringify({
              name: "exploding",
              version: "1.0.0",
              kind: "vendor",
              description: "always throws",
              entry: "addon.js",
              acceptsSchema: { type: "object" },
              returnsSchema: { type: "object" },
            }),
          ),
          "addon.js": encoder.encode(
            'export function transform() { throw new Error("postgres://user:hunter2@internal-db/records"); }',
          ),
        }),
      });
      expect(installed.status).toBe(201);

      const created = await createDestination(harness, {
        name: "exploding destination",
        vendorAddon: "exploding",
      });
      const response = await harness.request(
        `/exploding/${created.inboundUuid}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toBe(500);

      const text = await response.text();
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("internal-db");
      expect(text).not.toContain("exploding");
      expect(text).toContain("reference");
    } finally {
      await harness.close();
    }
  });
});

describe("destination-level addon chaining", () => {
  test("wraps the vendor output with the destination addon", async () => {
    const harness = await createHarness();
    try {
      const destination = await createDestination(harness, {
        name: "chained",
        vendorAddon: "wrike",
        destinationAddon: "envelope",
        vendorConfig: { secret: WEBHOOK_SECRET },
        destinationConfig: { label: "team-a" },
      });
      const consumer = await createAuthorizedUser(harness, destination.id);

      await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
        { eventType: "TaskCreated" },
      ]);

      const response = await harness.request(`/_get/${destination.fetchUuid}`, {
        headers: { authorization: `Bearer ${consumer.credential}` },
      });
      const body = (await response.json()) as FetchResponseBody;
      expect(body.records[0]?.payload).toMatchObject({
        label: "team-a",
        data: { source: "wrike" },
      });
    } finally {
      await harness.close();
    }
  });
});

describe("retention", () => {
  test("deletes records older than the configured window", async () => {
    // A controlled clock keeps the assertion deterministic: the record is
    // written at t=1000 and the sweep runs at t=1060 with a 30 second window.
    const clock = createFixedClock(1000);
    const harness = await createHarness(
      { WEBHOOKY_RETENTION_SECONDS: "30" },
      { clock },
    );
    try {
      const destination = await createDestination(harness, {
        name: "short-lived",
        vendorAddon: "passthrough",
      });
      const consumer = await createAuthorizedUser(harness, destination.id);

      await harness.request(`/passthrough/${destination.inboundUuid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });

      expect(
        await harness.runtime.context.persistence.records.countForDestination(
          destination.id,
        ),
      ).toBe(1);

      clock.advance(60);
      const swept = await harness.runtime.sweepRetention();
      expect(swept.records).toBe(1);

      const response = await harness.request(`/_get/${destination.fetchUuid}`, {
        headers: { authorization: `Bearer ${consumer.credential}` },
      });
      const body = (await response.json()) as FetchResponseBody;
      expect(body.records).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
