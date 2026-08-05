/**
 * Platform port.
 *
 * Everything a deployment target has to supply, expressed as one interface so
 * the core never imports a platform. `src/platform/bun/` is the local target;
 * `src/platform/cloudflare/` is Workers + D1 + Durable Objects; a Vercel or AWS
 * target implements the same shape and needs no change to `pipeline/`,
 * `schema/`, `addons/`, `server/` or `admin/`.
 *
 * The rule this file encodes: a platform may only *provide* capabilities, never
 * reach into request handling. Anything a platform cannot do is declared in
 * `PlatformCapabilities` and degraded explicitly at the edge, so a missing
 * capability is a documented 501 rather than a crash inside a handler.
 */
import type { CacheAdapter } from "../storage/cache";
import type { PersistenceAdapter } from "../storage/persistence";
import type { WebSocketHub } from "../server/ws";

/**
 * What a target can and cannot do.
 *
 * These are not feature flags: each one marks a capability that some runtime
 * genuinely lacks, and the admin surface reports the shortfall rather than
 * failing obscurely.
 */
export interface PlatformCapabilities {
  /**
   * Installing an uploaded addon package needs to unpack a zip to a writable
   * filesystem and `import()` the entry module at runtime. Workers and other
   * bundle-only targets cannot do either, so they serve the four built-in
   * addons and answer `POST /_admin/api/addons` with 501.
   */
  readonly addonInstall: boolean;
  /**
   * Long-lived WebSocket connections. A stateless function target has nowhere
   * to hold them; on Workers they live in a Durable Object.
   */
  readonly webSocket: boolean;
  /**
   * In-process timers driving the retention sweeper and the relay worker. When
   * absent, the deployment calls `sweepRetention()` and `runRelayDeliveries()`
   * from a scheduled trigger instead - which is why `WebhookyRuntime` exposes
   * both as plain methods.
   */
  readonly backgroundTimers: boolean;
}

export interface PlatformAdapter {
  /** Identifies the target in logs and on `GET /_admin/api/me`. */
  readonly name: string;
  readonly capabilities: PlatformCapabilities;
  readonly persistence: PersistenceAdapter;
  readonly cache: CacheAdapter;
  readonly hub: WebSocketHub;
  /**
   * Serves a built admin UI asset, or null when the path is not an asset so the
   * router can continue. Kept on the platform because every target stores the
   * bundle somewhere different: a directory locally, an Assets binding on
   * Workers, the CDN on Vercel.
   */
  serveAsset(pathname: string): Promise<Response | null>;
}

/** Capabilities of a long-running server process with a writable filesystem. */
export const FULL_CAPABILITIES: PlatformCapabilities = {
  addonInstall: true,
  webSocket: true,
  backgroundTimers: true,
};
