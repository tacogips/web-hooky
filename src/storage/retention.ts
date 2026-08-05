/**
 * Retention sweeper.
 *
 * Deletes the data that is past its retention window: the records themselves
 * and the payload copies that relay deliveries keep. The interval timer is a
 * convenience for long-running processes; serverless deployments should call
 * `sweepExpiredRecords` from a scheduled trigger instead.
 */
import { createInFlightTracker } from "../core/async";
import type { Clock } from "../core/time";
import type { PersistenceAdapter } from "./persistence";

export interface RetentionOptions {
  readonly defaultRetentionSeconds: number;
  readonly sweepIntervalSeconds: number;
}

/** What one sweep removed. */
export interface RetentionSweepResult {
  readonly records: number;
  /**
   * Relay deliveries removed: the terminal ones, plus deliveries still pending
   * on a relay that is disabled or gone, which are parked indefinitely and
   * would otherwise keep their payload copy past the window forever.
   */
  readonly relayDeliveries: number;
}

export interface RetentionSweeper {
  /** Runs one sweep and reports what it deleted. */
  sweep(): Promise<RetentionSweepResult>;
  start(): void;
  stop(): void;
  /** Resolves once a sweep started before `stop()` has finished. */
  drain(): Promise<void>;
}

/**
 * Deletes everything past its effective retention window.
 *
 * A relay delivery snapshots the record's payload, so deleting only the record
 * would leave that payload readable past the configured window for every
 * destination with a relay attached.
 */
export async function sweepExpiredRecords(
  persistence: PersistenceAdapter,
  clock: Clock,
  defaultRetentionSeconds: number,
): Promise<RetentionSweepResult> {
  // A non-positive default still lets per-destination overrides apply.
  const retention = defaultRetentionSeconds > 0 ? defaultRetentionSeconds : 0;
  // One timestamp for both passes, so a record and its delivery copies share
  // the same cutoff.
  const now = clock.nowSeconds();
  const records = await persistence.records.deleteExpired(now, retention);
  const relayDeliveries = await persistence.relayDeliveries.deleteExpired(
    now,
    retention,
  );
  return { records, relayDeliveries };
}

export function createRetentionSweeper(
  persistence: PersistenceAdapter,
  clock: Clock,
  options: RetentionOptions,
  onError: (error: unknown) => void = () => undefined,
): RetentionSweeper {
  let timer: ReturnType<typeof setInterval> | null = null;
  const inFlight = createInFlightTracker();

  function sweep(): Promise<RetentionSweepResult> {
    return inFlight.track(
      sweepExpiredRecords(persistence, clock, options.defaultRetentionSeconds),
    );
  }

  return {
    sweep,

    start(): void {
      if (timer !== null || options.sweepIntervalSeconds <= 0) {
        return;
      }
      timer = setInterval(() => {
        sweep().catch(onError);
      }, options.sweepIntervalSeconds * 1000);
      // Do not keep the process alive purely for the sweeper.
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        timer.unref();
      }
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    drain(): Promise<void> {
      return inFlight.drain();
    },
  };
}
