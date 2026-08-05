/**
 * DDL for the SQL persistence adapter.
 *
 * Restricted to constructs supported by SQLite, libSQL/Turso and Cloudflare D1.
 */

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS destinations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vendor_addon TEXT NOT NULL,
    destination_addon TEXT,
    inbound_uuid TEXT NOT NULL UNIQUE,
    fetch_uuid TEXT NOT NULL UNIQUE,
    vendor_config TEXT NOT NULL,
    destination_config TEXT NOT NULL,
    retention_seconds INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_destinations_vendor_addon
    ON destinations (vendor_addon)`,
  `CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL,
    t INTEGER NOT NULL,
    fetched INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    FOREIGN KEY (destination_id) REFERENCES destinations (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_records_destination_t
    ON records (destination_id, t DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_records_fetched
    ON records (destination_id, fetched)`,
  `CREATE TABLE IF NOT EXISTS api_users (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_user_grants (
    api_user_id TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (api_user_id, destination_id),
    FOREIGN KEY (api_user_id) REFERENCES api_users (id) ON DELETE CASCADE,
    FOREIGN KEY (destination_id) REFERENCES destinations (id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS admin_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    subject TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS relays (
    id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL,
    name TEXT NOT NULL,
    target_url TEXT NOT NULL,
    secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL,
    backoff_seconds INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    FOREIGN KEY (destination_id) REFERENCES destinations (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relays_destination
    ON relays (destination_id)`,
  `CREATE TABLE IF NOT EXISTS relay_deliveries (
    id TEXT PRIMARY KEY,
    relay_id TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    t INTEGER NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_status_code INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    delivered_at INTEGER,
    FOREIGN KEY (relay_id) REFERENCES relays (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relay_deliveries_due
    ON relay_deliveries (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_relay_deliveries_relay
    ON relay_deliveries (relay_id, created_at DESC)`,
  // The retention sweep walks destinations and takes a receipt-time range of
  // each one's deliveries; neither index above serves that.
  `CREATE INDEX IF NOT EXISTS idx_relay_deliveries_destination_t
    ON relay_deliveries (destination_id, t)`,
  `CREATE TABLE IF NOT EXISTS installed_addons (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    manifest TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    installed_by TEXT
  )`,
];
