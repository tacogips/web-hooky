/**
 * Small in-process async coordination helpers.
 *
 * Both are deliberately process-local: they coordinate work inside one server
 * instance and make no claim about other instances, which must rely on the
 * database (unique constraints, delivery leases) instead.
 */

export interface KeyedLock {
  /**
   * Runs `fn` after every earlier call for the same `key` has settled.
   * Different keys never wait for each other.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Serialises async sections by key, so a read-check-write sequence that is not
 * atomic in storage cannot interleave with itself.
 */
export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key);
      // The predecessor is continued on both settle paths: one failing section
      // must not stall every later caller holding the same key.
      const result = previous === undefined ? fn() : previous.then(fn, fn);
      const tail: Promise<void> = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        // Only the current tail may drop the key; a later waiter has replaced
        // it by then and must keep its own chain alive.
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      });
      return result;
    },
  };
}

export interface InFlightTracker {
  /** Registers `work` and returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Resolves once every tracked promise has settled, including late ones. */
  drain(): Promise<void>;
}

/**
 * Tracks background work so shutdown can wait for it. Without this, a task
 * whose storage writes are still pending would fail against a closed database
 * and silently lose its result.
 */
export function createInFlightTracker(): InFlightTracker {
  const pending = new Set<Promise<unknown>>();

  return {
    track<T>(work: Promise<T>): Promise<T> {
      const tracked: Promise<T> = work.finally(() => {
        pending.delete(tracked);
      });
      pending.add(tracked);
      // The caller owns `work`; `tracked` is only observed through `drain`,
      // which never lets a rejection escape.
      void tracked.catch(() => undefined);
      return work;
    },

    async drain(): Promise<void> {
      // Looped, because settling one task may register another.
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}
