/**
 * Unit tests for the Cloudflare platform adapter, driven through doubles.
 *
 * The adapter's interfaces (`D1DatabaseLike`, `DurableObjectNamespaceLike`, the
 * hibernation-state surface of `StreamHub`) are declared structurally for
 * exactly this reason: the contract each piece keeps can be asserted without a
 * Workers runtime. What these tests cannot cover - the real `WebSocketPair`
 * upgrade and D1's actual SQL semantics - was verified against the deployed
 * Worker; the atomic-claim SQL itself runs against real SQLite in the storage
 * suites, and D1 executes the same statements.
 */
import { describe, expect, test } from "bun:test";
import type { PublicRecord } from "../../storage/types";
import {
  createD1Driver,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "./d1-driver";
import { createDurableObjectHub } from "./hub-proxy";
import { STREAM_HUB_ROUTES, StreamHub } from "./stream-hub";

// ---------------------------------------------------------------------------
// D1 driver
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeD1(rows: readonly unknown[] = [], changes = 0) {
  const calls: RecordedCall[] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1PreparedStatementLike {
      const make = (params: readonly unknown[]): D1PreparedStatementLike => ({
        bind(...values: readonly (string | number | null)[]) {
          return make(values);
        },
        all<T>() {
          calls.push({ sql, params });
          return Promise.resolve({ results: rows as T[] });
        },
        run() {
          calls.push({ sql, params });
          return Promise.resolve({ meta: { changes } });
        },
      });
      return make([]);
    },
  };
  return { db, calls };
}

describe("D1 driver", () => {
  test("binds parameters and runs statements", async () => {
    const { db, calls } = fakeD1();
    const driver = createD1Driver(db);
    await driver.run("INSERT INTO t VALUES (?, ?)", ["a", 1]);
    expect(calls).toEqual([
      { sql: "INSERT INTO t VALUES (?, ?)", params: ["a", 1] },
    ]);
  });

  test("skips bind entirely when there are no parameters", async () => {
    // D1 rejects an empty bind(), so a parameterless statement must never call
    // it. The fake starts with [] and bind() replaces it, so any bind call
    // with no values would be indistinguishable - assert via a bind that
    // throws instead.
    let bindCalled = false;
    const db: D1DatabaseLike = {
      prepare(): D1PreparedStatementLike {
        const statement: D1PreparedStatementLike = {
          bind() {
            bindCalled = true;
            return statement;
          },
          all<T>() {
            return Promise.resolve({ results: [] as T[] });
          },
          run() {
            return Promise.resolve({ meta: { changes: 0 } });
          },
        };
        return statement;
      },
    };
    await createD1Driver(db).run("SELECT 1");
    expect(bindCalled).toBe(false);
  });

  test("runAffected reports the change count", async () => {
    const { db } = fakeD1([], 7);
    expect(await createD1Driver(db).runAffected("UPDATE t SET x = 1")).toBe(7);
  });

  test("runAffected treats a missing change count as zero", async () => {
    const db: D1DatabaseLike = {
      prepare(): D1PreparedStatementLike {
        const statement: D1PreparedStatementLike = {
          bind: () => statement,
          all: <T>() => Promise.resolve({ results: [] as T[] }),
          run: () => Promise.resolve({ meta: {} }),
        };
        return statement;
      },
    };
    expect(await createD1Driver(db).runAffected("DELETE FROM t")).toBe(0);
  });

  test("all returns the result rows", async () => {
    const { db } = fakeD1([{ id: "r1" }, { id: "r2" }]);
    expect(await createD1Driver(db).all("SELECT * FROM t")).toEqual([
      { id: "r1" },
      { id: "r2" },
    ]);
  });

  test("get returns the first row or null", async () => {
    const { db } = fakeD1([{ id: "r1" }, { id: "r2" }]);
    const first = await createD1Driver(db).get<{ id: string }>(
      "SELECT * FROM t",
    );
    expect(first).toEqual({ id: "r1" });
    const empty = fakeD1([]);
    expect(await createD1Driver(empty.db).get("SELECT * FROM t")).toBeNull();
  });

  test("transaction rejects rather than degrading isolation", async () => {
    const { db } = fakeD1();
    await expect(
      createD1Driver(db).transaction(async () => "unreachable"),
    ).rejects.toThrow("does not support interactive transactions");
  });
});

