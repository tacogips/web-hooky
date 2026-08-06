/**
 * Application context shared by every request handler.
 */
import type { AddonRegistry } from "../addons/registry";
import type { AppConfig } from "../config";
import type { Clock } from "../core/time";
import type { AdminAuthProvider } from "../admin/auth-provider";
import type { CacheAdapter } from "../storage/cache";
import type { PersistenceAdapter } from "../storage/persistence";
import type { WebSocketHub } from "./ws";

export interface AppContext {
  readonly config: AppConfig;
  readonly persistence: PersistenceAdapter;
  readonly cache: CacheAdapter;
  readonly registry: AddonRegistry;
  readonly hub: WebSocketHub;
  readonly adminAuth: AdminAuthProvider;
  readonly clock: Clock;
  /**
   * Whether this deployment can install uploaded addon packages.
   *
   * Doing so needs a writable filesystem and a runtime `import()`; bundle-only
   * targets such as Cloudflare Workers have neither. Declared here so the admin
   * surface can answer 501 instead of failing deep inside an unpack.
   */
  readonly canInstallAddons: boolean;
}
