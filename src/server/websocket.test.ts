/**
 * WebSocket streaming test against a real `Bun.serve` instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hmacSha256Hex } from "../core/ids";
import {
  createAuthorizedUser,
  createDestination,
  createHarness,
  type CreatedApiUser,
  type CreatedDestination,
  type Harness,
} from "../test-support/harness";
import type { ServerWebSocketLike, UpgradeCapableServer } from "./app";
import {
  createWebSocketHub,
  SocketCloseCode,
  type SocketAttachment,
  type WebSocketLike,
} from "./ws";

const WEBHOOK_SECRET = "ws-webhook-secret";

interface RecordFrame {
  readonly type: string;
  readonly record?: {
    readonly t: number;
    readonly fetched: boolean;
    readonly payload: unknown;
  };
}

function nextRecordFrame(socket: WebSocket): Promise<RecordFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for a record frame"));
    }, 5000);
    socket.addEventListener("message", (event: MessageEvent) => {
      const parsed = JSON.parse(String(event.data)) as RecordFrame;
      if (parsed.type === "record") {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    });
  });
}

/** Resolves once the server has registered the socket with the hub. */
function openReadySocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the ready frame"));
    }, 5000);
    socket.addEventListener("message", (event: MessageEvent) => {
      const parsed = JSON.parse(String(event.data)) as RecordFrame;
      if (parsed.type === "ready") {
        clearTimeout(timer);
        resolve(socket);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed to open"));
    });
  });
}

/** Reports whether the socket closes within the grace period. */
function closesWithin(socket: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Resolves with the close code the server sent. */
function nextClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the socket to close"));
    }, 5000);
    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    });
  });
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error("Timed out opening the WebSocket"));
    }, 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed to open"));
    });
  });
}