// ---------------------------------------------------------------------------
// Durable Object hub proxy
// ---------------------------------------------------------------------------

interface DoCall {
  readonly doName: string;
  readonly url: URL;
  readonly method: string;
  readonly body: Promise<string>;
}

function fakeHubEnvironment(options?: {
  readonly failFetch?: boolean;
  readonly grants?: readonly string[];
}) {
  const calls: DoCall[] = [];
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];

  const hub = createDurableObjectHub({
    namespace: {
      idFromName: (name: string) => ({ name }),
      get(id: unknown) {
        const doName = (id as { name: string }).name;
        return {
          fetch(request: Request): Promise<Response> {
            calls.push({
              doName,
              url: new URL(request.url),
              method: request.method,
              body: request.text(),
            });
            return options?.failFetch === true
              ? Promise.reject(new Error("durable object unreachable"))
              : Promise.resolve(new Response("{}"));
          },
        };
      },
    },
    waitUntil: (work) => {
      pending.push(work);
    },
    destinationsForApiUser: () => Promise.resolve(options?.grants ?? []),
    onError: (error) => {
      errors.push(error);
    },
  });

  return {
    hub,
    calls,
    errors,
    settle: () => Promise.all(pending),
  };
}

const RECORD: PublicRecord = { t: 42, fetched: false, payload: { ok: true } };

