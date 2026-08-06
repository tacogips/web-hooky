/**
 * Fetch client: URL and query construction, auth, decoding, error envelope.
 */
import { describe, expect, test } from "bun:test";
import { normalizeBaseUrl } from "../src/config.js";
import { WebhookyError } from "../src/errors.js";
import { buildRecordQuery, WebhookyFetchClient } from "../src/fetch-client.js";
import { BASE_URL, stub } from "./support.js";

function client(fetchImpl: typeof fetch): WebhookyFetchClient {
  return new WebhookyFetchClient({
    baseUrl: BASE_URL,
    apiKey: "key-1",
    apiSecret: "sec-1",
    fetchImpl,
  });
}

describe("base URL normalization", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["http://localhost:8787", "http://localhost:8787", "ws://localhost:8787"],
    [
      "https://hooks.example.com/",
      "https://hooks.example.com",
      "wss://hooks.example.com",
    ],
    [
      "wss://hooks.example.com//",
      "https://hooks.example.com",
      "wss://hooks.example.com",
    ],
    ["http://host:1/prefix/", "http://host:1/prefix", "ws://host:1/prefix"],
  ];

  for (const [raw, http, ws] of cases) {
    test(`normalizes ${raw}`, () => {
      expect(normalizeBaseUrl(raw)).toEqual({ http, ws });
    });
  }

  for (const raw of ["", "   ", "ftp://example.com", "no-scheme-or-host"]) {
    test(`rejects ${JSON.stringify(raw)}`, () => {
      expect(() => normalizeBaseUrl(raw)).toThrow(WebhookyError);
    });
  }
});

test("missing credentials are rejected", () => {
  expect(
    () =>
      new WebhookyFetchClient({
        baseUrl: BASE_URL,
        apiKey: "",
        apiSecret: "s",
      }),
  ).toThrow(WebhookyError);
});

test("records sends the bearer credential and a bare URL", async () => {
  const { fetchImpl, seen } = stub(200, {
    records: [{ t: 10, fetched: false, payload: { a: 1 } }],
  });
  const records = await client(fetchImpl).records("fetch-uuid");

  // A default query must send nothing: the server's own defaults apply.
  expect(seen.url).toBe(`${BASE_URL}/_get/fetch-uuid`);
  expect(seen.headers["authorization"]).toBe("Bearer key-1:sec-1");
  expect(seen.headers["user-agent"]?.startsWith("webhooky-node/")).toBe(true);
  expect(records).toHaveLength(1);
  expect(records[0]?.t).toBe(10);
  expect(records[0]?.fetched).toBe(false);
  expect(records[0]?.payload).toEqual({ a: 1 });
});

test("query parameters are emitted only when they differ from the default", () => {
  expect(buildRecordQuery({})).toEqual({});

  expect(
    buildRecordQuery({
      onlyUnfetched: true,
      markFetched: false,
      from: 100,
      to: new Date(200_000),
      limit: 25,
    }),
  ).toEqual({
    only_unfetched: "true",
    mark_fetched: "false",
    from: "100",
    to: "200",
    limit: "25",
  });

  // The server parses ISO-8601 itself, so a string bound passes through rather
  // than being reinterpreted by a second parser here.
  expect(buildRecordQuery({ from: "2026-01-01T00:00:00Z" })).toEqual({
    from: "2026-01-01T00:00:00Z",
  });

  // markFetched: true is the server default, so it stays off the wire.
  expect(buildRecordQuery({ markFetched: true })).toEqual({});
});

test("an empty result decodes to an empty array", async () => {
  const { fetchImpl } = stub(200, { records: [] });
  expect(await client(fetchImpl).records("uuid")).toEqual([]);
});

test("the error envelope is decoded", async () => {
  const { fetchImpl } = stub(403, {
    error: {
      kind: "forbidden",
      message: "API user is not authorized for this destination",
    },
  });

  const failure = await client(fetchImpl)
    .records("uuid")
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(WebhookyError);
  const error = failure as WebhookyError;
  expect(error.status).toBe(403);
  expect(error.kind).toBe("forbidden");
  expect(error.isForbidden).toBe(true);
  expect(error.message).toContain("not authorized");
});

test("a non-envelope error body still reports the status", async () => {
  // A proxy answering with HTML must not produce an empty, useless error.
  const { fetchImpl } = stub(502, "<html>bad gateway</html>");
  const error = (await client(fetchImpl)
    .records("uuid")
    .catch((e: unknown) => e)) as WebhookyError;

  expect(error.status).toBe(502);
  expect(error.kind).toBe("");
  expect(error.message).toContain("502");
});

test("extra headers are sent but never override the credential", async () => {
  const { fetchImpl, seen } = stub(200, { records: [] });
  const configured = new WebhookyFetchClient({
    baseUrl: BASE_URL,
    apiKey: "key-1",
    apiSecret: "sec-1",
    headers: {
      "cf-access-authenticated-user-email": "ops@example.com",
      authorization: "Bearer attacker:owned",
    },
    userAgent: "custom-agent/9",
    fetchImpl,
  });
  await configured.records("uuid");

  expect(seen.headers["cf-access-authenticated-user-email"]).toBe(
    "ops@example.com",
  );
  expect(seen.headers["user-agent"]).toBe("custom-agent/9");
  // The credentials the caller passed explicitly must win over a header that
  // happens to share the name.
  expect(seen.headers["authorization"]).toBe("Bearer key-1:sec-1");
});

test("a transport failure has status 0", async () => {
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;

  const error = (await client(failing)
    .records("uuid")
    .catch((e: unknown) => e)) as WebhookyError;

  // Status 0 is how a caller tells "unreachable" from "the server refused".
  expect(error.status).toBe(0);
  expect(error.kind).toBe("");
  expect(error.message).toContain("connection refused");
});
