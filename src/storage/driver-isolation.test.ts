/**
 * Regression tests for SQL driver transaction isolation.
 *
 * These cover the two failure modes an earlier implementation allowed: a second
 * transaction started during an open one silently joined it (so two
 * `only_unfetched` readers could claim the same record), and plain statements
 * ran inside whatever transaction happened to be open (so an unrelated rollback
 * discarded a write that had already been acknowledged).
 */
import { describe, expect, test } from "bun:test";
import type { PersistenceAdapter } from "./persistence";
import { createSqlPersistenceAdapter } from "./sqlite/adapter";
import { createBunSqliteDriver } from "./sqlite/bun-driver";
import type { SqlDriver } from "./sql-driver";
import type { DestinationRecord, WebhookRecord } from "./types";

const DESTINATION: DestinationRecord = {
  id: "dest-1",
  name: "Isolation",
  vendorAddon: "passthrough",
  destinationAddon: null,
  inboundUuid: "inbound-1",
  fetchUuid: "fetch-1",
  vendorConfig: {},
  destinationConfig: {},
  retentionSeconds: null,
  enabled: true,
  createdAt: 1,
  createdBy: null,
};

function record(id: string, t: number): WebhookRecord {
  return {
    id,
    destinationId: DESTINATION.id,
    t,
    fetched: false,
    payload: { id },
  };
}

async function setup(): Promise<{
  driver: SqlDriver;
  persistence: PersistenceAdapter;
}> {
  const driver = createBunSqliteDriver(":memory:");
  const persistence = createSqlPersistenceAdapter(driver);
  await persistence.init();
  await persistence.destinations.create(DESTINATION);
  return { driver, persistence };
}

const UNFETCHED_QUERY = {
  destinationId: DESTINATION.id,
  onlyUnfetched: true,
  from: null,
  to: null,
  limit: 10,
} as const;

describe("sql driver isolation", () => {
  test("concurrent only_unfetched readers never receive the same record", async () => {
    const { driver, persistence } = await setup();
    try {
      for (let index = 0; index < 3; index += 1) {
        await persistence.records.insert(record(`r${index}`, 100 + index));
      }

      const first = persistence.records.queryAndMark(UNFETCHED_QUERY);
      // The second reader starts after one microtask tick, i.e. while the first
      // transaction is between BEGIN and COMMIT.
      await Promise.resolve();
      const second = persistence.records.queryAndMark(UNFETCHED_QUERY);

      const [a, b] = await Promise.all([first, second]);
      const idsA = a.map((row) => row.id);
      const idsB = b.map((row) => row.id);

      expect(idsA.some((id) => idsB.includes(id))).toBe(false);
      expect([...idsA, ...idsB].sort()).toEqual(["r0", "r1", "r2"]);
    } finally {
      await driver.close();
    }
  });

  test("a write acknowledged during an open transaction survives its rollback", async () => {
    const { driver, persistence } = await setup();
    try {
      // The gate holds the transaction open past its first statement, so the
      // unrelated insert below is issued strictly between BEGIN and ROLLBACK.
      let releaseTransaction: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });

      const failing = driver.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO records (id, destination_id, t, fetched, payload) VALUES (?, ?, ?, 0, ?)",
          ["rolled-back", DESTINATION.id, 100, "{}"],
        );
        await gate;
        throw new Error("transaction failed");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const unrelated = persistence.records.insert(record("survivor", 200));
      releaseTransaction();

      await expect(failing).rejects.toThrow("transaction failed");
      await unrelated;

      const rows = await persistence.records.query({
        destinationId: DESTINATION.id,
        onlyUnfetched: false,
        from: null,
        to: null,
        limit: 10,
      });
      expect(rows.map((row) => row.id)).toEqual(["survivor"]);
    } finally {
      await driver.close();
    }
  });

  test("statements issued during a transaction observe its committed result", async () => {
    const { driver, persistence } = await setup();
    try {
      const committing = driver.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO records (id, destination_id, t, fetched, payload) VALUES (?, ?, ?, 0, ?)",
          ["committed", DESTINATION.id, 100, "{}"],
        );
        return "done";
      });
      const counted = persistence.records.countForDestination(DESTINATION.id);

      expect(await committing).toBe("done");
      // The count was queued behind the transaction, so it sees the insert.
      expect(await counted).toBe(1);
    } finally {
      await driver.close();
    }
  });
});
