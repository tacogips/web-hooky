/**
 * SQL persistence adapter.
 *
 * The implementation targets the `SqlDriver` port rather than a concrete
 * database, so the same code serves `bun:sqlite`, Turso/libSQL and Cloudflare
 * D1 once a driver exists for them.
 */
import type { PersistenceAdapter } from "../persistence";
import type { SqlDriver } from "../sql-driver";
import {
  createAdminKeyStore,
  createAdminUserStore,
  createInstalledAddonStore,
} from "./admin-store";
import { createApiUserStore } from "./api-user-store";
import { createBunSqliteDriver } from "./bun-driver";
import { createDestinationStore } from "./destination-store";
import { createRecordStore } from "./record-store";
import { createRelayDeliveryStore, createRelayStore } from "./relay-store";
import { SCHEMA_STATEMENTS } from "./schema";

/** Builds a persistence adapter over any SQLite-compatible driver. */
export function createSqlPersistenceAdapter(
  driver: SqlDriver,
): PersistenceAdapter {
  return {
    destinations: createDestinationStore(driver),
    records: createRecordStore(driver),
    apiUsers: createApiUserStore(driver),
    adminKeys: createAdminKeyStore(driver),
    adminUsers: createAdminUserStore(driver),
    addons: createInstalledAddonStore(driver),
    relays: createRelayStore(driver),
    relayDeliveries: createRelayDeliveryStore(driver),

    async init(): Promise<void> {
      for (const statement of SCHEMA_STATEMENTS) {
        await driver.run(statement);
      }
    },

    close(): Promise<void> {
      return driver.close();
    },
  };
}

/** Convenience factory for the local Bun runtime. */
export function createBunSqlitePersistence(path: string): PersistenceAdapter {
  return createSqlPersistenceAdapter(createBunSqliteDriver(path));
}