describe("Durable Object hub proxy", () => {
  test("broadcast posts the record to the destination's own object", async () => {
    const env = fakeHubEnvironment();
    env.hub.broadcast("dest-1", RECORD);
    await env.settle();

    expect(env.calls).toHaveLength(1);
    const call = env.calls[0];
    expect(call?.doName).toBe("dest-1");
    expect(call?.method).toBe("POST");
    expect(call?.url.pathname).toBe(STREAM_HUB_ROUTES.broadcast);
    expect(JSON.parse((await call?.body) ?? "")).toEqual(RECORD);
  });

  test("closeForDestination reaches only that destination", async () => {
    const env = fakeHubEnvironment();
    env.hub.closeForDestination("dest-2", "Destination disabled");
    await env.settle();

    const call = env.calls[0];
    expect(call?.doName).toBe("dest-2");
    expect(call?.url.pathname).toBe(STREAM_HUB_ROUTES.closeDestination);
    expect(call?.url.searchParams.get("reason")).toBe("Destination disabled");
  });

  test("closeForApiUser fans out to every granted destination", async () => {
    const env = fakeHubEnvironment({ grants: ["dest-a", "dest-b"] });
    env.hub.closeForApiUser("user-1", "Access revoked");
    await env.settle();

    expect(env.calls.map((call) => call.doName).sort()).toEqual([
      "dest-a",
      "dest-b",
    ]);
    for (const call of env.calls) {
      expect(call.url.pathname).toBe(STREAM_HUB_ROUTES.closeApiUser);
      expect(call.url.searchParams.get("apiUserId")).toBe("user-1");
    }
  });

  test("a failing durable object call is reported, never thrown", async () => {
    const env = fakeHubEnvironment({ failFetch: true });
    // The synchronous hub interface must absorb the async failure.
    expect(() => {
      env.hub.broadcast("dest-1", RECORD);
    }).not.toThrow();
    await env.settle();
    expect(env.errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// StreamHub durable object
// ---------------------------------------------------------------------------

interface FakeSocket {
  readonly sent: string[];
  readonly closes: { code?: number; reason?: string }[];
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function fakeSocket(options?: { readonly broken?: boolean }): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closes: [],
    send(data: string): void {
      if (options?.broken === true) {
        throw new Error("socket already gone");
      }
      socket.sent.push(data);
    },
    close(code?: number, reason?: string): void {
      if (options?.broken === true) {
        throw new Error("socket already gone");
      }
      socket.closes.push(
        code === undefined
          ? {}
          : { code, ...(reason === undefined ? {} : { reason }) },
      );
    },
  };
  return socket;
}

function streamHubWith(sockets: ReadonlyMap<FakeSocket, readonly string[]>) {
  return new StreamHub({
    acceptWebSocket(): void {},
    getWebSockets(tag?: string): WebSocket[] {
      const matching = [...sockets.entries()]
        .filter(([, tags]) => tag === undefined || tags.includes(tag))
        .map(([socket]) => socket);
      return matching as unknown as WebSocket[];
    },
  });
}

function hubRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://stream-hub.invalid${path}`, init);
}

describe("StreamHub durable object", () => {
  test("broadcast sends the record frame to every socket", async () => {
    const first = fakeSocket();
    const second = fakeSocket();
    const hub = streamHubWith(
      new Map([
        [first, ["user-1"]],
        [second, ["user-2"]],
      ]),
    );
    const response = await hub.fetch(
      hubRequest(STREAM_HUB_ROUTES.broadcast, {
        method: "POST",
        body: JSON.stringify(RECORD),
      }),
    );
    expect(((await response.json()) as { delivered: number }).delivered).toBe(
      2,
    );
    for (const socket of [first, second]) {
      expect(socket.sent).toHaveLength(1);
      expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
        type: "record",
        record: RECORD,
      });
    }
  });

  test("a dead socket does not stop delivery to the others", async () => {
    const dead = fakeSocket({ broken: true });
    const alive = fakeSocket();
    const hub = streamHubWith(
      new Map([
        [dead, ["user-1"]],
        [alive, ["user-2"]],
      ]),
    );
    const response = await hub.fetch(
      hubRequest(STREAM_HUB_ROUTES.broadcast, {
        method: "POST",
        body: JSON.stringify(RECORD),
      }),
    );
    expect(((await response.json()) as { delivered: number }).delivered).toBe(
      1,
    );
    expect(alive.sent).toHaveLength(1);
  });

  test("close-destination hangs up every socket", async () => {
    const first = fakeSocket();
    const second = fakeSocket();
    const hub = streamHubWith(
      new Map([
        [first, ["user-1"]],
        [second, ["user-2"]],
      ]),
    );
    const response = await hub.fetch(
      hubRequest(`${STREAM_HUB_ROUTES.closeDestination}?reason=disabled`, {
        method: "POST",
      }),
    );
    expect(((await response.json()) as { closed: number }).closed).toBe(2);
    expect(first.closes[0]?.reason).toBe("disabled");
    expect(second.closes[0]?.reason).toBe("disabled");
  });

  test("close-api-user hangs up only that user's sockets", async () => {
    const revoked = fakeSocket();
    const untouched = fakeSocket();
    const hub = streamHubWith(
      new Map([
        [revoked, ["user-1"]],
        [untouched, ["user-2"]],
      ]),
    );
    const response = await hub.fetch(
      hubRequest(
        `${STREAM_HUB_ROUTES.closeApiUser}?apiUserId=user-1&reason=revoked`,
        { method: "POST" },
      ),
    );
    expect(((await response.json()) as { closed: number }).closed).toBe(1);
    expect(revoked.closes).toHaveLength(1);
    expect(untouched.closes).toHaveLength(0);
  });

  test("subscribe without an upgrade header is a 400", async () => {
    const hub = streamHubWith(new Map());
    const response = await hub.fetch(
      hubRequest(`${STREAM_HUB_ROUTES.subscribe}?apiUserId=user-1`),
    );
    expect(response.status).toBe(400);
  });

  test("unknown control paths are 404", async () => {
    const hub = streamHubWith(new Map());
    const response = await hub.fetch(hubRequest("/anything-else"));
    expect(response.status).toBe(404);
  });
});
