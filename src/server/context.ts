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
}
