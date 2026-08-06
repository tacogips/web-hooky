/**
 * WebSocket streaming of a destination's records.
 *
 * The server accepts handshake credentials as an `Authorization` header or as
 * `?api_key=&api_secret=` query parameters. The WHATWG `WebSocket` constructor
 * that Node and Bun expose takes no headers, so this client uses the query
 * form; that is also why the server offers it, since browsers have the same
 * limitation. Query strings reach proxy and server access logs, so prefer TLS
 * and a short-lived credential here.
 */
import type { ResolvedConfig } from "./config.js";
import { messageOf, WebhookyError } from "./errors.js";
import { pathSegment } from "./http.js";
import type { WebhookRecord } from "./types.js";

/** RFC 6455 close code the server uses when a credential or grant is revoked. */
export const POLICY_VIOLATION = 1008;

export const DEFAULT_INITIAL_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface StreamOptions {
  /**
   * Reconnect with capped exponential backoff after a transport failure.
   *
   * A policy-violation close (1008) always ends the stream even when this is
   * set: the server closes with that code when the credential or grant was
   * revoked, and retrying would only hammer a server that has already refused.
   */
  readonly reconnect?: boolean;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Stop after this many records. Unset streams until the caller stops. */
  readonly maxRecords?: number;
  /** Fires once per successful connection, on the server's ready frame. */
  readonly onReady?: () => void;
  /** Fires before each retry with the attempt number and the previous error. */
  readonly onReconnect?: (attempt: number, cause: unknown) => void;
  /** Replaces the global `WebSocket`, for tests. */
  readonly webSocketImpl?: typeof WebSocket;
}

/**
 * The server closed the socket with a policy violation (1008): the credential
 * or the grant behind this stream is no longer valid.
 */
export class StreamClosedByServerError extends WebhookyError {
  constructor() {
    super("stream closed by server policy (credential or grant revoked)", {
      kind: "forbidden",
    });
    this.name = "StreamClosedByServerError";
  }
}

/** Builds the `/_ws/{fetchUuid}` URL, carrying the key pair as query values. */
export function buildStreamUrl(
  config: ResolvedConfig,
  fetchUuid: string,
): string {
  const url = `${config.urls.ws}/_ws/${pathSegment(fetchUuid)}`;
  const token = config.authorization.replace(/^Bearer\s+/i, "").trim();
  const separator = token.indexOf(":");
  if (separator <= 0) {
    return url;
  }
  const params = new URLSearchParams({
    api_key: token.slice(0, separator),
    api_secret: token.slice(separator + 1),
  });
  return `${url}?${params.toString()}`;
}

/** Capped exponential backoff for reconnect attempt `attempt` (1-based). */
export function backoffFor(
  attempt: number,
  initialMs: number,
  maxMs: number,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 20);
  return Math.min(initialMs * 2 ** exponent, maxMs);
}

/** One decoded server frame. */
export interface StreamFrame {
  readonly type: string;
  readonly record: WebhookRecord | null;
}

/**
 * Decodes one server frame.
 *
 * An unknown frame type decodes to a null record and is ignored by the caller,
 * so a server that grows a new frame kind does not break an older client.
 */
