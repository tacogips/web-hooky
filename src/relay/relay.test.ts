/**
 * Relay (forwarding) tests: queueing, delivery, retry/backoff and the admin API.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hmacSha256Hex, newUuid } from "../core/ids";
import { createFixedClock } from "../core/time";
import type { PersistenceAdapter } from "../storage/persistence";
import { sweepExpiredRecords } from "../storage/retention";
import { createBunSqlitePersistence } from "../storage/sqlite/adapter";
import {
  RelayDeliveryStatus,
  type DestinationRecord,
  type RelayDeliveryRecord,
  type RelayRecord,
  type WebhookRecord,
} from "../storage/types";
import {
  createDestination,
  createHarness,
  postWrikeWebhook,
  type CreatedDestination,
  type Harness,
} from "../test-support/harness";
import {
  backoffSeconds,
  effectiveTimeoutSeconds,
  type FetchLike,
} from "./dispatch";
import { enqueueRelayDeliveries } from "./queue";
import { createRelayWorker } from "./worker";

const WEBHOOK_SECRET = "relay-webhook-secret";
const RELAY_SECRET = "relay-signing-secret";

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: RequestRedirect | undefined;
}

interface StubFetch {
  readonly impl: FetchLike;
  readonly captured: CapturedRequest[];
}

/** Fetch stub whose response is chosen per call index. */
function stubFetch(statuses: readonly number[], fallback = 200): StubFetch {
  const captured: CapturedRequest[] = [];
  const impl: FetchLike = (url, init) => {
    const headers = init.headers as Record<string, string>;
    captured.push({
      url,
      headers,
      body: String(init.body ?? ""),
      redirect: init.redirect,
    });
    const status = statuses[captured.length - 1] ?? fallback;
    if (status === 0) {
      return Promise.reject(new Error("connection refused"));
    }
    return Promise.resolve(new Response("ok", { status }));
  };
  return { impl, captured };
}

interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

/** A promise the test opens explicitly, used to hold a delivery in flight. */
function openGate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const DESTINATION: DestinationRecord = {
  id: "dest-relay",
  name: "Relay destination",
  vendorAddon: "passthrough",
  destinationAddon: null,
  inboundUuid: "inbound-relay",
  fetchUuid: "fetch-relay",
  vendorConfig: {},
  destinationConfig: {},
  retentionSeconds: null,
  enabled: true,
  createdAt: 1,
  createdBy: null,
};

function relayRecord(overrides: Partial<RelayRecord> = {}): RelayRecord {
  return {
    id: "relay-1",
    destinationId: DESTINATION.id,
    name: "primary",
    targetUrl: "https://target.example/hook",
    secret: RELAY_SECRET,
    enabled: true,
    maxAttempts: 2,
    backoffSeconds: 10,
    timeoutSeconds: 5,
    createdAt: 1,
    createdBy: "admin",
    ...overrides,
  };
}

function webhookRecord(id = "rec-1"): WebhookRecord {
  return {
    id,
    destinationId: DESTINATION.id,
    t: 1000,
    fetched: false,
    payload: { hello: "world" },
  };
}

async function onlyDelivery(
  persistence: PersistenceAdapter,
  relayId: string,
): Promise<RelayDeliveryRecord> {
  const deliveries = await persistence.relayDeliveries.listForRelay(
    relayId,
    10,
  );
  const first = deliveries[0];
  if (first === undefined) {
    throw new Error("Expected at least one delivery");
  }
  return first;
}

