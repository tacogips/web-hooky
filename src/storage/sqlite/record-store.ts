/**
 * Webhook record store implemented on the SQL driver port.
 *
 * `queryAndMark` claims records with a single `UPDATE ... WHERE fetched = 0
 * ... RETURNING`, so two concurrent `only_unfetched` readers cannot both
 * receive the same record as unfetched. One statement rather than a
 * read-then-write transaction keeps that guarantee on drivers with no
 * interactive transactions, such as Cloudflare D1.
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

/** The `WHERE` fragment shared by the read and the claim, without the limit. */
interface CompiledConditions {
  readonly where: string;
  readonly params: readonly SqlParam[];
}

const ORDER = "ORDER BY t DESC, id DESC";

function compileConditions(query: RecordQuery): CompiledConditions {
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

  return { where: conditions.join(" AND "), params };
}

function compileQuery(query: RecordQuery): CompiledQuery {
  const conditions = compileConditions(query);
  return {
    sql: `SELECT ${COLUMNS} FROM records
          WHERE ${conditions.where}
          ${ORDER}
          LIMIT ?`,
    params: [...conditions.params, query.limit],
  };
}

/** Receipt order: newest first, ties broken by id, matching `ORDER`. */
function byReceiptDescending(
  left: WebhookRecord,
  right: WebhookRecord,
): number {
  if (left.t !== right.t) {
    return right.t - left.t;
  }
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
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

    async queryAndMark(query: RecordQuery): Promise<readonly WebhookRecord[]> {
      const conditions = compileConditions(query);
      const window = `SELECT id FROM records
                      WHERE ${conditions.where}
                      ${ORDER}
                      LIMIT ?`;

      // The claim is one statement, so it is atomic on every driver, including
      // those without interactive transactions (Cloudflare D1). `fetched = 0`
      // inside the UPDATE is what makes it exclusive: of two concurrent
      // readers, only the first matches a given row, so RETURNING hands each
      // record to exactly one caller. That is the guarantee `only_unfetched`
      // rests on.
      const claimedRows = await driver.all<RecordRow>(
        `UPDATE records SET fetched = 1
         WHERE id IN (${window}) AND fetched = 0
         RETURNING ${COLUMNS}`,
        [...conditions.params, query.limit],
      );
      // RETURNING reports post-update rows, but the response must carry the
      // value each record had *before* this call marked it - that is the only
      // signal telling a client which records are new to it.
      const claimed = claimedRows.map((row) => ({
        ...toWebhookRecord(row),
        fetched: false,
      }));

      if (query.onlyUnfetched) {
        return claimed.sort(byReceiptDescending);
      }

      // A plain read also returns the already-fetched part of the window. Those
      // rows are not being claimed, so they need no atomicity with the step
      // above; the rows this call just marked are excluded by id.
      const claimedIds = claimed.map((record) => record.id);
      const exclusion =
        claimedIds.length === 0
          ? ""
          : `AND id NOT IN (${placeholders(claimedIds.length)})`;
      const alreadyFetched = await driver.all<RecordRow>(
        `SELECT ${COLUMNS} FROM records
         WHERE ${conditions.where} AND fetched = 1 ${exclusion}
         ${ORDER}
         LIMIT ?`,
        [...conditions.params, ...claimedIds, query.limit],
      );

      return [...claimed, ...alreadyFetched.map(toWebhookRecord)]
        .sort(byReceiptDescending)
        .slice(0, query.limit);
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