export function decodeFrame(raw: string): StreamFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WebhookyError(
      `failed to decode stream frame: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WebhookyError("stream frame is not a JSON object");
  }

  const { type, record } = parsed as { type?: unknown; record?: unknown };
  const frameType = typeof type === "string" ? type : "";
  if (frameType !== "record") {
    return { type: frameType, record: null };
  }
  if (typeof record !== "object" || record === null) {
    throw new WebhookyError('stream "record" frame carried no record object');
  }
  return { type: frameType, record: record as WebhookRecord };
}

/** Outcome of one connection, used to decide whether to retry. */
interface ConnectionEnd {
  readonly kind: "closed" | "failed";
  readonly cause: unknown;
}

/**
 * A queue that hands socket events to the consuming async iterator.
 *
 * Frames can arrive faster than the caller consumes them, so they are buffered;
 * a waiting consumer is resolved directly.
 */
class FrameQueue {
  private readonly buffer: WebhookRecord[] = [];
  private waiter: ((value: undefined) => void) | null = null;
  private ended: ConnectionEnd | null = null;

  push(record: WebhookRecord): void {
    this.buffer.push(record);
    this.wake();
  }

  end(end: ConnectionEnd): void {
    if (this.ended === null) {
      this.ended = end;
    }
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter(undefined);
    }
  }

  /** Resolves once a record is buffered or the connection has ended. */
  wait(): Promise<void> {
    if (this.buffer.length > 0 || this.ended !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  take(): WebhookRecord | undefined {
    return this.buffer.shift();
  }

  get finished(): ConnectionEnd | null {
    return this.buffer.length > 0 ? null : this.ended;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Opens one connection and yields its records.
 *
 * Returns how the connection ended so the caller can decide about retrying.
 */
async function* runConnection(
  url: string,
  options: StreamOptions,
  budget: { delivered: number },
): AsyncGenerator<WebhookRecord, ConnectionEnd, undefined> {
  const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
  if (WebSocketImpl === undefined) {
    throw new WebhookyError(
      "no WebSocket implementation available: Node 22+ or Bun is required, " +
        "or pass webSocketImpl",
    );
  }

  const queue = new FrameQueue();
  let socket: WebSocket;
  try {
    socket = new WebSocketImpl(url);
  } catch (error) {
    return { kind: "failed", cause: error };
  }

  let frameError: unknown = null;
  socket.onmessage = (event: MessageEvent): void => {
    if (frameError !== null) {
      return;
    }
    try {
      const raw =
        typeof event.data === "string" ? event.data : String(event.data);
      const frame = decodeFrame(raw);
      if (frame.type === "ready") {
        options.onReady?.();
        return;
      }
      if (frame.record !== null) {
        queue.push(frame.record);
      }
    } catch (error) {
      frameError = error;
      queue.end({ kind: "failed", cause: error });
    }
  };
  socket.onerror = (): void => {
    // The browser-shaped error event carries no detail; the close event that
    // follows is what distinguishes the cases.
    queue.end({
      kind: "failed",
      cause: new WebhookyError("stream transport error"),
    });
  };
  socket.onclose = (event: CloseEvent): void => {
    if (event.code === POLICY_VIOLATION) {
      queue.end({ kind: "failed", cause: new StreamClosedByServerError() });
      return;
    }
    queue.end({ kind: "closed", cause: null });
  };

  try {
    for (;;) {
      await queue.wait();
      const record = queue.take();
      if (record !== undefined) {
        yield record;
        budget.delivered += 1;
        if (
          options.maxRecords !== undefined &&
          options.maxRecords > 0 &&
          budget.delivered >= options.maxRecords
        ) {
          return { kind: "closed", cause: null };
        }
        continue;
      }
      const finished = queue.finished;
      if (finished !== null) {
        return finished;
      }
    }
  } finally {
    // Reached on a normal return and when the caller breaks out of the loop;
    // either way the socket must not be left open.
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, "client done");
    } catch {
      // The socket may already be closed; nothing to recover here.
    }
  }
}

/**
 * Streams records for a destination, reconnecting when asked to.
 */
export async function* streamRecords(
  config: ResolvedConfig,
  fetchUuid: string,
  options: StreamOptions = {},
): AsyncIterableIterator<WebhookRecord> {
  const url = buildStreamUrl(config, fetchUuid);
  const initial = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maximum = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const budget = { delivered: 0 };
  let attempt = 0;

  for (;;) {
    const connection = runConnection(url, options, budget);
    let end: ConnectionEnd = { kind: "closed", cause: null };
    try {
      for (;;) {
        const next = await connection.next();
        if (next.done === true) {
          end = next.value;
          break;
        }
        yield next.value;
      }
    } finally {
      // Reached when the caller breaks out of the loop as well as on a normal
      // end. Returning the inner generator runs its cleanup, which closes the
      // socket; without this an abandoned stream would leak the connection.
      await connection.return({ kind: "closed", cause: null });
    }

    if (
      options.maxRecords !== undefined &&
      options.maxRecords > 0 &&
      budget.delivered >= options.maxRecords
    ) {
      return;
    }
    // A revoked credential is terminal: retrying cannot fix it.
    if (end.cause instanceof StreamClosedByServerError) {
      throw end.cause;
    }
    if (options.reconnect !== true) {
      if (end.kind === "failed") {
        throw end.cause instanceof Error
          ? end.cause
          : new WebhookyError(`stream failed: ${messageOf(end.cause)}`);
      }
      return;
    }

    attempt += 1;
    options.onReconnect?.(attempt, end.cause);
    await delay(backoffFor(attempt, initial, maximum));
  }
}