describe("relay worker", () => {
  let persistence: PersistenceAdapter;

  beforeEach(async () => {
    persistence = createBunSqlitePersistence(":memory:");
    await persistence.init();
    await persistence.destinations.create(DESTINATION);
  });

  afterEach(async () => {
    await persistence.close();
  });

  function worker(clock = createFixedClock(1000), fetchImpl?: FetchLike) {
    return createRelayWorker({
      persistence,
      clock,
      options: {
        pollIntervalSeconds: 0,
        batchSize: 10,
        maxBackoffSeconds: 3600,
        leaseSeconds: 300,
        parkSeconds: 300,
      },
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }

  test("queues one delivery per enabled relay", async () => {
    await persistence.relays.create(relayRecord());
    await persistence.relays.create(
      relayRecord({ id: "relay-2", name: "disabled", enabled: false }),
    );
    const clock = createFixedClock(1000);

    const queued = await enqueueRelayDeliveries(
      persistence,
      clock,
      webhookRecord(),
    );
    expect(queued).toBe(1);
    expect(
      await persistence.relayDeliveries.listForRelay("relay-2", 10),
    ).toHaveLength(0);
  });

  test("delivers a signed request and marks the delivery delivered", async () => {
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    const stub = stubFetch([200]);
    const result = await worker(clock, stub.impl).runOnce();
    expect(result).toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      parked: 0,
    });

    const request = stub.captured[0];
    if (request === undefined) {
      throw new Error("Expected an outbound request");
    }
    expect(request.url).toBe("https://target.example/hook");
    expect(request.headers["x-webhooky-attempt"]).toBe("1");
    expect(request.headers["x-webhooky-destination"]).toBe(DESTINATION.id);

    const body = JSON.parse(request.body) as {
      recordId: string;
      payload: unknown;
    };
    expect(body.recordId).toBe("rec-1");
    expect(body.payload).toEqual({ hello: "world" });

    const timestamp = request.headers["x-webhooky-timestamp"];
    const expected = await hmacSha256Hex(
      RELAY_SECRET,
      `${timestamp}.${request.body}`,
    );
    expect(request.headers["x-webhooky-signature"]).toBe(`sha256=${expected}`);

    const delivery = await onlyDelivery(persistence, "relay-1");
    expect(delivery.status).toBe(RelayDeliveryStatus.Delivered);
    expect(delivery.lastStatusCode).toBe(200);
    expect(delivery.attempts).toBe(1);
  });

  test("omits the signature when no secret is configured", async () => {
    await persistence.relays.create(relayRecord({ secret: null }));
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    const stub = stubFetch([200]);
    await worker(clock, stub.impl).runOnce();
    expect(stub.captured[0]?.headers["x-webhooky-signature"]).toBeUndefined();
  });

  test("retries with backoff and gives up after maxAttempts", async () => {
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    // First attempt fails at the transport level, second with a 500.
    const stub = stubFetch([0, 500]);
    const relayWorker = worker(clock, stub.impl);

    const first = await relayWorker.runOnce();
    expect(first.retried).toBe(1);
    const afterFirst = await onlyDelivery(persistence, "relay-1");
    expect(afterFirst.status).toBe(RelayDeliveryStatus.Pending);
    expect(afterFirst.attempts).toBe(1);
    // A base delay of 10 seconds, jittered by a factor in [0.5, 1.5).
    expect(afterFirst.nextAttemptAt).toBeGreaterThanOrEqual(1005);
    expect(afterFirst.nextAttemptAt).toBeLessThanOrEqual(1015);
    expect(afterFirst.lastError).toContain("connection refused");

    // Still backing off: nothing is due yet.
    expect((await relayWorker.runOnce()).claimed).toBe(0);

    clock.advance(20);
    const second = await relayWorker.runOnce();
    expect(second.failed).toBe(1);
    const afterSecond = await onlyDelivery(persistence, "relay-1");
    expect(afterSecond.status).toBe(RelayDeliveryStatus.Failed);
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.lastStatusCode).toBe(500);
    expect(stub.captured).toHaveLength(2);

    // A failed delivery can be requeued and then succeeds.
    const requeued = await persistence.relayDeliveries.requeueFailed(
      "relay-1",
      clock.nowSeconds(),
    );
    expect(requeued).toBe(1);
    const retryStub = stubFetch([204]);
    const third = await worker(clock, retryStub.impl).runOnce();
    expect(third.delivered).toBe(1);
    expect((await onlyDelivery(persistence, "relay-1")).status).toBe(
      RelayDeliveryStatus.Delivered,
    );
  });

  test("parks deliveries while the relay is disabled without spending attempts", async () => {
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());
    await persistence.relays.update(relayRecord({ enabled: false }));

    const stub = stubFetch([200]);
    const relayWorker = worker(clock, stub.impl);
    for (let round = 0; round < 3; round += 1) {
      const result = await relayWorker.runOnce();
      expect(result.parked).toBe(1);
      const parked = await onlyDelivery(persistence, "relay-1");
      expect(parked.status).toBe(RelayDeliveryStatus.Pending);
      expect(parked.lastError).toBe("Relay is disabled");
      // Parking must return the attempt the claim consumed, or a long disabled
      // period would exhaust the budget before a single delivery is tried.
      expect(parked.attempts).toBe(0);
      clock.advance(400);
    }
    expect(stub.captured).toHaveLength(0);

    // Re-enabling resumes the delivery with its full attempt budget.
    await persistence.relays.update(relayRecord({ enabled: true }));
    expect((await relayWorker.runOnce()).delivered).toBe(1);
    expect((await onlyDelivery(persistence, "relay-1")).attempts).toBe(1);
  });

  test("a claimed delivery is not handed to a second worker", async () => {
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    const first = await persistence.relayDeliveries.claimDue(1000, 10, 60);
    const second = await persistence.relayDeliveries.claimDue(1000, 10, 60);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("deleting a relay cascades to its queued deliveries", async () => {
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    expect(await persistence.relays.delete("relay-1")).toBe(true);
    expect(
      await persistence.relayDeliveries.listForRelay("relay-1", 10),
    ).toHaveLength(0);
    // The worker's "relay no longer exists" branch therefore only guards
    // backends that do not enforce the foreign key.
    expect((await worker(clock).runOnce()).claimed).toBe(0);
  });

  test("drain waits for an in-flight delivery to record its outcome", async () => {
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    const gate = openGate();
    const relayWorker = worker(clock, async () => {
      await gate.opened;
      return new Response("ok", { status: 200 });
    });

    const run = relayWorker.runOnce();
    // Let the claim commit and the attempt reach the gated fetch.
    await Bun.sleep(5);
    expect((await onlyDelivery(persistence, "relay-1")).status).toBe(
      RelayDeliveryStatus.Pending,
    );

    relayWorker.stop();
    const drained = relayWorker.drain();
    // The gate opens only after drain() is already awaited, so a drain that
    // did not track the run would resolve while the delivery is still pending.
    setTimeout(gate.open, 10);
    await drained;

    expect((await onlyDelivery(persistence, "relay-1")).status).toBe(
      RelayDeliveryStatus.Delivered,
    );
    expect((await run).delivered).toBe(1);
  });

  test("a redirect is a failure and the payload is not sent onwards", async () => {
    // Following the redirect would hand the signed payload to a host the
    // operator never approved, e.g. a link-local metadata endpoint.
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    const stub = stubFetch([307]);
    const result = await worker(clock, stub.impl).runOnce();
    expect(result.retried).toBe(1);
    expect(result.delivered).toBe(0);

    // One request only: the relay never re-sends the body to the new location.
    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0]?.redirect).toBe("manual");

    const delivery = await onlyDelivery(persistence, "relay-1");
    expect(delivery.status).toBe(RelayDeliveryStatus.Pending);
    expect(delivery.lastStatusCode).toBe(307);
    expect(delivery.lastError).toContain("redirect");
  });

  test("an attempt is timed out before its lease expires", async () => {
    // The relay's stored timeout outlives the configured lease, which the admin
    // API forbids at write time but configuration drift can still produce.
    await persistence.relays.create(relayRecord({ timeoutSeconds: 600 }));
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());

    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("Expected the attempt to carry a timeout signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new Error("Attempt aborted"));
        });
      });

    const leaseSeconds = 2;
    const relayWorker = createRelayWorker({
      persistence,
      clock,
      options: {
        pollIntervalSeconds: 0,
        batchSize: 10,
        maxBackoffSeconds: 3600,
        leaseSeconds,
        parkSeconds: 300,
      },
      fetchImpl: hangingFetch,
    });

    const startedAt = Date.now();
    const result = await relayWorker.runOnce();
    const elapsedMs = Date.now() - startedAt;

    expect(result.retried).toBe(1);
    // Clamped to leaseSeconds - 1: the attempt is over before a second worker
    // could claim the same delivery.
    expect(elapsedMs).toBeLessThan(leaseSeconds * 1000);
    expect(elapsedMs).toBeGreaterThanOrEqual(500);
  });

  test("the attempt timeout is clamped below the delivery lease", () => {
    expect(effectiveTimeoutSeconds(5, 300)).toBe(5);
    expect(effectiveTimeoutSeconds(300, 300)).toBe(299);
    expect(effectiveTimeoutSeconds(600, 30)).toBe(29);
    expect(effectiveTimeoutSeconds(600, 1)).toBe(1);
  });

  test("retention sweeps a delivery parked behind a disabled relay", async () => {
    // Parking hands back the attempt the claim consumed, so the delivery never
    // turns terminal on its own; without a sweep it keeps the payload copy for
    // as long as the relay stays disabled.
    await persistence.relays.create(relayRecord());
    const clock = createFixedClock(1000);
    await enqueueRelayDeliveries(persistence, clock, webhookRecord());
    await persistence.relays.update(relayRecord({ enabled: false }));

    const stub = stubFetch([]);
    expect((await worker(clock, stub.impl).runOnce()).parked).toBe(1);
    expect((await onlyDelivery(persistence, "relay-1")).status).toBe(
      RelayDeliveryStatus.Pending,
    );

    clock.advance(365 * 24 * 60 * 60);
    const swept = await sweepExpiredRecords(persistence, clock, 30);
    expect(swept.relayDeliveries).toBe(1);
    expect(
      await persistence.relayDeliveries.listForRelay("relay-1", 10),
    ).toHaveLength(0);
    expect(stub.captured).toHaveLength(0);
  });

  test("backoff grows exponentially and is capped", () => {
    // A factor of 0.5 from the jitter source is the unjittered delay.
    const unjittered = (): number => 0.5;
    expect(backoffSeconds(10, 1, 3600, unjittered)).toBe(10);
    expect(backoffSeconds(10, 2, 3600, unjittered)).toBe(20);
    expect(backoffSeconds(10, 4, 3600, unjittered)).toBe(80);
    expect(backoffSeconds(10, 40, 100, unjittered)).toBe(100);
  });

  test("backoff is jittered so a failed batch does not retry in lockstep", () => {
    // Attempt 3 of a 10 second base is 40 seconds, jittered into [20, 60].
    expect(backoffSeconds(10, 3, 3600, () => 0)).toBe(20);
    expect(backoffSeconds(10, 3, 3600, () => 0.999)).toBe(60);

    const observed = new Set<number>();
    for (let index = 0; index < 50; index += 1) {
      const value = backoffSeconds(10, 3, 3600);
      expect(value).toBeGreaterThanOrEqual(20);
      expect(value).toBeLessThanOrEqual(60);
      observed.add(value);
    }
    expect(observed.size).toBeGreaterThan(1);
  });
});

