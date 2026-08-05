/**
 * Worker-side `WebSocketHub` that forwards to the per-destination Durable
 * Objects.
 *
 * This implements the *existing* `WebSocketHub` interface unchanged, including
 * its synchronous signatures, so `server/webhook.ts` and `server/lookups.ts`
 * need no modification. The DO calls are dispatched through `waitUntil`, which
 * is exactly the fire-and-forget contract those call sites already rely on
 * locally: `broadcast` is best-effort notification, and the authoritative
 * cursor stays `GET /_get/`.
 *
 * `add`, `remove` and `setMaxBufferedBytes` are no-ops here. Sockets are held by
 * the Durable Object, never by the Worker isolate, so there is nothing local to
 * track and no local send queue to bound - Workers applies its own flow control
 * to a hibernating socket.
 */
import type { PublicRecord } from "../../storage/types";
import type {
  SocketAttachment,
  WebSocketHub,
  WebSocketLike,
} from "../../server/ws";
import { STREAM_HUB_ROUTES } from "./stream-hub";

/** The Durable Object namespace surface this proxy uses. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface HubProxyOptions {
  readonly namespace: DurableObjectNamespaceLike;
  /** Extends the request's lifetime past the response, as Workers requires. */
  readonly waitUntil: (work: Promise<unknown>) => void;
  /**
   * Destinations an API user could hold sockets on.
   *
   * Sockets are sharded per destination, so revoking a user means reaching each
   * destination it was granted. Injected rather than read from persistence here
   * to keep this module free of storage concerns.
   */
  readonly destinationsForApiUser: (
    apiUserId: string,
  ) => Promise<readonly string[]>;
  readonly onError: (error: unknown) => void;
}

/** Any URL works; the DO is addressed by id, not by host. */
const DO_ORIGIN = "https://stream-hub.invalid";

export function createDurableObjectHub(options: HubProxyOptions): WebSocketHub {
  function call(
    destinationId: string,
    path: string,
    init?: RequestInit,
    search: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const url = new URL(path, DO_ORIGIN);
    for (const [key, value] of Object.entries(search)) {
      url.searchParams.set(key, value);
    }
    const stub = options.namespace.get(
      options.namespace.idFromName(destinationId),
    );
    return stub.fetch(new Request(url, init));
  }

  /** Dispatches DO work without blocking the response. */
  function dispatch(work: Promise<unknown>): void {
    options.waitUntil(
      work.catch((error: unknown) => {
        options.onError(error);
      }),
    );
  }

  return {
    add(_attachment: SocketAttachment, _socket: WebSocketLike): void {
      // Sockets live in the Durable Object.
    },

    remove(_socket: WebSocketLike): void {
      // Sockets live in the Durable Object.
    },

    broadcast(destinationId: string, record: PublicRecord): void {
      dispatch(
        call(destinationId, STREAM_HUB_ROUTES.broadcast, {
          method: "POST",
          body: JSON.stringify(record),
          headers: { "content-type": "application/json" },
        }),
      );
    },

    countFor(): number {
      // Would cost a DO round trip and no caller needs it in this target.
      return 0;
    },

    closeForDestination(destinationId: string, reason: string): number {
      dispatch(
        call(
          destinationId,
          STREAM_HUB_ROUTES.closeDestination,
          { method: "POST" },
          { reason },
        ),
      );
      // The count is only observable after the round trip; the callers in
      // `server/lookups.ts` ignore it.
      return 0;
    },

    closeForApiUser(apiUserId: string, reason: string): number {
      dispatch(
        options
          .destinationsForApiUser(apiUserId)
          .then((destinationIds) =>
            Promise.all(
              destinationIds.map((destinationId) =>
                call(
                  destinationId,
                  STREAM_HUB_ROUTES.closeApiUser,
                  { method: "POST" },
                  { reason, apiUserId },
                ),
              ),
            ),
          ),
      );
      return 0;
    },

    closeAll(): void {
      // A Worker isolate has no shutdown hook and holds no sockets.
    },

    setMaxBufferedBytes(): void {
      // Workers manages backpressure for a hibernating socket itself.
    },
  };
}
