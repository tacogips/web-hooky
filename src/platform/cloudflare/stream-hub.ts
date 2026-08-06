/**
 * Durable Object holding the WebSocket subscribers of one destination.
 *
 * A Worker isolate is per-request and stateless, so `/_ws/` cannot live in it:
 * the socket that a fetch request accepts and the isolate that later receives
 * the webhook are different isolates. One Durable Object per destination
 * (`idFromName(destinationId)`) gives the sockets a single home that both the
 * upgrade and the broadcast can address.
 *
 * Membership is tracked with the hibernation API rather than an in-process map.
 * A DO can be evicted between a subscribe and a broadcast while its sockets stay
 * open; anything held only in memory would be silently lost, and the socket
 * would stream nothing forever. `acceptWebSocket` survives eviction, and the
 * `apiUserId` tag is what lets a revoked credential reach the sockets it
 * authorized without the DO having to remember them.
 *
 * Authorization is *not* repeated here. It is checked in the Worker during the
 * handshake, exactly as `server/app.ts` does locally; this object is reachable
 * only from the Worker, never from the internet.
 *
 * Backpressure differs from the in-process hub by design. Locally the hub
 * enforces a per-socket buffered-bytes ceiling and hangs up slow subscribers
 * (`server/ws.ts`); here that job belongs to the Workers runtime, which caps
 * outgoing message size and applies its own flow control to hibernating
 * sockets, and a `send()` to a subscriber the runtime has given up on throws
 * and is dropped below. Re-implementing the byte ceiling on top of that would
 * require the DO to track queued bytes the runtime already tracks.
 */
import type { PublicRecord } from "../../storage/types";
import { SocketCloseCode } from "../../server/ws";

/** Internal control paths; not reachable from outside the Worker. */
export const STREAM_HUB_ROUTES = {
  subscribe: "/subscribe",
  broadcast: "/broadcast",
  closeDestination: "/close-destination",
  closeApiUser: "/close-api-user",
} as const;

export interface SubscribeQuery {
  readonly apiUserId: string;
}

interface DurableObjectStateLike {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

/** The `{ type: "ready" }` / `{ type: "record" }` frames the client expects. */
function recordFrame(record: PublicRecord): string {
  return JSON.stringify({ type: "record", record });
}

/**
 * Closes a set of sockets, tolerating ones the runtime has already dropped.
 *
 * A socket that throws on close is already gone; letting that abort the loop
 * would leave the rest of a revoked user's sockets streaming.
 */
function closeAll(sockets: readonly WebSocket[], reason: string): number {
  let closed = 0;
  for (const socket of sockets) {
    try {
      socket.close(SocketCloseCode.PolicyViolation, reason);
      closed += 1;
    } catch {
      // Already closed by the runtime; nothing to do.
    }
  }
  return closed;
}

export class StreamHub {
  readonly #state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case STREAM_HUB_ROUTES.subscribe:
        return this.#subscribe(request, url);
      case STREAM_HUB_ROUTES.broadcast:
        return this.#broadcast(request);
      case STREAM_HUB_ROUTES.closeDestination:
        return this.#close(url, null);
      case STREAM_HUB_ROUTES.closeApiUser:
        return this.#close(url, url.searchParams.get("apiUserId"));
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  #subscribe(request: Request, url: URL): Response {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", {
        status: 400,
      });
    }
    const apiUserId = url.searchParams.get("apiUserId");
    if (apiUserId === null || apiUserId.length === 0) {
      return new Response("Missing apiUserId", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Tagged with the authorizing user so revoking that user can find it again.
    this.#state.acceptWebSocket(server, [apiUserId]);
    server.send(JSON.stringify({ type: "ready" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async #broadcast(request: Request): Promise<Response> {
    const record = (await request.json()) as PublicRecord;
    const frame = recordFrame(record);
    let delivered = 0;
    for (const socket of this.#state.getWebSockets()) {
      try {
        socket.send(frame);
        delivered += 1;
      } catch {
        // A socket the runtime has already torn down; the close handler
        // removes it from the hibernation set.
      }
    }
    return Response.json({ delivered });
  }

  #close(url: URL, apiUserId: string | null): Response {
    const reason = url.searchParams.get("reason") ?? "Access changed";
    const sockets =
      apiUserId === null
        ? this.#state.getWebSockets()
        : this.#state.getWebSockets(apiUserId);
    return Response.json({ closed: closeAll(sockets, reason) });
  }

  /** The fetch stream is one-directional; client frames are ignored. */
  webSocketMessage(): void {}

  webSocketClose(): void {
    // Hibernation removes the socket from `getWebSockets` automatically.
  }

  webSocketError(): void {}
}