describe("WebSocket streaming", () => {
  let harness: Harness;
  let destination: CreatedDestination;
  let consumer: CreatedApiUser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(async () => {
    harness = await createHarness();
    destination = await createDestination(harness, {
      name: "streaming destination",
      vendorAddon: "wrike",
      vendorConfig: { secret: WEBHOOK_SECRET },
    });
    consumer = await createAuthorizedUser(harness, destination.id);

    const app = harness.runtime.app;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request: Request, bunServer: UpgradeCapableServer) {
        const response = await app.fetch(request, bunServer);
        return response ?? undefined;
      },
      websocket: {
        open(socket: ServerWebSocketLike): void {
          app.websocket.open(socket);
        },
        close(socket: ServerWebSocketLike): void {
          app.websocket.close(socket);
        },
        message(socket: ServerWebSocketLike, message: unknown): void {
          app.websocket.message(socket, message);
        },
      },
    });
    origin = `127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await harness.close();
  });

  test("streams newly received webhooks to authorized clients", async () => {
    const socket = await openSocket(
      `ws://${origin}/_ws/${destination.fetchUuid}?api_key=${consumer.id}&api_secret=${encodeURIComponent(
        consumer.credential.split(":").slice(1).join(":"),
      )}`,
    );
    const frame = nextRecordFrame(socket);

    const body = JSON.stringify([{ eventType: "TaskCreated" }]);
    const response = await fetch(
      `http://${origin}/wrike/${destination.inboundUuid}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hook-signature": await hmacSha256Hex(WEBHOOK_SECRET, body),
        },
        body,
      },
    );
    expect(response.status).toBe(202);

    const received = await frame;
    expect(received.record?.fetched).toBe(false);
    expect(received.record?.payload).toMatchObject({ source: "wrike" });
    socket.close();
  });

  test("rejects the upgrade without valid credentials", async () => {
    const response = await fetch(
      `http://${origin}/_ws/${destination.fetchUuid}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(401);
  });

  test("rejects the upgrade for an unknown fetch uuid", async () => {
    const response = await fetch(`http://${origin}/_ws/unknown-uuid`);
    expect(response.status).toBe(404);
  });

  function socketUrl(target: CreatedDestination, user: CreatedApiUser): string {
    const secret = user.credential.split(":").slice(1).join(":");
    return `ws://${origin}/_ws/${target.fetchUuid}?api_key=${user.id}&api_secret=${encodeURIComponent(secret)}`;
  }

  async function streamingSocket(name: string): Promise<{
    readonly target: CreatedDestination;
    readonly user: CreatedApiUser;
    readonly socket: WebSocket;
  }> {
    const target = await createDestination(harness, {
      name,
      vendorAddon: "passthrough",
    });
    const user = await createAuthorizedUser(harness, target.id);
    return {
      target,
      user,
      socket: await openReadySocket(socketUrl(target, user)),
    };
  }

  test("closes live sockets when the authorizing user is disabled", async () => {
    const { user, socket } = await streamingSocket("revoked: disabled user");
    const closed = nextClose(socket);

    const patched = await harness.admin(`/_admin/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(await closed).toBe(SocketCloseCode.PolicyViolation);
  });

  test("closes live sockets when the grant is revoked", async () => {
    const { target, user, socket } = await streamingSocket(
      "revoked: dropped grant",
    );
    const closed = nextClose(socket);

    const revoked = await harness.admin(
      `/_admin/api/users/${user.id}/grants/${target.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    expect(await closed).toBe(SocketCloseCode.PolicyViolation);
  });

  test("closes live sockets when the destination is disabled", async () => {
    const first = await streamingSocket("revoked: disabled destination");
    const untouched = await streamingSocket("unaffected destination");
    const closed = nextClose(first.socket);

    const patched = await harness.admin(
      `/_admin/api/destinations/${first.target.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(patched.status).toBe(200);
    expect(await closed).toBe(SocketCloseCode.PolicyViolation);
    // Revocation is scoped: a subscriber of another destination keeps its
    // stream.
    expect(await closesWithin(untouched.socket, 300)).toBe(false);
    untouched.socket.close();
  });

  test("rejects the upgrade for a disabled destination", async () => {
    // Runs last: disabling is reverted before the assertion completes so the
    // shared destination stays usable for any later test.
    await harness.admin(`/_admin/api/destinations/${destination.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    try {
      const response = await fetch(
        `http://${origin}/_ws/${destination.fetchUuid}`,
        { headers: { upgrade: "websocket" } },
      );
      expect(response.status).toBe(403);
    } finally {
      await harness.admin(`/_admin/api/destinations/${destination.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
    }
  });
});

/** Socket double: records frames and close codes, and can stall its buffer. */
class FakeSocket implements WebSocketLike {
  readonly frames: string[] = [];
  closeCode: number | null = null;
  /** When true, `send` never flushes and the buffer keeps growing. */
  stalled = false;
  /** When true, `send` throws the way a closed socket does. */
  broken = false;
  private buffered = 0;

  send(data: string): number {
    if (this.broken) {
      throw new Error("socket is closed");
    }
    this.frames.push(data);
    if (this.stalled === false) {
      return data.length;
    }
    this.buffered += data.length;
    return -1;
  }

  getBufferedAmount(): number {
    return this.buffered;
  }

  close(code?: number): void {
    this.closeCode = code ?? null;
  }
}

function attachment(
  destinationId: string,
  apiUserId: string,
): SocketAttachment {
  return { destinationId, apiUserId };
}

describe("WebSocket hub", () => {
  test("broadcasts to the subscribers of one destination only", () => {
    const hub = createWebSocketHub();
    const subscriber = new FakeSocket();
    const other = new FakeSocket();

    hub.add(attachment("dest-1", "user-1"), subscriber);
    hub.add(attachment("dest-2", "user-1"), other);
    hub.broadcast("dest-1", { t: 5, fetched: false, payload: { a: 1 } });

    expect(other.frames).toHaveLength(0);
    expect(subscriber.frames).toHaveLength(1);
    expect(JSON.parse(subscriber.frames[0] ?? "{}")).toEqual({
      type: "record",
      record: { t: 5, fetched: false, payload: { a: 1 } },
    });
  });

  test("drops sockets whose send throws", () => {
    const hub = createWebSocketHub();
    const socket = new FakeSocket();
    socket.broken = true;

    hub.add(attachment("dest-1", "user-1"), socket);
    hub.broadcast("dest-1", { t: 1, fetched: false, payload: null });

    expect(hub.countFor("dest-1")).toBe(0);
  });

  test("removes subscribers", () => {
    const hub = createWebSocketHub();
    const socket = new FakeSocket();

    hub.add(attachment("dest-1", "user-1"), socket);
    expect(hub.countFor("dest-1")).toBe(1);
    hub.remove(socket);
    expect(hub.countFor("dest-1")).toBe(0);
  });

  test("closes a subscriber that buffers past the ceiling", () => {
    const errors: unknown[] = [];
    const hub = createWebSocketHub((error) => errors.push(error));
    hub.setMaxBufferedBytes(64);
    const slow = new FakeSocket();
    slow.stalled = true;
    const healthy = new FakeSocket();

    hub.add(attachment("dest-1", "user-1"), slow);
    hub.add(attachment("dest-1", "user-2"), healthy);
    // Each frame is well under the ceiling; only the accumulated backlog of a
    // socket that never flushes crosses it.
    for (let index = 0; index < 20; index += 1) {
      hub.broadcast("dest-1", { t: index, fetched: false, payload: null });
    }

    expect(slow.closeCode).toBe(SocketCloseCode.TryAgainLater);
    expect(errors.length).toBeGreaterThan(0);
    expect(hub.countFor("dest-1")).toBe(1);
    expect(healthy.frames).toHaveLength(20);
    // The dropped socket stops receiving as soon as it is closed.
    expect(slow.frames.length).toBeLessThan(20);
  });

  test("closes every socket of a destination", () => {
    const hub = createWebSocketHub();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const elsewhere = new FakeSocket();

    hub.add(attachment("dest-1", "user-1"), first);
    hub.add(attachment("dest-1", "user-2"), second);
    hub.add(attachment("dest-2", "user-1"), elsewhere);

    expect(hub.closeForDestination("dest-1", "gone")).toBe(2);
    expect(first.closeCode).toBe(SocketCloseCode.PolicyViolation);
    expect(second.closeCode).toBe(SocketCloseCode.PolicyViolation);
    expect(elsewhere.closeCode).toBeNull();
    expect(hub.countFor("dest-1")).toBe(0);
    expect(hub.countFor("dest-2")).toBe(1);
  });

  test("closes every socket an API user opened, across destinations", () => {
    const hub = createWebSocketHub();
    const revoked = new FakeSocket();
    const alsoRevoked = new FakeSocket();
    const otherUser = new FakeSocket();

    hub.add(attachment("dest-1", "user-1"), revoked);
    hub.add(attachment("dest-2", "user-1"), alsoRevoked);
    hub.add(attachment("dest-1", "user-2"), otherUser);

    expect(hub.closeForApiUser("user-1", "revoked")).toBe(2);
    expect(revoked.closeCode).toBe(SocketCloseCode.PolicyViolation);
    expect(alsoRevoked.closeCode).toBe(SocketCloseCode.PolicyViolation);
    expect(otherUser.closeCode).toBeNull();
    expect(hub.countFor("dest-1")).toBe(1);
    expect(hub.countFor("dest-2")).toBe(0);
  });

  test("closeAll hangs up every socket", () => {
    const hub = createWebSocketHub();
    const first = new FakeSocket();
    const second = new FakeSocket();

    hub.add(attachment("dest-1", "user-1"), first);
    hub.add(attachment("dest-2", "user-2"), second);
    hub.closeAll();

    expect(first.closeCode).toBe(SocketCloseCode.GoingAway);
    expect(second.closeCode).toBe(SocketCloseCode.GoingAway);
    expect(hub.countFor("dest-1")).toBe(0);
    expect(hub.countFor("dest-2")).toBe(0);
  });
});
