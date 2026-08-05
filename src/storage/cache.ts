/**
 * Cache port plus the default in-process implementation.
 *
 * The cache is a pure read accelerator: every value can be recomputed from the
 * persistence adapter, and admin writes invalidate explicitly.
 */

export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every entry whose key starts with the given prefix. */
  deleteByPrefix(prefix: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

interface CacheEntry {
  readonly value: string;
  readonly expiresAtMs: number;
}

/**
 * In-memory cache with per-entry TTL.
 *
 * Suitable for single-process deployments; multi-instance deployments should
 * supply a shared implementation (KV, Redis) through the same interface.
 */
export function createMemoryCache(
  nowMs: () => number = Date.now,
): CacheAdapter {
  const entries = new Map<string, CacheEntry>();

  function purgeExpired(): void {
    const now = nowMs();
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    get(key: string): Promise<string | null> {
      const entry = entries.get(key);
      if (entry === undefined) {
        return Promise.resolve(null);
      }
      if (entry.expiresAtMs <= nowMs()) {
        entries.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },

    set(key: string, value: string, ttlSeconds: number): Promise<void> {
      if (ttlSeconds <= 0) {
        entries.delete(key);
        return Promise.resolve();
      }
      purgeExpired();
      entries.set(key, {
        value,
        expiresAtMs: nowMs() + ttlSeconds * 1000,
      });
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      entries.delete(key);
      return Promise.resolve();
    },

    deleteByPrefix(prefix: string): Promise<void> {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
        }
      }
      return Promise.resolve();
    },

    clear(): Promise<void> {
      entries.clear();
      return Promise.resolve();
    },

    close(): Promise<void> {
      entries.clear();
      return Promise.resolve();
    },
  };
}

export const cacheKeys = {
  destinationByInbound: (uuid: string): string => `dest:inbound:${uuid}`,
  destinationByFetch: (uuid: string): string => `dest:fetch:${uuid}`,
  apiUser: (id: string): string => `apiuser:${id}`,
  grant: (userId: string, destinationId: string): string =>
    `grant:${userId}:${destinationId}`,
} as const;
