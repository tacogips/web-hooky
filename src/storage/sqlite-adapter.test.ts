import { beforeEach, describe, expect, test } from "bun:test";
import { createFixedClock } from "../core/time";
import { cacheKeys, createMemoryCache } from "./cache";
import type { PersistenceAdapter } from "./persistence";
import { sweepExpiredRecords } from "./retention";
import { createBunSqlitePersistence } from "./sqlite/bun-adapter";
import {
  AdminRole,
  RelayDeliveryStatus,
  type DestinationRecord,
  type RelayDeliveryRecord,
  type RelayRecord,
  type WebhookRecord,
} from "./types";

function destination(overrides: Partial<DestinationRecord> = {}) {
  const base: DestinationRecord = {
    id: "dest-1",
    name: "Test destination",
    vendorAddon: "wrike",
    destinationAddon: null,
    inboundUuid: "inbound-1",
    fetchUuid: "fetch-1",
    vendorConfig: { secret: "s3cret" },
    destinationConfig: {},
    retentionSeconds: null,
    enabled: true,
    createdAt: 1000,
    createdBy: "admin",
  };
  return { ...base, ...overrides };
}

function record(
  id: string,
  t: number,
  overrides: Partial<WebhookRecord> = {},
): WebhookRecord {
  return {
    id,
    destinationId: "dest-1",
    t,
    fetched: false,
    payload: { value: id },
    ...overrides,
  };
}

function relay(overrides: Partial<RelayRecord> = {}): RelayRecord {
  return {
    id: "relay-1",
    destinationId: "dest-1",
    name: "downstream",
    targetUrl: "https://downstream.example/hook",
    secret: null,
    enabled: true,
    maxAttempts: 3,
    backoffSeconds: 10,
    timeoutSeconds: 5,
    createdAt: 1,
    createdBy: "admin",
    ...overrides,
  };
}

function delivery(
  id: string,
  t: number,
  overrides: Partial<RelayDeliveryRecord> = {},
): RelayDeliveryRecord {
  return {
    id,
    relayId: "relay-1",
    destinationId: "dest-1",
    recordId: `record-${id}`,
    t,
    payload: { value: id },
    status: RelayDeliveryStatus.Pending,
    attempts: 0,
    nextAttemptAt: t,
    lastStatusCode: null,
    lastError: null,
    createdAt: t,
    updatedAt: t,
    deliveredAt: null,
    ...overrides,
  };
}

