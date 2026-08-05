/**
 * Relay and relay-delivery stores implemented on the SQL driver port.
 *
 * `claimDue` reads and leases inside a single transaction, so two workers (or
 * one worker overlapping with itself) cannot pick up the same delivery.
 */
import type { RelayDeliveryStore, RelayStore } from "../persistence";
import {
  boolToInt,
  placeholders,
  type SqlDriver,
  type SqlParam,
} from "../sql-driver";
import {
  RelayDeliveryStatus,
  type RelayDeliveryRecord,
  type RelayDeliveryStats,
  type RelayRecord,
} from "../types";
import {
  type RelayDeliveryRow,
  type RelayRow,
  type StatusCountRow,
  toRelay,
  toRelayDelivery,
} from "./rows";

const RELAY_COLUMNS = `id, destination_id, name, target_url, secret, enabled,
  max_attempts, backoff_seconds, timeout_seconds, created_at, created_by`;

const DELIVERY_COLUMNS = `id, relay_id, destination_id, record_id, t, payload,
  status, attempts, next_attempt_at, last_status_code, last_error, created_at,
  updated_at, delivered_at`;

export function createRelayStore(driver: SqlDriver): RelayStore {
  async function listWhere(
    condition: string,
    params: readonly SqlParam[],
  ): Promise<readonly RelayRecord[]> {
    const rows = await driver.all<RelayRow>(
      `SELECT ${RELAY_COLUMNS} FROM relays ${condition}
       ORDER BY created_at DESC, id ASC`,
      params,
    );
    return rows.map(toRelay);
  }

  return {
    async create(relay: RelayRecord): Promise<void> {
      await driver.run(
        `INSERT INTO relays (${RELAY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          relay.id,
          relay.destinationId,
          relay.name,
          relay.targetUrl,
          relay.secret,
          boolToInt(relay.enabled),
          relay.maxAttempts,
          relay.backoffSeconds,
          relay.timeoutSeconds,
          relay.createdAt,
          relay.createdBy,
        ],
      );
    },

    async update(relay: RelayRecord): Promise<void> {
      await driver.run(
        `UPDATE relays SET
           name = ?, target_url = ?, secret = ?, enabled = ?, max_attempts = ?,
           backoff_seconds = ?, timeout_seconds = ?
         WHERE id = ?`,
        [
          relay.name,
          relay.targetUrl,
          relay.secret,
          boolToInt(relay.enabled),
          relay.maxAttempts,
          relay.backoffSeconds,
          relay.timeoutSeconds,
          relay.id,
        ],
      );
    },

    async delete(id: string): Promise<boolean> {
      const existing = await driver.get<RelayRow>(
        `SELECT ${RELAY_COLUMNS} FROM relays WHERE id = ?`,
        [id],
      );
      if (existing === null) {
        return false;
      }
      await driver.run("DELETE FROM relays WHERE id = ?", [id]);
      return true;
    },

    async findById(id: string): Promise<RelayRecord | null> {
      const row = await driver.get<RelayRow>(
        `SELECT ${RELAY_COLUMNS} FROM relays WHERE id = ?`,
        [id],
      );
      return row === null ? null : toRelay(row);
    },

    list(): Promise<readonly RelayRecord[]> {
      return listWhere("", []);
    },

    listForDestination(destinationId: string): Promise<readonly RelayRecord[]> {
      return listWhere("WHERE destination_id = ?", [destinationId]);
    },

    listEnabledForDestination(
      destinationId: string,
    ): Promise<readonly RelayRecord[]> {
      return listWhere("WHERE destination_id = ? AND enabled = 1", [
        destinationId,
      ]);
    },
  };
}

export function createRelayDeliveryStore(
  driver: SqlDriver,
): RelayDeliveryStore {
  return {
    async enqueue(delivery: RelayDeliveryRecord): Promise<void> {
      await driver.run(
        `INSERT INTO relay_deliveries (${DELIVERY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          delivery.id,
          delivery.relayId,
          delivery.destinationId,
          delivery.recordId,
          delivery.t,
          JSON.stringify(delivery.payload),
          delivery.status,
          delivery.attempts,
          delivery.nextAttemptAt,
          delivery.lastStatusCode,
          delivery.lastError,
          delivery.createdAt,
          delivery.updatedAt,
          delivery.deliveredAt,
        ],
      );
    },

    claimDue(
      nowSeconds: number,
      limit: number,
      leaseSeconds: number,
    ): Promise<readonly RelayDeliveryRecord[]> {
      return driver.transaction(async (tx) => {
        const rows = await tx.all<RelayDeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM relay_deliveries
           WHERE status = ? AND next_attempt_at <= ?
           ORDER BY next_attempt_at ASC, created_at ASC, id ASC
           LIMIT ?`,
          [RelayDeliveryStatus.Pending, nowSeconds, limit],
        );
        if (rows.length === 0) {
          return [];
        }
        const ids = rows.map((row) => row.id);
        // The lease keeps a claimed delivery out of the next batch even if the
        // worker crashes mid-attempt; it becomes due again afterwards.
        await tx.run(
          `UPDATE relay_deliveries
           SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
           WHERE id IN (${placeholders(ids.length)})`,
          [nowSeconds + leaseSeconds, nowSeconds, ...ids],
        );
        return rows.map((row) => ({
          ...toRelayDelivery(row),
          attempts: row.attempts + 1,
        }));
      });
    },

    async markDelivered(
      id: string,
      nowSeconds: number,
      statusCode: number | null,
    ): Promise<void> {
      await driver.run(
        `UPDATE relay_deliveries
         SET status = ?, last_status_code = ?, last_error = NULL,
             updated_at = ?, delivered_at = ?
         WHERE id = ?`,
        [RelayDeliveryStatus.Delivered, statusCode, nowSeconds, nowSeconds, id],
      );
    },

    async reschedule(
      id: string,
      nowSeconds: number,
      nextAttemptAt: number,
      statusCode: number | null,
      error: string,
    ): Promise<void> {
      await driver.run(
        `UPDATE relay_deliveries
         SET status = ?, next_attempt_at = ?, last_status_code = ?,
             last_error = ?, updated_at = ?
         WHERE id = ?`,
        [
          RelayDeliveryStatus.Pending,
          nextAttemptAt,
          statusCode,
          error,
          nowSeconds,
          id,
        ],
      );
    },

    async park(
      id: string,
      nowSeconds: number,
      nextAttemptAt: number,
      reason: string,
    ): Promise<void> {
      await driver.run(
        `UPDATE relay_deliveries
         SET status = ?, next_attempt_at = ?, attempts = MAX(attempts - 1, 0),
             last_error = ?, updated_at = ?
         WHERE id = ?`,
        [RelayDeliveryStatus.Pending, nextAttemptAt, reason, nowSeconds, id],
      );
    },

    async markFailed(
      id: string,
      nowSeconds: number,
      statusCode: number | null,
      error: string,
    ): Promise<void> {
      await driver.run(
        `UPDATE relay_deliveries
         SET status = ?, last_status_code = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [RelayDeliveryStatus.Failed, statusCode, error, nowSeconds, id],
      );
    },

    requeueFailed(relayId: string, nowSeconds: number): Promise<number> {
      return driver.transaction(async (tx) => {
        const rows = await tx.all<{ id: string }>(
          "SELECT id FROM relay_deliveries WHERE relay_id = ? AND status = ?",
          [relayId, RelayDeliveryStatus.Failed],
        );
        if (rows.length === 0) {
          return 0;
        }
        await tx.run(
          `UPDATE relay_deliveries
           SET status = ?, attempts = 0, next_attempt_at = ?, updated_at = ?
           WHERE relay_id = ? AND status = ?`,
          [
            RelayDeliveryStatus.Pending,
            nowSeconds,
            nowSeconds,
            relayId,
            RelayDeliveryStatus.Failed,
          ],
        );
        return rows.length;
      });
    },

    deleteExpired(
      nowSeconds: number,
      defaultRetentionSeconds: number,
    ): Promise<number> {
      // Mirrors records.deleteExpired: the per-destination override wins and a
      // window of zero or less disables deletion.
      //
      // Terminal deliveries are always removed. A pending delivery normally
      // survives - it still owes someone a webhook - but one whose relay is
      // disabled or gone is parked indefinitely: parking hands back the attempt
      // the claim consumed, so the row never reaches `maxAttempts`, never turns
      // terminal, and would keep its payload copy past the retention window
      // forever. Those are swept once they are past the window.
      const selection = `
        SELECT rd.id FROM destinations d
        CROSS JOIN relay_deliveries rd ON rd.destination_id = d.id
        LEFT JOIN relays r ON r.id = rd.relay_id
        WHERE COALESCE(d.retention_seconds, ?) > 0
          AND rd.t < ? - COALESCE(d.retention_seconds, ?)
          AND (rd.status IN (?, ?)
               OR (rd.status = ? AND (r.id IS NULL OR r.enabled = 0)))`;
      const params: readonly SqlParam[] = [
        defaultRetentionSeconds,
        nowSeconds,
        defaultRetentionSeconds,
        RelayDeliveryStatus.Delivered,
        RelayDeliveryStatus.Failed,
        RelayDeliveryStatus.Pending,
      ];
      // One pass over the selection, with the driver reporting the deleted
      // count. As in records.deleteExpired, CROSS JOIN drives the loop from
      // destinations so each one takes an `idx_relay_deliveries_destination_t`
      // range instead of the planner scanning the whole table.
      return driver.runAffected(
        `DELETE FROM relay_deliveries WHERE id IN (${selection})`,
        params,
      );
    },

    async listForRelay(
      relayId: string,
      limit: number,
    ): Promise<readonly RelayDeliveryRecord[]> {
      const rows = await driver.all<RelayDeliveryRow>(
        `SELECT ${DELIVERY_COLUMNS} FROM relay_deliveries
         WHERE relay_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [relayId, limit],
      );
      return rows.map(toRelayDelivery);
    },

    async statsForRelay(relayId: string): Promise<RelayDeliveryStats> {
      const rows = await driver.all<StatusCountRow>(
        `SELECT status, COUNT(*) AS count FROM relay_deliveries
         WHERE relay_id = ? GROUP BY status`,
        [relayId],
      );
      const stats = { pending: 0, delivered: 0, failed: 0 };
      for (const row of rows) {
        if (row.status === RelayDeliveryStatus.Pending) {
          stats.pending = row.count;
        } else if (row.status === RelayDeliveryStatus.Delivered) {
          stats.delivered = row.count;
        } else {
          stats.failed += row.count;
        }
      }
      return stats;
    },
  };
}
