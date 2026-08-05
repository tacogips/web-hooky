/**
 * Admin API key, admin user, and installed addon stores.
 */
import type {
  AdminKeyStore,
  AdminUserStore,
  InstalledAddonStore,
} from "../persistence";
import { boolToInt, type SqlDriver } from "../sql-driver";
import type {
  AdminKeyRecord,
  AdminUserRecord,
  InstalledAddonRecord,
} from "../types";
import {
  type AdminKeyRow,
  type AdminUserRow,
  type InstalledAddonRow,
  toAdminKey,
  toAdminUser,
  toInstalledAddon,
} from "./rows";

const ADMIN_KEY_COLUMNS = "id, label, secret_hash, enabled, created_at";
const ADMIN_USER_COLUMNS = "subject, role, created_at";
const ADDON_COLUMNS = `name, version, kind, description, entry_path, manifest,
  installed_at, installed_by`;

export function createAdminKeyStore(driver: SqlDriver): AdminKeyStore {
  async function findById(id: string): Promise<AdminKeyRecord | null> {
    const row = await driver.get<AdminKeyRow>(
      `SELECT ${ADMIN_KEY_COLUMNS} FROM admin_keys WHERE id = ?`,
      [id],
    );
    return row === null ? null : toAdminKey(row);
  }

  return {
    async create(key: AdminKeyRecord): Promise<void> {
      await driver.run(
        `INSERT INTO admin_keys (${ADMIN_KEY_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
        [
          key.id,
          key.label,
          key.secretHash,
          boolToInt(key.enabled),
          key.createdAt,
        ],
      );
    },

    async delete(id: string): Promise<boolean> {
      const existing = await findById(id);
      if (existing === null) {
        return false;
      }
      await driver.run("DELETE FROM admin_keys WHERE id = ?", [id]);
      return true;
    },

    findById,

    async list(): Promise<readonly AdminKeyRecord[]> {
      const rows = await driver.all<AdminKeyRow>(
        `SELECT ${ADMIN_KEY_COLUMNS} FROM admin_keys
         ORDER BY created_at DESC, id ASC`,
      );
      return rows.map(toAdminKey);
    },
  };
}

export function createAdminUserStore(driver: SqlDriver): AdminUserStore {
  async function findBySubject(
    subject: string,
  ): Promise<AdminUserRecord | null> {
    const row = await driver.get<AdminUserRow>(
      `SELECT ${ADMIN_USER_COLUMNS} FROM admin_users WHERE subject = ?`,
      [subject],
    );
    return row === null ? null : toAdminUser(row);
  }

  return {
    async upsert(user: AdminUserRecord): Promise<void> {
      await driver.run(
        `INSERT INTO admin_users (${ADMIN_USER_COLUMNS}) VALUES (?, ?, ?)
         ON CONFLICT (subject) DO UPDATE SET role = excluded.role`,
        [user.subject, user.role, user.createdAt],
      );
    },

    async delete(subject: string): Promise<boolean> {
      const existing = await findBySubject(subject);
      if (existing === null) {
        return false;
      }
      await driver.run("DELETE FROM admin_users WHERE subject = ?", [subject]);
      return true;
    },

    findBySubject,

    async list(): Promise<readonly AdminUserRecord[]> {
      const rows = await driver.all<AdminUserRow>(
        `SELECT ${ADMIN_USER_COLUMNS} FROM admin_users ORDER BY subject ASC`,
      );
      return rows.map(toAdminUser);
    },
  };
}

export function createInstalledAddonStore(
  driver: SqlDriver,
): InstalledAddonStore {
  async function findByName(
    name: string,
  ): Promise<InstalledAddonRecord | null> {
    const row = await driver.get<InstalledAddonRow>(
      `SELECT ${ADDON_COLUMNS} FROM installed_addons WHERE name = ?`,
      [name],
    );
    return row === null ? null : toInstalledAddon(row);
  }

  return {
    async create(addon: InstalledAddonRecord): Promise<void> {
      await driver.run(
        `INSERT INTO installed_addons (${ADDON_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          addon.name,
          addon.version,
          addon.kind,
          addon.description,
          addon.entryPath,
          JSON.stringify(addon.manifest),
          addon.installedAt,
          addon.installedBy,
        ],
      );
    },

    async delete(name: string): Promise<boolean> {
      const existing = await findByName(name);
      if (existing === null) {
        return false;
      }
      await driver.run("DELETE FROM installed_addons WHERE name = ?", [name]);
      return true;
    },

    findByName,

    async list(): Promise<readonly InstalledAddonRecord[]> {
      const rows = await driver.all<InstalledAddonRow>(
        `SELECT ${ADDON_COLUMNS} FROM installed_addons ORDER BY name ASC`,
      );
      return rows.map(toInstalledAddon);
    },
  };
}