describe("sql persistence adapter", () => {
  let persistence: PersistenceAdapter;

  beforeEach(async () => {
    persistence = createBunSqlitePersistence(":memory:");
    await persistence.init();
  });

  test("init is idempotent", async () => {
    await persistence.init();
    expect(await persistence.destinations.list()).toEqual([]);
  });

  test("stores and looks up destinations by every key", async () => {
    const value = destination();
    await persistence.destinations.create(value);

    expect(await persistence.destinations.findById("dest-1")).toEqual(value);
    expect(
      await persistence.destinations.findByInboundUuid("inbound-1"),
    ).toEqual(value);
    expect(await persistence.destinations.findByFetchUuid("fetch-1")).toEqual(
      value,
    );
    expect(await persistence.destinations.findById("missing")).toBeNull();
  });

  test("updates and deletes destinations", async () => {
    await persistence.destinations.create(destination());
    await persistence.destinations.update(
      destination({ name: "Renamed", enabled: false }),
    );
    const updated = await persistence.destinations.findById("dest-1");
    expect(updated?.name).toBe("Renamed");
    expect(updated?.enabled).toBe(false);

    expect(await persistence.destinations.delete("dest-1")).toBe(true);
    expect(await persistence.destinations.delete("dest-1")).toBe(false);
  });

  test("counts destinations using an addon in either role", async () => {
    await persistence.destinations.create(destination());
    await persistence.destinations.create(
      destination({
        id: "dest-2",
        inboundUuid: "inbound-2",
        fetchUuid: "fetch-2",
        destinationAddon: "envelope",
      }),
    );
    expect(await persistence.destinations.countUsingAddon("wrike")).toBe(2);
    expect(await persistence.destinations.countUsingAddon("envelope")).toBe(1);
    expect(await persistence.destinations.countUsingAddon("github")).toBe(0);
  });

  describe("records", () => {
    beforeEach(async () => {
      await persistence.destinations.create(destination());
      await persistence.records.insert(record("r1", 100));
      await persistence.records.insert(record("r2", 200));
      await persistence.records.insert(record("r3", 300));
    });

    test("returns records in descending receipt order", async () => {
      const rows = await persistence.records.query({
        destinationId: "dest-1",
        onlyUnfetched: false,
        from: null,
        to: null,
        limit: 10,
      });
      expect(rows.map((row) => row.t)).toEqual([300, 200, 100]);
    });

    test("applies the receipt datetime range and limit", async () => {
      const rows = await persistence.records.query({
        destinationId: "dest-1",
        onlyUnfetched: false,
        from: 150,
        to: 250,
        limit: 10,
      });
      expect(rows.map((row) => row.id)).toEqual(["r2"]);

      const limited = await persistence.records.query({
        destinationId: "dest-1",
        onlyUnfetched: false,
        from: null,
        to: null,
        limit: 2,
      });
      expect(limited).toHaveLength(2);
    });

    test("queryAndMark marks the returned records only", async () => {
      const first = await persistence.records.queryAndMark({
        destinationId: "dest-1",
        onlyUnfetched: true,
        from: null,
        to: null,
        limit: 2,
      });
      expect(first.map((row) => row.id)).toEqual(["r3", "r2"]);
      // The response reports the state before marking.
      expect(first.every((row) => row.fetched === false)).toBe(true);

      const second = await persistence.records.queryAndMark({
        destinationId: "dest-1",
        onlyUnfetched: true,
        from: null,
        to: null,
        limit: 10,
      });
      expect(second.map((row) => row.id)).toEqual(["r1"]);

      const third = await persistence.records.queryAndMark({
        destinationId: "dest-1",
        onlyUnfetched: true,
        from: null,
        to: null,
        limit: 10,
      });
      expect(third).toHaveLength(0);
    });

    test("query does not mark records", async () => {
      await persistence.records.query({
        destinationId: "dest-1",
        onlyUnfetched: true,
        from: null,
        to: null,
        limit: 10,
      });
      const rows = await persistence.records.query({
        destinationId: "dest-1",
        onlyUnfetched: true,
        from: null,
        to: null,
        limit: 10,
      });
      expect(rows).toHaveLength(3);
    });

    test("counts and deletes per destination", async () => {
      expect(await persistence.records.countForDestination("dest-1")).toBe(3);
      expect(await persistence.records.deleteForDestination("dest-1")).toBe(3);
      expect(await persistence.records.countForDestination("dest-1")).toBe(0);
    });

    test("preserves payload structure", async () => {
      await persistence.records.insert(
        record("r4", 400, { payload: { nested: { list: [1, "two", null] } } }),
      );
      const rows = await persistence.records.query({
        destinationId: "dest-1",
        onlyUnfetched: false,
        from: 400,
        to: 400,
        limit: 1,
      });
      expect(rows[0]?.payload).toEqual({ nested: { list: [1, "two", null] } });
    });
  });

  describe("retention", () => {
    test("deletes records past the default retention window", async () => {
      await persistence.destinations.create(destination());
      await persistence.records.insert(record("old", 100));
      await persistence.records.insert(record("new", 900));

      const clock = createFixedClock(1000);
      const swept = await sweepExpiredRecords(persistence, clock, 500);
      expect(swept.records).toBe(1);
      expect(await persistence.records.countForDestination("dest-1")).toBe(1);
    });

    test("honours a per-destination retention override", async () => {
      await persistence.destinations.create(
        destination({ retentionSeconds: 50 }),
      );
      await persistence.records.insert(record("old", 900));
      const clock = createFixedClock(1000);
      const swept = await sweepExpiredRecords(persistence, clock, 100_000);
      expect(swept.records).toBe(1);
    });

    test("retention of zero disables deletion", async () => {
      await persistence.destinations.create(
        destination({ retentionSeconds: 0 }),
      );
      await persistence.records.insert(record("old", 1));
      const clock = createFixedClock(1_000_000);
      const swept = await sweepExpiredRecords(persistence, clock, 10);
      expect(swept.records).toBe(0);
    });

    test("prunes terminal relay deliveries but keeps pending ones", async () => {
      // A delivery carries a copy of the record's payload, so retention has to
      // reach it; a pending delivery still owes someone a webhook and is kept
      // however old it is.
      await persistence.destinations.create(destination());
      await persistence.relays.create(relay());
      await persistence.relayDeliveries.enqueue(
        delivery("old-delivered", 100, {
          status: RelayDeliveryStatus.Delivered,
          deliveredAt: 100,
        }),
      );
      await persistence.relayDeliveries.enqueue(
        delivery("old-failed", 100, { status: RelayDeliveryStatus.Failed }),
      );
      await persistence.relayDeliveries.enqueue(delivery("old-pending", 100));
      await persistence.relayDeliveries.enqueue(
        delivery("recent-delivered", 900, {
          status: RelayDeliveryStatus.Delivered,
          deliveredAt: 900,
        }),
      );

      const clock = createFixedClock(1000);
      const swept = await sweepExpiredRecords(persistence, clock, 500);
      expect(swept.relayDeliveries).toBe(2);

      const remaining = await persistence.relayDeliveries.listForRelay(
        "relay-1",
        10,
      );
      expect(remaining.map((row) => row.id).sort()).toEqual([
        "old-pending",
        "recent-delivered",
      ]);
      // The stored payload is gone with the row, not merely unreachable.
      expect(JSON.stringify(remaining)).not.toContain("old-delivered");
    });

    test("sweeps a pending delivery whose relay is disabled", async () => {
      // A disabled relay's deliveries are parked, and parking returns the
      // attempt the claim consumed, so they never reach a terminal status. Left
      // alone they would hold their payload copy past the retention window for
      // as long as the relay stays disabled.
      await persistence.destinations.create(destination());
      await persistence.relays.create(relay({ enabled: false }));
      await persistence.relays.create(relay({ id: "relay-2", enabled: true }));
      await persistence.relayDeliveries.enqueue(delivery("parked", 100));
      await persistence.relayDeliveries.enqueue(
        delivery("still-queued", 100, { relayId: "relay-2" }),
      );

      const clock = createFixedClock(1000);
      const swept = await sweepExpiredRecords(persistence, clock, 500);
      expect(swept.relayDeliveries).toBe(1);

      expect(
        await persistence.relayDeliveries.listForRelay("relay-1", 10),
      ).toHaveLength(0);
      // The enabled relay still owes its target a webhook, so its pending
      // delivery is kept however old it is.
      expect(
        await persistence.relayDeliveries.listForRelay("relay-2", 10),
      ).toHaveLength(1);
    });

    test("relay delivery retention honours the per-destination override", async () => {
      await persistence.destinations.create(
        destination({ retentionSeconds: 50 }),
      );
      await persistence.relays.create(relay());
      await persistence.relayDeliveries.enqueue(
        delivery("aged", 900, { status: RelayDeliveryStatus.Delivered }),
      );

      const clock = createFixedClock(1000);
      const swept = await sweepExpiredRecords(persistence, clock, 100_000);
      expect(swept.relayDeliveries).toBe(1);
    });

    test("relay delivery retention of zero disables deletion", async () => {
      await persistence.destinations.create(
        destination({ retentionSeconds: 0 }),
      );
      await persistence.relays.create(relay());
      await persistence.relayDeliveries.enqueue(
        delivery("ancient", 1, { status: RelayDeliveryStatus.Delivered }),
      );

      const clock = createFixedClock(1_000_000);
      const swept = await sweepExpiredRecords(persistence, clock, 10);
      expect(swept.relayDeliveries).toBe(0);
    });
  });

  describe("api users", () => {
    test("stores grants and reports them", async () => {
      await persistence.destinations.create(destination());
      await persistence.apiUsers.create({
        id: "key-1",
        label: "consumer",
        secretHash: "hash",
        enabled: true,
        createdAt: 10,
      });

      expect(await persistence.apiUsers.hasGrant("key-1", "dest-1")).toBe(
        false,
      );
      await persistence.apiUsers.grant("key-1", "dest-1", 20);
      await persistence.apiUsers.grant("key-1", "dest-1", 20);
      expect(await persistence.apiUsers.listGrants("key-1")).toEqual([
        "dest-1",
      ]);
      expect(await persistence.apiUsers.hasGrant("key-1", "dest-1")).toBe(true);

      await persistence.apiUsers.revoke("key-1", "dest-1");
      expect(await persistence.apiUsers.hasGrant("key-1", "dest-1")).toBe(
        false,
      );
    });

    test("deleting a destination cascades to grants", async () => {
      await persistence.destinations.create(destination());
      await persistence.apiUsers.create({
        id: "key-1",
        label: "consumer",
        secretHash: "hash",
        enabled: true,
        createdAt: 10,
      });
      await persistence.apiUsers.grant("key-1", "dest-1", 20);
      await persistence.destinations.delete("dest-1");
      expect(await persistence.apiUsers.listGrants("key-1")).toEqual([]);
    });
  });

  describe("admin stores", () => {
    test("upserts admin users idempotently", async () => {
      await persistence.adminUsers.upsert({
        subject: "a@example.com",
        role: AdminRole.Admin,
        createdAt: 1,
      });
      await persistence.adminUsers.upsert({
        subject: "a@example.com",
        role: AdminRole.Admin,
        createdAt: 2,
      });
      expect(await persistence.adminUsers.list()).toHaveLength(1);
      expect(
        await persistence.adminUsers.findBySubject("a@example.com"),
      ).not.toBeNull();
      expect(await persistence.adminUsers.delete("a@example.com")).toBe(true);
    });

    test("stores admin keys", async () => {
      await persistence.adminKeys.create({
        id: "k1",
        label: "ops",
        secretHash: "hash",
        enabled: true,
        createdAt: 5,
      });
      expect((await persistence.adminKeys.findById("k1"))?.label).toBe("ops");
      expect(await persistence.adminKeys.list()).toHaveLength(1);
    });
  });
});

describe("memory cache", () => {
  test("expires entries after the ttl", async () => {
    let now = 0;
    const cache = createMemoryCache(() => now);
    await cache.set("k", "v", 10);
    expect(await cache.get("k")).toBe("v");
    now = 11_000;
    expect(await cache.get("k")).toBeNull();
  });

  test("a non-positive ttl skips caching", async () => {
    const cache = createMemoryCache(() => 0);
    await cache.set("k", "v", 0);
    expect(await cache.get("k")).toBeNull();
  });

  test("deletes by prefix", async () => {
    const cache = createMemoryCache(() => 0);
    await cache.set(cacheKeys.grant("u1", "d1"), "1", 60);
    await cache.set(cacheKeys.grant("u1", "d2"), "1", 60);
    await cache.set(cacheKeys.apiUser("u1"), "x", 60);
    await cache.deleteByPrefix("grant:u1:");
    expect(await cache.get(cacheKeys.grant("u1", "d1"))).toBeNull();
    expect(await cache.get(cacheKeys.apiUser("u1"))).toBe("x");
  });
});
