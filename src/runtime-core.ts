/**
 * Platform-agnostic runtime wiring.
 *
 * This module builds everything that is identical on every deployment target:
 * the addon registry, admin seeding, the application context, the retention
 * sweeper and the relay worker. It imports no filesystem, no `bun:sqlite` and
 * no Workers API, so it can be bundled for any of them.
 *
 * Each target supplies its own adapters and calls this. `src/runtime.ts` is the
 * Bun target; `src/platform/cloudflare/worker.ts` is Workers + D1 + Durable
 * Objects. The split exists because a static `import { Database } from
 * "bun:sqlite"` is unresolvable in a Workers bundle - gating the *call* is not
 * enough, the import itself has to be absent from the module graph.
 */
import { BUILTIN_ADDONS } from "./addons/builtin/registry";
import { createAddonRegistry, type AddonRegistry } from "./addons/registry";
import { createAdminAuthProvider } from "./admin/auth-provider";
import type { AppConfig } from "./config";
import type { AppError } from "./core/errors";
import { errors } from "./core/errors";
import { err, ok, type Result } from "./core/result";
import { type Clock, systemClock } from "./core/time";
import type { FetchLike } from "./relay/dispatch";
import { createRelayWorker, type RelayRunResult } from "./relay/worker";
import { createApp, type WebhookyApp } from "./server/app";
import type { AppContext } from "./server/context";
import { hashSecret } from "./server/credentials";
import type { WebSocketHub } from "./server/ws";
import type { CacheAdapter } from "./storage/cache";
import type { PersistenceAdapter } from "./storage/persistence";
import {
  createRetentionSweeper,
  type RetentionSweepResult,
} from "./storage/retention";
import { AdminRole } from "./storage/types";

export interface WebhookyRuntime {
  readonly app: WebhookyApp;
  readonly context: AppContext;
  /** Runs one retention sweep; reports what it deleted. */
  sweepRetention(): Promise<RetentionSweepResult>;
  /** Drains one batch of relay deliveries. */
  runRelayDeliveries(): Promise<RelayRunResult>;
  shutdown(): Promise<void>;
}

export interface RuntimeCoreParts {
  readonly persistence: PersistenceAdapter;
  readonly cache: CacheAdapter;
  readonly hub: WebSocketHub;
  readonly clock?: Clock;
  /** Replaces the outbound `fetch` used by the relay worker; used by tests. */
  readonly relayFetch?: FetchLike;
  /**
   * Addons beyond the built-ins, already loaded by the platform.
   *
   * Loading an installed package needs a writable filesystem and a runtime
   * `import()`, so the platform does it (or cannot) and passes the result here.
   */
  readonly installedAddons?: readonly Parameters<
    AddonRegistry["register"]
  >[0][];
  /**
   * Whether to run the sweeper and relay worker on in-process timers.
   *
   * False on targets with no long-lived process; there the deployment drives
   * `sweepRetention()` and `runRelayDeliveries()` from a scheduled trigger.
   */
  readonly backgroundTimers: boolean;
  /**
   * Whether this target can install uploaded addon packages. Defaults to false:
   * a target must opt in by proving it has a writable filesystem and runtime
   * `import()`, rather than inheriting a capability it may not have.
   */
  readonly canInstallAddons?: boolean;
  readonly onWarning?: (message: string) => void;
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

/** Wires a runtime from adapters the caller's platform already built. */
export async function createRuntimeCore(
  config: AppConfig,
  parts: RuntimeCoreParts,
): Promise<Result<WebhookyRuntime, AppError>> {
  const clock = parts.clock ?? systemClock;
  const warn = parts.onWarning ?? ((message) => console.warn(message));
  const { persistence, cache, hub } = parts;

  const registry = createAddonRegistry(BUILTIN_ADDONS);
  for (const addon of parts.installedAddons ?? []) {
    const registered = registry.register(addon);
    if (registered.ok === false) {
      warn(
        `[web-hooky] Skipping installed addon "${addon.manifest.name}": ${registered.error.message}`,
      );
    }
  }

  const seeded = await seedAdminAccess(config, persistence, clock);
  if (seeded.ok === false) {
    return err(seeded.error);
  }

  const context: AppContext = {
    config,
    persistence,
    cache,
    registry,
    hub,
    adminAuth: createAdminAuthProvider(config),
    clock,
    canInstallAddons: parts.canInstallAddons ?? false,
  };

  const sweeper = createRetentionSweeper(
    persistence,
    clock,
    {
      defaultRetentionSeconds: config.retentionSeconds,
      sweepIntervalSeconds: config.retentionSweepIntervalSeconds,
    },
    (error) => {
      warn(`[web-hooky] retention sweep failed: ${String(error)}`);
    },
  );

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
    ...(parts.relayFetch === undefined ? {} : { fetchImpl: parts.relayFetch }),
    onError: (error) => {
      warn(`[web-hooky] relay delivery failed: ${String(error)}`);
    },
  });

  if (parts.backgroundTimers) {
    sweeper.start();
    relayWorker.start();
  }

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
