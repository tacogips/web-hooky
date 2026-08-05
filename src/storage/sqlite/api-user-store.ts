/**
 * Fetch API user store (key id, hashed secret, per-destination grants).
 */
import type { ApiUserStore } from "../persistence";
import { boolToInt, type SqlDriver } from "../sql-driver";
import type { ApiUserRecord } from "../types";
import { type ApiUserRow, type CountRow, toApiUser } from "./rows";

const COLUMNS = "id, label, secret_hash, enabled, created_at";

interface GrantRow {
  readonly destination_id: string;
}

export function createApiUserStore(driver: SqlDriver): ApiUserStore {
  async function findById(id: string): Promise<ApiUserRecord | null> {
    const row = await driver.get<ApiUserRow>(
      `SELECT ${COLUMNS} FROM api_users WHERE id = ?`,
      [id],
    );
    return row === null ? null : toApiUser(row);
  }

  return {
    async create(user: ApiUserRecord): Promise<void> {
      await driver.run(
        `INSERT INTO api_users (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
        [
          user.id,
          user.label,
          user.secretHash,
          boolToInt(user.enabled),
          user.createdAt,
        ],
      );
    },

    async update(user: ApiUserRecord): Promise<void> {
      await driver.run(
        `UPDATE api_users SET label = ?, secret_hash = ?, enabled = ?
         WHERE id = ?`,
        [user.label, user.secretHash, boolToInt(user.enabled), user.id],
      );
    },

    async delete(id: string): Promise<boolean> {
      const existing = await findById(id);
      if (existing === null) {
        return false;
      }
      await driver.run("DELETE FROM api_users WHERE id = ?", [id]);
      return true;
    },

    findById,

    async list(): Promise<readonly ApiUserRecord[]> {
      const rows = await driver.all<ApiUserRow>(
        `SELECT ${COLUMNS} FROM api_users ORDER BY created_at DESC, id ASC`,
      );
      return rows.map(toApiUser);
    },

    async grant(
      userId: string,
      destinationId: string,
      createdAt: number,
    ): Promise<void> {
      await driver.run(
        `INSERT OR IGNORE INTO api_user_grants
           (api_user_id, destination_id, created_at)
         VALUES (?, ?, ?)`,
        [userId, destinationId, createdAt],
      );
    },

    async revoke(userId: string, destinationId: string): Promise<void> {
      await driver.run(
        `DELETE FROM api_user_grants
         WHERE api_user_id = ? AND destination_id = ?`,
        [userId, destinationId],
      );
    },

    async listGrants(userId: string): Promise<readonly string[]> {
      const rows = await driver.all<GrantRow>(
        `SELECT destination_id FROM api_user_grants
         WHERE api_user_id = ? ORDER BY destination_id ASC`,
        [userId],
      );
      return rows.map((row) => row.destination_id);
    },

    async hasGrant(userId: string, destinationId: string): Promise<boolean> {
      const row = await driver.get<CountRow>(
        `SELECT COUNT(*) AS count FROM api_user_grants
         WHERE api_user_id = ? AND destination_id = ?`,
        [userId, destinationId],
      );
      return (row?.count ?? 0) > 0;
    },
  };
}
