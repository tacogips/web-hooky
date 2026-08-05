/**
 * Outbound relay delivery.
 *
 * Only web-standard APIs are used (`fetch`, `AbortSignal`, `crypto.subtle`), so
 * this module runs unchanged on every deployment target. The `fetch`
 * implementation is injected so tests never touch the network.
 */
import { hmacSha256Hex } from "../core/ids";
import type { JsonValue } from "../core/json";
import { getErrorMessage } from "../core/result";
import type { RelayDeliveryRecord, RelayRecord } from "../storage/types";

/** Subset of `fetch` the relay depends on. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RelayAttemptResult {
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly error: string | null;
}

export const SIGNATURE_HEADER = "x-webhooky-signature";
export const TIMESTAMP_HEADER = "x-webhooky-timestamp";
export const DELIVERY_HEADER = "x-webhooky-delivery";
export const DESTINATION_HEADER = "x-webhooky-destination";
export const ATTEMPT_HEADER = "x-webhooky-attempt";

/** Body posted to the relay target. */
export function relayBody(delivery: RelayDeliveryRecord): JsonValue {
  return {
    id: delivery.id,
    destinationId: delivery.destinationId,
    recordId: delivery.recordId,
    t: delivery.t,
    attempt: delivery.attempts,
    payload: delivery.payload,
  };
}

/**
 * Signs `${timestamp}.${body}` rather than the body alone, so a captured
 * request cannot be replayed indefinitely by a receiver that checks the age of
 * the timestamp.
 */
export function relaySignaturePayload(
  timestampSeconds: number,
  body: string,
): string {
  return `${timestampSeconds}.${body}`;
}

export interface DeliverRelayOptions {
  readonly relay: RelayRecord;
  readonly delivery: RelayDeliveryRecord;
  readonly nowSeconds: number;
  readonly fetchImpl: FetchLike;
  /**
   * Timeout for this attempt. The caller passes the clamped value from
   * `effectiveTimeoutSeconds` rather than `relay.timeoutSeconds` directly.
   */
  readonly timeoutSeconds: number;
}

/**
 * The timeout an attempt may actually use: the relay's own value, capped one
 * second below the delivery lease and never below one second.
 *
 * The admin API refuses to store a relay timeout that reaches the lease, but
 * the lease is configuration: lowering it below an already-stored relay's
 * timeout would let an attempt still be in flight when its lease expires, so a
 * second worker would claim the delivery and send the same webhook twice.
 * Clamping here makes that unreachable regardless of how the two drift apart.
 */
export function effectiveTimeoutSeconds(
  relayTimeoutSeconds: number,
  leaseSeconds: number,
): number {
  const ceiling = Math.max(1, leaseSeconds - 1);
  return Math.max(1, Math.min(relayTimeoutSeconds, ceiling));
}

/** Whether a status is a redirect, which the relay refuses to follow. */
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Performs one delivery attempt. Network and HTTP failures are values. */
export async function deliverRelayOnce(
  options: DeliverRelayOptions,
): Promise<RelayAttemptResult> {
  const { relay, delivery, nowSeconds, fetchImpl, timeoutSeconds } = options;
  const body = JSON.stringify(relayBody(delivery));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "web-hooky-relay/1",
    [TIMESTAMP_HEADER]: String(nowSeconds),
    [DELIVERY_HEADER]: delivery.id,
    [DESTINATION_HEADER]: delivery.destinationId,
    [ATTEMPT_HEADER]: String(delivery.attempts),
  };
  if (relay.secret !== null) {
    const signature = await hmacSha256Hex(
      relay.secret,
      relaySignaturePayload(nowSeconds, body),
    );
    headers[SIGNATURE_HEADER] = `sha256=${signature}`;
  }

  try {
    const response = await fetchImpl(relay.targetUrl, {
      method: "POST",
      headers,
      body,
      // Redirects are not followed: an approved target could otherwise bounce
      // the signed payload to an address the operator never approved, such as a
      // cloud metadata endpoint on a private network.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    // The body is drained so the connection can be reused; its content is not
    // part of the contract.
    await response.text().catch(() => "");
    if (
      isRedirectStatus(response.status) ||
      response.type === "opaqueredirect"
    ) {
      return {
        ok: false,
        statusCode: response.status === 0 ? null : response.status,
        error: "Target responded with a redirect, which is not followed",
      };
    }
    if (response.ok) {
      return { ok: true, statusCode: response.status, error: null };
    }
    return {
      ok: false,
      statusCode: response.status,
      error: `Target responded with status ${response.status}`,
    };
  } catch (error) {
    return { ok: false, statusCode: null, error: getErrorMessage(error) };
  }
}

/** Source of the backoff jitter factor; values in `[0, 1)`, like `Math.random`. */
export type RandomSource = () => number;

/**
 * Exponential backoff for attempt `attempts`, capped at `maxBackoffSeconds`.
 *
 * The delay is jittered by a factor in `[0.5, 1.5)`: deliveries queued by the
 * same inbound burst fail at the same moment, and an unjittered backoff would
 * retry all of them at the same moment too, hammering a target that is already
 * struggling. `random` is injectable so tests can pin the factor.
 */
export function backoffSeconds(
  baseSeconds: number,
  attempts: number,
  maxBackoffSeconds: number,
  random: RandomSource = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1);
  // Math.min on a bounded exponent keeps the shift away from Infinity.
  const scaled = baseSeconds * 2 ** Math.min(exponent, 16);
  const jittered = scaled * (0.5 + random());
  // Whole seconds only: nextAttemptAt is stored in an integer column.
  return Math.round(Math.min(Math.max(jittered, 1), maxBackoffSeconds));
}
