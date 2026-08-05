/**
 * Inbound webhook endpoint: `POST /{addon_name}/{inbound_uuid}`.
 */
import { errors } from "../core/errors";
import { newUuid } from "../core/ids";
import type { AddonResponse } from "../addons/types";
import { InboundOutcomeKind, processInboundWebhook } from "../pipeline/process";
import { enqueueRelayDeliveries } from "../relay/queue";
import { toPublicRecord, type WebhookRecord } from "../storage/types";
import type { AppContext } from "./context";
import { findDestinationByInboundUuid } from "./lookups";
import { errorResponse, headersToRecord, jsonResponse } from "./responses";

const ACCEPTED_METHODS = new Set(["POST", "PUT"]);

/**
 * Reads the body while enforcing the configured size cap.
 *
 * `Content-Length` is checked first so an oversized body is rejected without
 * reading anything. Requests without it (chunked or streamed) are read
 * incrementally and abandoned as soon as the accumulated bytes pass the cap, so
 * the cap bounds peak memory on every path.
 */
async function readBody(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      return null;
    }
  }
  const stream = request.body;
  if (stream === null) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Renders a response an addon produced for a vendor handshake.
 *
 * Addon code is trusted but still fallible, so an unusable status or header is
 * reported as a server error rather than crashing the request.
 */
function addonResponse(response: AddonResponse): Response {
  if (
    Number.isInteger(response.status) === false ||
    response.status < 200 ||
    response.status > 599
  ) {
    return errorResponse(
      errors.internal(`Addon produced an invalid status ${response.status}`),
    );
  }
  try {
    return new Response(response.body, {
      status: response.status,
      headers: { "cache-control": "no-store", ...response.headers },
    });
  } catch (error) {
    return errorResponse(
      errors.internal(
        `Addon produced an invalid response: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
    );
  }
}

export async function handleInboundWebhook(
  ctx: AppContext,
  request: Request,
  addonName: string,
  inboundUuid: string,
): Promise<Response> {
  if (ACCEPTED_METHODS.has(request.method) === false) {
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  const destination = await findDestinationByInboundUuid(ctx, inboundUuid);
  // A destination configured for a different vendor addon must not be
  // reachable under this addon's prefix, and the response must not reveal
  // whether the UUID exists at all.
  if (destination === null || destination.vendorAddon !== addonName) {
    return errorResponse(errors.notFound("Unknown webhook destination"));
  }
  if (destination.enabled === false) {
    return errorResponse(errors.forbidden("Destination is disabled"));
  }

  const rawBody = await readBody(request, ctx.config.maxBodyBytes);
  if (rawBody === null) {
    return errorResponse(
      errors.payloadTooLarge(
        `Request body exceeds ${ctx.config.maxBodyBytes} bytes`,
      ),
    );
  }

  const vendorAddon = ctx.registry.requireVendor(destination.vendorAddon);
  if (vendorAddon.ok === false) {
    return errorResponse(vendorAddon.error);
  }

  let destinationAddon = null;
  if (destination.destinationAddon !== null) {
    const resolved = ctx.registry.requireDestination(
      destination.destinationAddon,
    );
    if (resolved.ok === false) {
      return errorResponse(resolved.error);
    }
    destinationAddon = resolved.value;
  }

  const receivedAt = ctx.clock.nowSeconds();
  const processed = await processInboundWebhook({
    destination,
    vendorAddon: vendorAddon.value,
    destinationAddon,
    headers: headersToRecord(request.headers),
    rawBody,
    method: request.method,
    receivedAt,
  });
  if (processed.ok === false) {
    return errorResponse(processed.error);
  }
  if (processed.value.kind === InboundOutcomeKind.Respond) {
    return addonResponse(processed.value.response);
  }

  const record: WebhookRecord = {
    id: newUuid(),
    destinationId: destination.id,
    t: receivedAt,
    fetched: false,
    payload: processed.value.payload,
  };
  await ctx.persistence.records.insert(record);
  ctx.hub.broadcast(destination.id, toPublicRecord(record));

  // The record is already durable at this point, so a queueing failure must not
  // turn into an error the vendor would retry (and duplicate).
  let relayed = 0;
  try {
    relayed = await enqueueRelayDeliveries(ctx.persistence, ctx.clock, record);
  } catch (error) {
    console.warn("[web-hooky] failed to queue relay deliveries", error);
  }

  return jsonResponse({ accepted: true, t: record.t, relayed }, 202);
}
