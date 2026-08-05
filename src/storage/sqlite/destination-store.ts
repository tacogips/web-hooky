/**
 * Destination store implemented on the SQL driver port.
 */
import type { DestinationStore } from "../persistence";
import { boolToInt, type SqlDriver } from "../sql-driver";
import type { DestinationRecord } from "../types";
import { type CountRow, type DestinationRow, toDestination } from "./rows";

const COLUMNS = `id, name, vendor_addon, destination_addon, inbound_uuid,
  fetch_uuid, vendor_config, destination_config, retention_seconds, enabled,
  created_at, created_by`;

export function createDestinationStore(driver: SqlDriver): DestinationStore {
  async function findBy(
    column: "id" | "inbound_uuid" | "fetch_uuid",
    value: string,
  ): Promise<DestinationRecord | null> {
    const row = await driver.get<DestinationRow>(
      `SELECT ${COLUMNS} FROM destinations WHERE ${column} = ?`,
      [value],
    );
    return row === null ? null : toDestination(row);
  }

  return {
    async create(destination: DestinationRecord): Promise<void> {
      await driver.run(
        `INSERT INTO destinations (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          destination.id,
          destination.name,
          destination.vendorAddon,
          destination.destinationAddon,
          destination.inboundUuid,
          destination.fetchUuid,
          JSON.stringify(destination.vendorConfig),
          JSON.stringify(destination.destinationConfig),
          destination.retentionSeconds,
          boolToInt(destination.enabled),
          destination.createdAt,
          destination.createdBy,
        ],
      );
    },

    async update(destination: DestinationRecord): Promise<void> {
      await driver.run(
        `UPDATE destinations SET
           name = ?, vendor_addon = ?, destination_addon = ?, inbound_uuid = ?,
           fetch_uuid = ?, vendor_config = ?, destination_config = ?,
           retention_seconds = ?, enabled = ?
         WHERE id = ?`,
        [
          destination.name,
          destination.vendorAddon,
          destination.destinationAddon,
          destination.inboundUuid,
          destination.fetchUuid,
          JSON.stringify(destination.vendorConfig),
          JSON.stringify(destination.destinationConfig),
          destination.retentionSeconds,
          boolToInt(destination.enabled),
          destination.id,
        ],
      );
    },

    async delete(id: string): Promise<boolean> {
      const existing = await findBy("id", id);
      if (existing === null) {
        return false;
      }
      await driver.run("DELETE FROM destinations WHERE id = ?", [id]);
      return true;
    },

    findById(id: string): Promise<DestinationRecord | null> {
      return findBy("id", id);
    },

    findByInboundUuid(uuid: string): Promise<DestinationRecord | null> {
      return findBy("inbound_uuid", uuid);
    },

    findByFetchUuid(uuid: string): Promise<DestinationRecord | null> {
      return findBy("fetch_uuid", uuid);
    },

    async list(): Promise<readonly DestinationRecord[]> {
      const rows = await driver.all<DestinationRow>(
        `SELECT ${COLUMNS} FROM destinations ORDER BY created_at DESC, id ASC`,
      );
      return rows.map(toDestination);
    },

    async countUsingAddon(addonName: string): Promise<number> {
      const row = await driver.get<CountRow>(
        `SELECT COUNT(*) AS count FROM destinations
         WHERE vendor_addon = ? OR destination_addon = ?`,
        [addonName, addonName],
      );
      return row?.count ?? 0;
    },
  };
}
