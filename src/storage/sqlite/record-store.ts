/**
 * Webhook record store implemented on the SQL driver port.
 *
 * `queryAndMark` performs the read and the fetched-marking inside a single
 * transaction so two concurrent `only_unfetched` readers cannot both receive
 * the same record as unfetched.
 */
import type { RecordStore } from "../persistence";
import {
  boolToInt,
  placeholders,
  type SqlDriver,
  type SqlParam,
} from "../sql-driver";
import type { RecordQuery, WebhookRecord } from "../types";
import { type CountRow, type RecordRow, toWebhookRecord } from "./rows";

const COLUMNS = "id, destination_id, t, fetched, payload";

interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

function compileQuery(query: RecordQuery): CompiledQuery {
  const conditions: string[] = ["destination_id = ?"];
  const params: SqlParam[] = [query.destinationId];

  if (query.onlyUnfetched) {
    conditions.push("fetched = 0");
  }
  if (query.from !== null) {
    conditions.push("t >= ?");
    params.push(query.from);
  }
  if (query.to !== null) {
    conditions.push("t <= ?");
    params.push(query.to);
  }
  params.push(query.limit);

  return {
    sql: `SELECT ${COLUMNS} FROM records
          WHERE ${conditions.join(" AND ")}
          ORDER BY t DESC, id DESC
          LIMIT ?`,
    params,
  };
}

export function createRecordStore(driver: SqlDriver): RecordStore {
  async function selectRecords(
    executor: SqlDriver,
    query: RecordQuery,
  ): Promise<readonly WebhookRecord[]> {
    const compiled = compileQuery(query);
    const rows = await executor.all<RecordRow>(compiled.sql, compiled.params);
    return rows.map(toWebhookRecord);
  }

  async function countForDestination(destinationId: string): Promise<number> {
    const row = await driver.get<CountRow>(
      "SELECT COUNT(*) AS count FROM records WHERE destination_id = ?",
      [destinationId],
    );
    return row?.count ?? 0;
  }

  return {
    async insert(record: WebhookRecord): Promise<void> {
      await driver.run(
        `INSERT INTO records (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
        [
          record.id,
          record.destinationId,
          record.t,
          boolToInt(record.fetched),
          JSON.stringify(record.payload),
        ],
      );
    },

    query(query: RecordQuery): Promise<readonly WebhookRecord[]> {
      return selectRecords(driver, query);
    },

    queryAndMark(query: RecordQuery): Promise<readonly WebhookRecord[]> {
      return driver.transaction(async (tx) => {
        const records = await selectRecords(tx, query);
        const unmarked = records.filter((record) => record.fetched === false);
        if (unmarked.length > 0) {
          await tx.run(
            `UPDATE records SET fetched = 1
             WHERE id IN (${placeholders(unmarked.length)})`,
            unmarked.map((record) => record.id),
          );
        }
        return records;
      });
    },

    countForDestination,

    deleteExpired(
      nowSeconds: number,
      defaultRetentionSeconds: number,
    ): Promise<number> {
      // Effective retention is the per-destination override when present,
      // otherwise the configured default. A value of 0 or less disables
      // deletion for that destination.
      //
      // The selection runs once: counting it separately would scan the table a
      // second time while holding the write lock, and the driver reports the
      // deleted row count anyway.
      //
      // CROSS JOIN pins the loop order to destinations-then-records. The cutoff
      // is only a constant once a destination is known, so with records as the
      // outer loop the planner has to scan every row; driven from destinations
      // it takes an `idx_records_destination_t` range per destination instead.
      const selection = `
        SELECT r.id FROM destinations d
        CROSS JOIN records r ON r.destination_id = d.id
        WHERE COALESCE(d.retention_seconds, ?) > 0
          AND r.t < ? - COALESCE(d.retention_seconds, ?)`;
      const params: readonly SqlParam[] = [
        defaultRetentionSeconds,
        nowSeconds,
        defaultRetentionSeconds,
      ];
      return driver.runAffected(
        `DELETE FROM records WHERE id IN (${selection})`,
        params,
      );
    },

    async deleteForDestination(destinationId: string): Promise<number> {
      const count = await countForDestination(destinationId);
      await driver.run("DELETE FROM records WHERE destination_id = ?", [
        destinationId,
      ]);
      return count;
    },
  };
}
