/**
 * Relay enqueueing.
 *
 * Every accepted record is fanned out to the enabled relays of its destination
 * as durable delivery jobs; the worker drains the queue independently of the
 * inbound request.
 */
import { newUuid } from "../core/ids";
import type { Clock } from "../core/time";
import type { PersistenceAdapter } from "../storage/persistence";
import {
  RelayDeliveryStatus,
  type RelayDeliveryRecord,
  type WebhookRecord,
} from "../storage/types";

/** Queues one delivery per enabled relay; returns the number queued. */
export async function enqueueRelayDeliveries(
  persistence: PersistenceAdapter,
  clock: Clock,
  record: WebhookRecord,
): Promise<number> {
  const relays = await persistence.relays.listEnabledForDestination(
    record.destinationId,
  );
  if (relays.length === 0) {
    return 0;
  }

  const now = clock.nowSeconds();
  for (const relay of relays) {
    const delivery: RelayDeliveryRecord = {
      id: newUuid(),
      relayId: relay.id,
      destinationId: record.destinationId,
      recordId: record.id,
      t: record.t,
      // Snapshotted so retention deletion of the record cannot strand the job.
      payload: record.payload,
      status: RelayDeliveryStatus.Pending,
      attempts: 0,
      nextAttemptAt: now,
      lastStatusCode: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
    };
    await persistence.relayDeliveries.enqueue(delivery);
  }
  return relays.length;
}