describe("relay admin API and end-to-end forwarding", () => {
  let harness: Harness;
  let destination: CreatedDestination;
  let captured: CapturedRequest[];

  beforeEach(async () => {
    const stub = stubFetch([]);
    captured = stub.captured;
    harness = await createHarness({}, { relayFetch: stub.impl });
    destination = await createDestination(harness, {
      name: "relay destination",
      vendorAddon: "wrike",
      vendorConfig: { secret: WEBHOOK_SECRET },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  function createRelay(body: Record<string, unknown>): Promise<Response> {
    return harness.admin("/_admin/api/relays", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("forwards a received webhook to the relay target", async () => {
    const relay = await harness.adminJson<{ id: string; hasSecret: boolean }>(
      "/_admin/api/relays",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationId: destination.id,
          name: "downstream",
          targetUrl: "https://downstream.example/hook",
          secret: RELAY_SECRET,
        }),
      },
    );
    // The signing secret is write-only.
    expect(relay.hasSecret).toBe(true);
    expect(JSON.stringify(relay)).not.toContain(RELAY_SECRET);

    const accepted = await postWrikeWebhook(
      harness,
      destination.inboundUuid,
      WEBHOOK_SECRET,
      [{ eventType: "TaskCreated", taskId: "T1" }],
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ relayed: 1 });

    const result = await harness.runtime.runRelayDeliveries();
    expect(result.delivered).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://downstream.example/hook");

    const listing = await harness.adminJson<{
      relays: readonly { deliveryStats: { delivered: number } }[];
    }>("/_admin/api/relays");
    expect(listing.relays[0]?.deliveryStats.delivered).toBe(1);

    const deliveries = await harness.adminJson<{
      deliveries: readonly { status: string; attempts: number }[];
      stats: { delivered: number };
    }>(`/_admin/api/relays/${relay.id}/deliveries`);
    expect(deliveries.deliveries).toHaveLength(1);
    expect(deliveries.deliveries[0]?.status).toBe("delivered");
    expect(deliveries.stats.delivered).toBe(1);
  });

  test("validates the relay target and destination", async () => {
    expect(
      (
        await createRelay({
          destinationId: destination.id,
          name: "bad",
          targetUrl: "ftp://example.com/hook",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await createRelay({
          destinationId: destination.id,
          name: "bad",
          targetUrl: "not a url",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await createRelay({
          destinationId: "missing",
          name: "bad",
          targetUrl: "https://example.com/hook",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await createRelay({
          destinationId: destination.id,
          name: "bad",
          targetUrl: "https://example.com/hook",
          maxAttempts: 0,
        })
      ).status,
    ).toBe(400);
  });

  test("rejects a timeout that reaches the delivery lease", async () => {
    // A request still open when the lease expires would be claimed by a second
    // worker and the same webhook delivered twice.
    const rejected = await createRelay({
      destinationId: destination.id,
      name: "slow",
      targetUrl: "https://example.com/hook",
      timeoutSeconds: harness.config.relay.leaseSeconds,
    });
    expect(rejected.status).toBe(400);

    const created = await harness.adminJson<{ id: string }>(
      "/_admin/api/relays",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationId: destination.id,
          name: "slow",
          targetUrl: "https://example.com/hook",
          timeoutSeconds: harness.config.relay.leaseSeconds - 1,
        }),
      },
    );
    const patched = await harness.admin(`/_admin/api/relays/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timeoutSeconds: harness.config.relay.leaseSeconds + 1,
      }),
    });
    expect(patched.status).toBe(400);
  });

  test("updates, disables and deletes a relay", async () => {
    const relay = await harness.adminJson<{ id: string }>(
      "/_admin/api/relays",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationId: destination.id,
          name: "downstream",
          targetUrl: "https://downstream.example/hook",
          secret: RELAY_SECRET,
        }),
      },
    );

    const patched = await harness.adminJson<{
      enabled: boolean;
      hasSecret: boolean;
      targetUrl: string;
      maxAttempts: number;
    }>(`/_admin/api/relays/${relay.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        secret: null,
        targetUrl: "https://other.example/hook",
        maxAttempts: 9,
      }),
    });
    expect(patched.enabled).toBe(false);
    expect(patched.hasSecret).toBe(false);
    expect(patched.targetUrl).toBe("https://other.example/hook");
    expect(patched.maxAttempts).toBe(9);

    // A disabled relay is skipped when a webhook arrives.
    await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
      { eventType: "TaskCreated" },
    ]);
    expect((await harness.runtime.runRelayDeliveries()).claimed).toBe(0);

    expect(
      (
        await harness.admin(`/_admin/api/relays/${relay.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await harness.admin(`/_admin/api/relays/${relay.id}`)).status).toBe(
      404,
    );
  });

  test("requeues failed deliveries through the admin API", async () => {
    const relay = await harness.adminJson<{ id: string }>(
      "/_admin/api/relays",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationId: destination.id,
          name: "downstream",
          targetUrl: "https://downstream.example/hook",
          maxAttempts: 1,
        }),
      },
    );

    await harness.runtime.context.persistence.relayDeliveries.enqueue({
      id: newUuid(),
      relayId: relay.id,
      destinationId: destination.id,
      recordId: "rec-x",
      t: 1,
      payload: { a: 1 },
      status: RelayDeliveryStatus.Failed,
      attempts: 1,
      nextAttemptAt: 1,
      lastStatusCode: 500,
      lastError: "boom",
      createdAt: 1,
      updatedAt: 1,
      deliveredAt: null,
    });

    const requeued = await harness.adminJson<{ requeued: number }>(
      `/_admin/api/relays/${relay.id}/retry`,
      { method: "POST" },
    );
    expect(requeued.requeued).toBe(1);
    expect((await harness.runtime.runRelayDeliveries()).delivered).toBe(1);
  });
});

describe("relay lifecycle against the runtime", () => {
  async function relayHarness(
    envOverrides: Record<string, string>,
    fetchImpl: FetchLike,
    clock?: ReturnType<typeof createFixedClock>,
  ): Promise<{ harness: Harness; destination: CreatedDestination }> {
    const harness = await createHarness(
      envOverrides,
      clock === undefined
        ? { relayFetch: fetchImpl }
        : { relayFetch: fetchImpl, clock },
    );
    const destination = await createDestination(harness, {
      name: "relayed destination",
      vendorAddon: "wrike",
      vendorConfig: { secret: WEBHOOK_SECRET },
    });
    await harness.adminJson("/_admin/api/relays", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinationId: destination.id,
        name: "downstream",
        targetUrl: "https://downstream.example/hook",
        secret: RELAY_SECRET,
      }),
    });
    return { harness, destination };
  }

  test("shutdown drains an in-flight delivery before closing storage", async () => {
    const gate = openGate();
    const { harness, destination } = await relayHarness({}, async () => {
      await gate.opened;
      return new Response("ok", { status: 200 });
    });

    await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
      { eventType: "TaskCreated" },
    ]);

    const run = harness.runtime.runRelayDeliveries();
    await Bun.sleep(5);

    const shutdown = harness.runtime.shutdown();
    // The target only answers after shutdown has started: if shutdown closed
    // the database without draining, markDelivered would fail and the delivery
    // would stay pending and be re-sent after the lease expires.
    setTimeout(gate.open, 10);
    await shutdown;

    expect((await run).delivered).toBe(1);
    await harness.close();
  });

  test("retention removes the payload copy held by a delivered relay job", async () => {
    const clock = createFixedClock(1000);
    const stub = stubFetch([200]);
    const { harness, destination } = await relayHarness(
      { WEBHOOKY_RETENTION_SECONDS: "30" },
      stub.impl,
      clock,
    );

    try {
      await postWrikeWebhook(harness, destination.inboundUuid, WEBHOOK_SECRET, [
        { eventType: "TaskCreated" },
      ]);
      expect((await harness.runtime.runRelayDeliveries()).delivered).toBe(1);

      const relays = await harness.runtime.context.persistence.relays.list();
      const relayId = relays[0]?.id;
      if (relayId === undefined) {
        throw new Error("Expected the relay to exist");
      }

      clock.advance(60);
      const swept = await harness.runtime.sweepRetention();
      expect(swept.records).toBe(1);
      expect(swept.relayDeliveries).toBe(1);
      expect(
        await harness.runtime.context.persistence.relayDeliveries.listForRelay(
          relayId,
          10,
        ),
      ).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
