/**
 * Stream URL construction, frame decoding, backoff, and the iterator contract.
 */
import { expect, test } from "bun:test";
import { resolveFetchConfig } from "../src/config.js";
import { WebhookyError } from "../src/errors.js";
import {
  backoffFor,
  buildStreamUrl,
  decodeFrame,
  POLICY_VIOLATION,
  StreamClosedByServerError,
  streamRecords,
  type StreamOptions,
} from "../src/stream.js";
import type { WebhookRecord } from "../src/types.js";
import { BASE_URL } from "./support.js";

const config = resolveFetchConfig({
  baseUrl: BASE_URL,
  apiKey: "key-1",
  apiSecret: "sec-1",
});

test("the stream URL carries the key pair as query values", () => {
  // The WHATWG WebSocket constructor takes no headers, which is exactly why the
  // server accepts credentials this way.
  const url = new URL(buildStreamUrl(config, "fetch-uuid"));
  expect(url.protocol).toBe("wss:");
  expect(url.pathname).toBe("/_ws/fetch-uuid");
  expect(url.searchParams.get("api_key")).toBe("key-1");
  expect(url.searchParams.get("api_secret")).toBe("sec-1");
});

test("frames decode by type", () => {
  expect(decodeFrame('{"type":"ready"}')).toEqual({
    type: "ready",
    record: null,
  });

  const frame = decodeFrame(
    JSON.stringify({
      type: "record",
      record: { t: 3, fetched: false, payload: 1 },
    }),
  );
  expect(frame.type).toBe("record");
  expect(frame.record?.t).toBe(3);

  // A server that grows a new frame kind must not break an older client.
  expect(decodeFrame('{"type":"future-kind"}')).toEqual({
    type: "future-kind",
    record: null,
  });
});

test("malformed frames are rejected", () => {
  expect(() => decodeFrame("not json")).toThrow(WebhookyError);
  expect(() => decodeFrame('{"type":"record"}')).toThrow(WebhookyError);
});

test("backoff is exponential and capped", () => {
  expect(backoffFor(1, 500, 30_000)).toBe(500);
  expect(backoffFor(3, 500, 30_000)).toBe(2000);
  // A long-lived stream must not grow an absurd delay.
  expect(backoffFor(500, 500, 30_000)).toBe(30_000);
});

/**
 * A minimal WebSocket double: it replays a script of frames and then closes.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedWith: number | null = null;

  constructor(
    readonly url: string,
    private readonly frames: readonly string[],
    private readonly closeCode: number,
  ) {
    FakeSocket.instances.push(this);
    // Deliver asynchronously so the consumer is already awaiting.
    queueMicrotask(() => this.replay());
  }

  private replay(): void {
    for (const frame of this.frames) {
      this.onmessage?.({ data: frame } as MessageEvent);
    }
    this.onclose?.({ code: this.closeCode } as CloseEvent);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
}

function socketFactory(
  frames: readonly string[],
  closeCode: number,
): typeof WebSocket {
  return function (this: unknown, url: string | URL): FakeSocket {
    return new FakeSocket(String(url), frames, closeCode);
  } as unknown as typeof WebSocket;
}

async function collect(
  frames: readonly string[],
  closeCode: number,
  options: StreamOptions = {},
): Promise<readonly WebhookRecord[]> {
  const received: WebhookRecord[] = [];
  for await (const record of streamRecords(config, "uuid", {
    ...options,
    webSocketImpl: socketFactory(frames, closeCode),
  })) {
    received.push(record);
  }
  return received;
}

test("records are yielded and the ready frame fires its callback", async () => {
  let ready = false;
  const records = await collect(
    [
      '{"type":"ready"}',
      '{"type":"record","record":{"t":1,"fetched":false,"payload":{"n":1}}}',
      '{"type":"record","record":{"t":2,"fetched":false,"payload":{"n":2}}}',
    ],
    1000,
    { onReady: () => (ready = true) },
  );

  expect(ready).toBe(true);
  expect(records.map((record) => record.t)).toEqual([1, 2]);
});

test("maxRecords ends the stream and closes the socket", async () => {
  FakeSocket.instances = [];
  const records = await collect(
    [
      '{"type":"record","record":{"t":1,"fetched":false,"payload":null}}',
      '{"type":"record","record":{"t":2,"fetched":false,"payload":null}}',
    ],
    1000,
    { maxRecords: 1 },
  );

  expect(records).toHaveLength(1);
  expect(FakeSocket.instances[0]?.closedWith).toBe(1000);
});

test("a policy-violation close ends the stream even with reconnect on", async () => {
  // 1008 means the credential or grant was revoked. Reconnecting would only
  // hammer a server that has already refused.
  const failure = await collect(['{"type":"ready"}'], POLICY_VIOLATION, {
    reconnect: true,
    initialBackoffMs: 1,
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StreamClosedByServerError);
});

test("breaking out of the loop closes the socket", async () => {
  FakeSocket.instances = [];
  const iterator = streamRecords(config, "uuid", {
    webSocketImpl: socketFactory(
      [
        '{"type":"record","record":{"t":1,"fetched":false,"payload":null}}',
        '{"type":"record","record":{"t":2,"fetched":false,"payload":null}}',
      ],
      1000,
    ),
  });

  for await (const record of iterator) {
    expect(record.t).toBe(1);
    break;
  }

  expect(FakeSocket.instances[0]?.closedWith).toBe(1000);
});

test("a malformed frame ends the stream with an error", async () => {
  const failure = await collect(["not json"], 1000).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(WebhookyError);
});
