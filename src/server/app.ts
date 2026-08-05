/**
 * HTTP + WebSocket application.
 *
 * `createApp` returns a plain `fetch` handler plus WebSocket lifecycle
 * callbacks, so it can be mounted on `Bun.serve` or driven directly by tests.
 */
import { handleAdminApi } from "../admin/api";
import { errors } from "../core/errors";
import { getErrorMessage } from "../core/result";
import type { AppContext } from "./context";
import { handleFetchRecords } from "./fetch-api";
import { authorizeFetchConsumer, findDestinationByFetchUuid } from "./lookups";
import { errorResponse, jsonResponse, publicErrorResponse } from "./responses";
import { handleAdminUi } from "./static-ui";
import { handleInboundWebhook } from "./webhook";
import type { SocketAttachment, WebSocketLike } from "./ws";

export interface UpgradeCapableServer {
  upgrade(request: Request, options: { data: SocketAttachment }): boolean;
}

export interface ServerWebSocketLike extends WebSocketLike {
  readonly data: SocketAttachment;
}

export interface WebSocketHandlers {
  open(socket: ServerWebSocketLike): void;
  close(socket: ServerWebSocketLike): void;
  /** Client frames are ignored; the payload type is runtime specific. */
  message(socket: ServerWebSocketLike, message: unknown): void;
}

export interface WebhookyApp {
  /** Returns null when the request was upgraded to a WebSocket. */
  fetch(
    request: Request,
    server?: UpgradeCapableServer | null,
  ): Promise<Response | null>;
  readonly websocket: WebSocketHandlers;
}

function splitPath(pathname: string): readonly string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

async function handleWebSocketUpgrade(
  ctx: AppContext,
  request: Request,
  url: URL,
  fetchUuid: string,
  server: UpgradeCapableServer | null,
): Promise<Response | null> {
  const destination = await findDestinationByFetchUuid(ctx, fetchUuid);
  if (destination === null) {
    return publicErrorResponse(errors.notFound("Unknown fetch endpoint"));
  }
  // Same rule as `/_get/`: a disabled destination serves nothing.
  if (destination.enabled === false) {
    return publicErrorResponse(errors.forbidden("Destination is disabled"));
  }
  const authorized = await authorizeFetchConsumer(
    ctx,
    request,
    url,
    destination,
  );
  if (authorized.ok === false) {
    return publicErrorResponse(authorized.error);
  }
  if (server === null) {
    return publicErrorResponse(
      errors.internal("WebSocket upgrades are not supported by this server"),
    );
  }
  // The authorizing API user travels with the socket so that revoking that
  // user's access can close the sockets it opened.
  const upgraded = server.upgrade(request, {
    data: { destinationId: destination.id, apiUserId: authorized.value.id },
  });
  return upgraded
    ? null
    : publicErrorResponse(
        errors.badRequest("Expected a WebSocket upgrade request"),
      );
}

export function createApp(ctx: AppContext): WebhookyApp {
  // The hub is built before the configuration reaches it, so the backpressure
  // ceiling is applied here, where both are available.
  ctx.hub.setMaxBufferedBytes(ctx.config.wsMaxBufferedBytes);

  async function route(
    request: Request,
    server: UpgradeCapableServer | null,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const segments = splitPath(url.pathname);

    if (segments.length === 0) {
      return jsonResponse({ name: "web-hooky", status: "ok" });
    }

    // `segments` is non-empty here; the fallback only satisfies
    // `noUncheckedIndexedAccess`.
    const first = segments[0] ?? "";
    const second = segments[1];

    if (first === "_health") {
      return jsonResponse({ status: "ok", t: ctx.clock.nowSeconds() });
    }

    if (first === "_admin") {
      if (second === "api") {
        return handleAdminApi(ctx, request, segments.slice(2));
      }
      return handleAdminUi(ctx, url.pathname);
    }

    if (first === "_get") {
      if (second === undefined || segments.length !== 2) {
        return errorResponse(errors.notFound("Expected /_get/{uuid}"));
      }
      return handleFetchRecords(ctx, request, url, second);
    }

    if (first === "_ws") {
      if (second === undefined || segments.length !== 2) {
        return errorResponse(errors.notFound("Expected /_ws/{uuid}"));
      }
      return handleWebSocketUpgrade(ctx, request, url, second, server);
    }

    if (first.startsWith("_")) {
      return errorResponse(errors.notFound("Unknown endpoint"));
    }

    if (second !== undefined && segments.length === 2) {
      return handleInboundWebhook(ctx, request, first, second);
    }

    return errorResponse(errors.notFound("Unknown endpoint"));
  }

  return {
    async fetch(
      request: Request,
      server: UpgradeCapableServer | null = null,
    ): Promise<Response | null> {
      try {
        return await route(request, server);
      } catch (error) {
        // Unexpected failures must not leak stack traces, file paths or
        // upstream messages to callers: the detail is logged under a reference
        // the caller can quote.
        return publicErrorResponse(
          errors.internal(`Unhandled server error: ${getErrorMessage(error)}`),
          error,
        );
      }
    },

    websocket: {
      open(socket: ServerWebSocketLike): void {
        ctx.hub.add(socket.data, socket);
        try {
          socket.send(JSON.stringify({ type: "ready" }));
        } catch (error) {
          // A socket that dies between the upgrade and the first frame must
          // not take the connection handler down with it.
          console.warn("[web-hooky] websocket ready frame failed", error);
          ctx.hub.remove(socket);
        }
      },
      close(socket: ServerWebSocketLike): void {
        ctx.hub.remove(socket);
      },
      message(): void {
        // The fetch stream is one-directional; client frames are ignored.
      },
    },
  };
}
