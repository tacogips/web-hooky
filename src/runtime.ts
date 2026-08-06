/**
 * Bun runtime target.
 *
 * Supplies the adapters that only a long-running process with a writable
 * filesystem can provide - `bun:sqlite` persistence, in-memory cache, the
 * in-process WebSocket hub and addon packages loaded from disk - and hands them
 * to the platform-agnostic wiring in `runtime-core.ts`.
 *
 * The Bun-only imports live here and nowhere else: `bun:sqlite` cannot be
 * resolved in a Workers bundle, so the Workers target must not reach this
 * module even transitively.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadInstalledAddon } from "./addons/loader";
import type { LoadedAddon } from "./addons/types";
import type { AppConfig } from "./config";
import type { AppError } from "./core/errors";
import { errors } from "./core/errors";
import { err, getErrorMessage, type Result } from "./core/result";
import type { Clock } from "./core/time";
import type { FetchLike } from "./relay/dispatch";
import { createRuntimeCore, type WebhookyRuntime } from "./runtime-core";
import { createWebSocketHub } from "./server/ws";
import { createMemoryCache, type CacheAdapter } from "./storage/cache";
import type { PersistenceAdapter } from "./storage/persistence";
import { createBunSqlitePersistence } from "./storage/sqlite/bun-adapter";

export type { WebhookyRuntime } from "./runtime-core";

export interface RuntimeOverrides {
  readonly persistence?: PersistenceAdapter;
  readonly cache?: CacheAdapter;
  readonly clock?: Clock;
  /** Replaces the outbound `fetch` used by the relay worker; used by tests. */
  readonly relayFetch?: FetchLike;
}

async function ensureDirectories(config: AppConfig): Promise<void> {
  if (config.dbPath !== ":memory:") {
    await mkdir(dirname(config.dbPath), { recursive: true });
  }
  await mkdir(config.addonsDir, { recursive: true });
}

/** Loads every addon package recorded in persistence from the addons dir. */
async function loadInstalledAddons(
  config: AppConfig,
  persistence: PersistenceAdapter,
  onWarning: (message: string) => void,
): Promise<readonly LoadedAddon[]> {
  const loaded: LoadedAddon[] = [];
  for (const record of await persistence.addons.list()) {
    const addon = await loadInstalledAddon(config.addonsDir, record);
    if (addon.ok === false) {
      onWarning(
        `[web-hooky] Skipping installed addon "${record.name}": ${addon.error.message}`,
      );
      continue;
    }
    loaded.push(addon.value);
  }
  return loaded;
}

/** Builds a fully wired runtime from configuration. */
export async function createRuntime(
  config: AppConfig,
  overrides: RuntimeOverrides = {},
): Promise<Result<WebhookyRuntime, AppError>> {
  try {
    await ensureDirectories(config);
  } catch (error) {
    return err(
      errors.internal(
        `Failed to prepare data directories: ${getErrorMessage(error)}`,
      ),
    );
  }

  const clock = overrides.clock;
  const persistence =
    overrides.persistence ?? createBunSqlitePersistence(config.dbPath);
  const cache =
    overrides.cache ??
    createMemoryCache(() => (clock ?? { nowMs: () => Date.now() }).nowMs());

  try {
    await persistence.init();
  } catch (error) {
    return err(
      errors.internal(
        `Failed to initialise storage: ${getErrorMessage(error)}`,
      ),
    );
  }

  const warn = (message: string): void => {
    console.warn(message);
  };
  const installedAddons = await loadInstalledAddons(config, persistence, warn);

  return createRuntimeCore(config, {
    persistence,
    cache,
    hub: createWebSocketHub((error) => {
      console.warn("[web-hooky] websocket send failed", error);
    }),
    ...(clock === undefined ? {} : { clock }),
    ...(overrides.relayFetch === undefined
      ? {}
      : { relayFetch: overrides.relayFetch }),
    installedAddons,
    backgroundTimers: true,
    canInstallAddons: true,
    onWarning: warn,
  });
}
