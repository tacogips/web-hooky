/**
 * Runtime wiring: builds every adapter, seeds admin access, registers addons,
 * and manages the retention sweeper lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadInstalledAddon } from "./addons/loader";
import { BUILTIN_ADDONS } from "./addons/builtin/registry";
import { createAddonRegistry, type AddonRegistry } from "./addons/registry";
import { createAdminAuthProvider } from "./admin/auth-provider";
import type { AppConfig } from "./config";
import type { AppError } from "./core/errors";
import { errors } from "./core/errors";
import { err, getErrorMessage, ok, type Result } from "./core/result";
import { type Clock, systemClock } from "./core/time";
import type { FetchLike } from "./relay/dispatch";
import { createRelayWorker, type RelayRunResult } from "./relay/worker";
import { createApp, type WebhookyApp } from "./server/app";
import type { AppContext } from "./server/context";
import { hashSecret } from "./server/credentials";
import { createWebSocketHub } from "./server/ws";
import { createMemoryCache, type CacheAdapter } from "./storage/cache";
import type { PersistenceAdapter } from "./storage/persistence";
import {
  createRetentionSweeper,
  type RetentionSweepResult,
} from "./storage/retention";
import { createBunSqlitePersistence } from "./storage/sqlite/adapter";
import { AdminRole } from "./storage/types";

export interface RuntimeOverrides {
  readonly persistence?: PersistenceAdapter;
  readonly cache?: CacheAdapter;
  readonly clock?: Clock;
  /** Replaces the outbound `fetch` used by the relay worker; used by tests. */
  readonly relayFetch?: FetchLike;
}

export interface WebhookyRuntime {
  readonly app: WebhookyApp;
  readonly context: AppContext;
  /** Runs one retention sweep; reports what it deleted. */
  sweepRetention(): Promise<RetentionSweepResult>;
  /** Drains one batch of relay deliveries. */
  runRelayDeliveries(): Promise<RelayRunResult>;
  shutdown(): Promise<void>;
}

async function ensureDirectories(config: AppConfig): Promise<void> {
  if (config.dbPath !== ":memory:") {
    await mkdir(dirname(config.dbPath), { recursive: true });
  }
  await mkdir(config.addonsDir, { recursive: true });
}

async function registerInstalledAddons(
  config: AppConfig,
  persistence: PersistenceAdapter,
  registry: AddonRegistry,
  onWarning: (message: string) => void,
): Promise<void> {
  const installed = await persistence.addons.list();
  for (const record of installed) {
    const loaded = await loadInstalledAddon(config.addonsDir, record);
    if (loaded.ok === false) {
      onWarning(
        `Skipping installed addon "${record.name}": ${loaded.error.message}`,
      );
      continue;
    }
    const registered = registry.register(loaded.value);
    if (registered.ok === false) {
      onWarning(
        `Skipping installed addon "${record.name}": ${registered.error.message}`,
      );
    }
  }
}

async function seedAdminAccess(
  config: AppConfig,
  persistence: PersistenceAdapter,
  clock: Clock,
): Promise<Result<null, AppError>> {
  for (const subject of config.adminSubjects) {
    await persistence.adminUsers.upsert({
      subject,
      role: AdminRole.Admin,
      createdAt: clock.nowSeconds(),
    });
  }

  if (config.bootstrapAdminKey === null) {
    return ok(null);
  }
  const separator = config.bootstrapAdminKey.indexOf(":");
  const keyId = config.bootstrapAdminKey.slice(0, separator);
  const secret = config.bootstrapAdminKey.slice(separator + 1);
  if (keyId.length === 0 || secret.length === 0) {
    return err(
      errors.badRequest(
        "Bootstrap admin key must use the form <keyId>:<secret>",
      ),
    );
  }
  const existing = await persistence.adminKeys.findById(keyId);
  if (existing !== null) {
    return ok(null);
  }
  await persistence.adminKeys.create({
    id: keyId,
    label: "bootstrap",
    secretHash: await hashSecret(secret),
    enabled: true,
    createdAt: clock.nowSeconds(),
  });
  return ok(null);
}

/** Builds a fully wired runtime from configuration. */
export async function createRuntime(
  config: AppConfig,
  overrides: RuntimeOverrides = {},
): Promise<Result<WebhookyRuntime, AppError>> {
  const clock = overrides.clock ?? systemClock;

  try {
    await ensureDirectories(config);
  } catch (error) {
    return err(
      errors.internal(
        `Failed to prepare data directories: ${getErrorMessage(error)}`,
      ),
    );
  }

  const persistence =
    overrides.persistence ?? createBunSqlitePersistence(config.dbPath);
  const cache = overrides.cache ?? createMemoryCache(() => clock.nowMs());

  try {
    await persistence.init();
  } catch (error) {
    return err(
      errors.internal(
        `Failed to initialise storage: ${getErrorMessage(error)}`,
      ),
    );
  }

  const registry = createAddonRegistry(BUILTIN_ADDONS);
  await registerInstalledAddons(config, persistence, registry, (message) => {
    console.warn(`[web-hooky] ${message}`);
  });

  const seeded = await seedAdminAccess(config, persistence, clock);
  if (seeded.ok === false) {
    return err(seeded.error);
  }

  const hub = createWebSocketHub((error) => {
    console.warn("[web-hooky] websocket send failed", error);
  });

  const context: AppContext = {
    config,
    persistence,
    cache,
    registry,
    hub,
    adminAuth: createAdminAuthProvider(config),
    clock,
  };

  const sweeper = createRetentionSweeper(
    persistence,
    clock,
    {
      defaultRetentionSeconds: config.retentionSeconds,
      sweepIntervalSeconds: config.retentionSweepIntervalSeconds,
    },
    (error) => {
      console.warn("[web-hooky] retention sweep failed", error);
    },
  );
  sweeper.start();

  const relayWorker = createRelayWorker({
    persistence,
    clock,
    options: {
      pollIntervalSeconds: config.relay.pollIntervalSeconds,
      batchSize: config.relay.batchSize,
      maxBackoffSeconds: config.relay.maxBackoffSeconds,
      leaseSeconds: config.relay.leaseSeconds,
      parkSeconds: config.relay.parkSeconds,
    },
    ...(overrides.relayFetch === undefined
      ? {}
      : { fetchImpl: overrides.relayFetch }),
    onError: (error) => {
      console.warn("[web-hooky] relay delivery failed", error);
    },
  });
  relayWorker.start();

  return ok({
    app: createApp(context),
    context,
    sweepRetention: (): Promise<RetentionSweepResult> => sweeper.sweep(),
    runRelayDeliveries: (): Promise<RelayRunResult> => relayWorker.runOnce(),
    async shutdown(): Promise<void> {
      sweeper.stop();
      relayWorker.stop();
      hub.closeAll();
      // Storage must stay open until background work has recorded its result:
      // closing first would lose the outcome of a delivery whose POST already
      // succeeded, and the lease would hand it to the next process to re-send.
      await Promise.all([relayWorker.drain(), sweeper.drain()]);
      await cache.close();
      await persistence.close();
    },
  });
}
