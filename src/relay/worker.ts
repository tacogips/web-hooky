/**
 * Relay delivery worker.
 *
 * The worker claims due deliveries in batches, attempts each one, and either
 * marks it delivered, reschedules it with exponential backoff, or gives up
 * after the relay's `maxAttempts`. The interval timer is a convenience for
 * long-running processes; serverless deployments should call `runOnce` from a
 * scheduled trigger instead, exactly like the retention sweeper.
 */
import { createInFlightTracker } from "../core/async";
import type { Clock } from "../core/time";
import type { PersistenceAdapter } from "../storage/persistence";
import type { RelayDeliveryRecord, RelayRecord } from "../storage/types";
import {
  backoffSeconds,
  deliverRelayOnce,
  effectiveTimeoutSeconds,
  type FetchLike,
} from "./dispatch";

export interface RelayWorkerOptions {
  readonly pollIntervalSeconds: number;
  readonly batchSize: number;
  readonly maxBackoffSeconds: number;
  /**
   * How long a claimed delivery is hidden from other workers. A worker that
   * dies mid-attempt resumes after it. It doubles as the ceiling for a single
   * attempt: each request is timed out one second before its lease expires, so
   * an in-flight attempt can never be claimed a second time.
   */
  readonly leaseSeconds: number;
  /** How long a delivery waits while its relay is disabled. */
  readonly parkSeconds: number;
}

export interface RelayRunResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
  /** Claimed but not attempted, because the relay is disabled. */
  readonly parked: number;
}

export interface RelayWorker {
  /** Drains one batch; returns what happened to it. */
  runOnce(): Promise<RelayRunResult>;
  start(): void;
  stop(): void;
  /**
   * Resolves once every run started before `stop()` has finished writing its
   * outcome. Shutting down without this can leave a delivery whose POST already
   * succeeded marked `pending`, so it is sent again after the lease expires.
   */
  drain(): Promise<void>;
}

export interface RelayWorkerDeps {
  readonly persistence: PersistenceAdapter;
  readonly clock: Clock;
  readonly options: RelayWorkerOptions;
  readonly fetchImpl?: FetchLike;
  readonly onError?: (error: unknown) => void;
}

type Outcome = "delivered" | "retried" | "failed" | "parked";

export function createRelayWorker(deps: RelayWorkerDeps): RelayWorker {
  const { persistence, clock, options } = deps;
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const onError = deps.onError ?? ((): void => undefined);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const inFlight = createInFlightTracker();

  async function attempt(
    relay: RelayRecord,
    delivery: RelayDeliveryRecord,
  ): Promise<Outcome> {
    const started = clock.nowSeconds();
    const result = await deliverRelayOnce({
      relay,
      delivery,
      nowSeconds: started,
      fetchImpl,
      // Clamped against the lease here as well as at write time, so lowering
      // the configured lease below a stored relay's timeout cannot leave an
      // attempt in flight past its lease and get the delivery claimed twice.
      timeoutSeconds: effectiveTimeoutSeconds(
        relay.timeoutSeconds,
        options.leaseSeconds,
      ),
    });
    const now = clock.nowSeconds();

    if (result.ok) {
      await persistence.relayDeliveries.markDelivered(
        delivery.id,
        now,
        result.statusCode,
      );
      return "delivered";
    }

    const reason = result.error ?? "Delivery failed";
    if (delivery.attempts >= relay.maxAttempts) {
      await persistence.relayDeliveries.markFailed(
        delivery.id,
        now,
        result.statusCode,
        reason,
      );
      return "failed";
    }
    await persistence.relayDeliveries.reschedule(
      delivery.id,
      now,
      now +
        backoffSeconds(
          relay.backoffSeconds,
          delivery.attempts,
          options.maxBackoffSeconds,
        ),
      result.statusCode,
      reason,
    );
    return "retried";
  }

  async function process(delivery: RelayDeliveryRecord): Promise<Outcome> {
    const relay = await persistence.relays.findById(delivery.relayId);
    const now = clock.nowSeconds();
    if (relay === null) {
      await persistence.relayDeliveries.markFailed(
        delivery.id,
        now,
        null,
        "Relay no longer exists",
      );
      return "failed";
    }
    if (relay.enabled === false) {
      // Deliveries queued before the relay was disabled are parked rather than
      // dropped, so enabling the relay resumes them. Parking returns the
      // attempt the claim consumed; otherwise a long disabled period would burn
      // the whole budget and fail every queued delivery on re-enable.
      await persistence.relayDeliveries.park(
        delivery.id,
        now,
        now + options.parkSeconds,
        "Relay is disabled",
      );
      return "parked";
    }
    return attempt(relay, delivery);
  }

  async function runBatch(): Promise<RelayRunResult> {
    const now = clock.nowSeconds();
    const claimed = await persistence.relayDeliveries.claimDue(
      now,
      options.batchSize,
      options.leaseSeconds,
    );
    if (claimed.length === 0) {
      return { claimed: 0, delivered: 0, retried: 0, failed: 0, parked: 0 };
    }

    const outcomes = await Promise.all(
      claimed.map(async (delivery): Promise<Outcome> => {
        try {
          return await process(delivery);
        } catch (error) {
          onError(error);
          return "retried";
        }
      }),
    );

    return {
      claimed: claimed.length,
      delivered: outcomes.filter((outcome) => outcome === "delivered").length,
      retried: outcomes.filter((outcome) => outcome === "retried").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
      parked: outcomes.filter((outcome) => outcome === "parked").length,
    };
  }

  function runOnce(): Promise<RelayRunResult> {
    return inFlight.track(runBatch());
  }

  return {
    runOnce,

    start(): void {
      if (timer !== null || options.pollIntervalSeconds <= 0) {
        return;
      }
      timer = setInterval(() => {
        // Overlapping ticks would only contend for the same batch.
        if (running) {
          return;
        }
        running = true;
        runOnce()
          .catch(onError)
          .finally(() => {
            running = false;
          });
      }, options.pollIntervalSeconds * 1000);
      // Do not keep the process alive purely for the relay worker.
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
