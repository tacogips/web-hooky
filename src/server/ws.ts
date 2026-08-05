/**
 * WebSocket fan-out hub.
 *
 * The hub only depends on a minimal socket capability, so it can be driven by
 * Bun's `ServerWebSocket`, by a test double, or by a Durable Object socket.
 *
 * Authorization is checked once, during the handshake, so the hub also has to
 * be able to hang up: a socket keeps streaming until something closes it, and
 * disabling a user or a destination has to reach the sockets it authorized.
 */
import type { PublicRecord } from "../storage/types";

/** RFC 6455 close codes used when the server drops a socket. */
export enum SocketCloseCode {
  /** The server is shutting down. */
  GoingAway = 1001,
  /** The credential that authorized this socket is no longer valid. */
  PolicyViolation = 1008,
  /** The client cannot keep up with the stream. */
  TryAgainLater = 1013,
}

export interface WebSocketLike {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  /** Bytes the runtime still has queued; Bun's `ServerWebSocket` provides it. */
  getBufferedAmount?(): number;
}

/** Data attached to an upgraded socket. */
export interface SocketAttachment {
  readonly destinationId: string;
  readonly apiUserId: string;
}

export interface WebSocketHub {
  add(attachment: SocketAttachment, socket: WebSocketLike): void;
  remove(socket: WebSocketLike): void;
  broadcast(destinationId: string, record: PublicRecord): void;
  countFor(destinationId: string): number;
  /** Closes every socket streaming a destination; returns how many were closed. */
  closeForDestination(destinationId: string, reason: string): number;
  /** Closes every socket a given API user opened; returns how many were closed. */
  closeForApiUser(apiUserId: string, reason: string): number;
  /** Closes every socket, whatever its destination. */
  closeAll(): void;
  /** Sets the per-socket outbound buffer ceiling in bytes. */
  setMaxBufferedBytes(bytes: number): void;
}

/** Buffer ceiling used until configuration is applied. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function addToIndex(
  index: Map<string, Set<WebSocketLike>>,
  key: string,
  socket: WebSocketLike,
): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, new Set([socket]));
    return;
  }
  existing.add(socket);
}

function removeFromIndex(
  index: Map<string, Set<WebSocketLike>>,
  key: string,
  socket: WebSocketLike,
): void {
  const existing = index.get(key);
  if (existing === undefined) {
    return;
  }
  existing.delete(socket);
  if (existing.size === 0) {
    index.delete(key);
  }
}

export function createWebSocketHub(
  onSendError: (error: unknown) => void = () => undefined,
  maxBufferedBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
): WebSocketHub {
  const subscribers = new Map<string, Set<WebSocketLike>>();
  const byApiUser = new Map<string, Set<WebSocketLike>>();
  const attachments = new Map<WebSocketLike, SocketAttachment>();
  /** Bytes handed to a socket that the runtime has not reported as flushed. */
  const queued = new Map<WebSocketLike, number>();
  let ceiling = maxBufferedBytes;

  /** Reads the runtime's own view of the send queue, when it exposes one. */
  function reportedBufferedBytes(socket: WebSocketLike): number {
    if (typeof socket.getBufferedAmount !== "function") {
      return 0;
    }
    try {
      const buffered = socket.getBufferedAmount();
      return Number.isFinite(buffered) && buffered > 0 ? buffered : 0;
    } catch (error) {
      onSendError(error);
      return 0;
    }
  }

  function forget(socket: WebSocketLike): void {
    const attachment = attachments.get(socket);
    if (attachment !== undefined) {
      removeFromIndex(subscribers, attachment.destinationId, socket);
      removeFromIndex(byApiUser, attachment.apiUserId, socket);
      attachments.delete(socket);
    }
    queued.delete(socket);
  }

  function closeSocket(
    socket: WebSocketLike,
    code: SocketCloseCode,
    reason: string,
  ): void {
    forget(socket);
    try {
      socket.close(code, reason);
    } catch (error) {
      onSendError(error);
    }
  }

  function closeGroup(
    index: Map<string, Set<WebSocketLike>>,
    key: string,
    code: SocketCloseCode,
    reason: string,
  ): number {
    const existing = index.get(key);
    if (existing === undefined) {
      return 0;
    }
    // Closing mutates the index, so the members are captured first.
    const sockets = [...existing];
    for (const socket of sockets) {
      closeSocket(socket, code, reason);
    }
    return sockets.length;
  }

  return {
    add(attachment: SocketAttachment, socket: WebSocketLike): void {
      attachments.set(socket, attachment);
      addToIndex(subscribers, attachment.destinationId, socket);
      addToIndex(byApiUser, attachment.apiUserId, socket);
    },

    remove(socket: WebSocketLike): void {
      forget(socket);
    },

    broadcast(destinationId: string, record: PublicRecord): void {
      const existing = subscribers.get(destinationId);
      if (existing === undefined || existing.size === 0) {
        return;
      }
      const frame = JSON.stringify({ type: "record", record });
      // Only measured when a socket is actually behind.
      let frameBytes: number | null = null;

      for (const socket of [...existing]) {
        let sent: unknown;
        try {
          sent = socket.send(frame);
        } catch (error) {
          onSendError(error);
          forget(socket);
          continue;
        }

        // Bun answers with the byte count for a flushed frame and with a
        // negative number (queued) or 0 (dropped) under backpressure; it never
        // throws. Ignoring that return value lets frames pile up in the socket
        // until the whole process runs out of memory.
        const buffered = reportedBufferedBytes(socket);
        if (buffered === 0 && (typeof sent !== "number" || sent > 0)) {
          queued.delete(socket);
          continue;
        }

        frameBytes ??= utf8ByteLength(frame);
        const pending = Math.max(
          buffered,
          (queued.get(socket) ?? 0) + frameBytes,
        );
        queued.set(socket, pending);
        if (pending <= ceiling) {
          continue;
        }
        onSendError(
          new Error(
            `Dropping a WebSocket subscriber of destination ${destinationId}: ` +
              `${pending} buffered bytes exceed the ${ceiling} byte ceiling`,
          ),
        );
        closeSocket(
          socket,
          SocketCloseCode.TryAgainLater,
          "Subscriber too slow",
        );
      }
    },

    countFor(destinationId: string): number {
      return subscribers.get(destinationId)?.size ?? 0;
    },

    closeForDestination(destinationId: string, reason: string): number {
      return closeGroup(
        subscribers,
        destinationId,
        SocketCloseCode.PolicyViolation,
        reason,
      );
    },

    closeForApiUser(apiUserId: string, reason: string): number {
      return closeGroup(
        byApiUser,
        apiUserId,
        SocketCloseCode.PolicyViolation,
        reason,
      );
    },

    closeAll(): void {
      for (const socket of [...attachments.keys()]) {
        closeSocket(socket, SocketCloseCode.GoingAway, "Server shutting down");
      }
      subscribers.clear();
      byApiUser.clear();
      attachments.clear();
      queued.clear();
    },

    setMaxBufferedBytes(bytes: number): void {
      if (Number.isFinite(bytes) && bytes > 0) {
        ceiling = bytes;
      }
    },
  };
}
