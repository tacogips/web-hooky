import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { resolveAssetPath } from "./static-ui";
import { extractKeyCredentials, hashSecret, verifySecret } from "./credentials";
import { parseFetchQuery } from "./fetch-api";

const config = (() => {
  const loaded = loadConfig({ WEBHOOKY_MAX_FETCH_LIMIT: "500" });
  if (loaded.ok === false) {
    throw new Error("Failed to load the test configuration");
  }
  return loaded.value;
})();

function query(search: string): URL {
  return new URL(`http://test.local/_get/uuid${search}`);
}

describe("parseFetchQuery", () => {
  test("applies defaults", () => {
    const parsed = parseFetchQuery(query(""), config);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        onlyUnfetched: false,
        from: null,
        to: null,
        limit: config.defaultFetchLimit,
        markFetched: true,
      });
    }
  });

  test("parses boolean parameters in several spellings", () => {
    for (const raw of ["true", "1", "yes", "on"]) {
      const parsed = parseFetchQuery(query(`?only_unfetched=${raw}`), config);
      expect(parsed.ok && parsed.value.onlyUnfetched).toBe(true);
    }
    for (const raw of ["false", "0", "no", "off"]) {
      const parsed = parseFetchQuery(query(`?only_unfetched=${raw}`), config);
      expect(parsed.ok && parsed.value.onlyUnfetched).toBe(false);
    }
    expect(parseFetchQuery(query("?only_unfetched=maybe"), config).ok).toBe(
      false,
    );
  });

  test("accepts unix seconds and ISO-8601 bounds", () => {
    const unix = parseFetchQuery(query("?from=1000&to=2000"), config);
    expect(unix.ok).toBe(true);
    if (unix.ok) {
      expect(unix.value.from).toBe(1000);
      expect(unix.value.to).toBe(2000);
    }

    const iso = parseFetchQuery(
      query("?from=2024-01-01T00%3A00%3A00Z"),
      config,
    );
    expect(iso.ok).toBe(true);
    if (iso.ok) {
      expect(iso.value.from).toBe(
        Math.floor(Date.parse("2024-01-01T00:00:00Z") / 1000),
      );
    }

    expect(parseFetchQuery(query("?from=yesterday"), config).ok).toBe(false);
  });

  test("rejects an inverted range", () => {
    expect(parseFetchQuery(query("?from=200&to=100"), config).ok).toBe(false);
  });

  test("caps the limit at the configured maximum", () => {
    const parsed = parseFetchQuery(query("?limit=100000"), config);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.limit).toBe(config.maxFetchLimit);
    }
    expect(parseFetchQuery(query("?limit=0"), config).ok).toBe(false);
    expect(parseFetchQuery(query("?limit=abc"), config).ok).toBe(false);
  });

  test("mark_fetched can be disabled", () => {
    const parsed = parseFetchQuery(query("?mark_fetched=false"), config);
    expect(parsed.ok && parsed.value.markFetched).toBe(false);
  });
});

describe("credentials", () => {
  function request(headers: Record<string, string>): Request {
    return new Request("http://test.local/_get/x", { headers });
  }

  test("reads bearer credentials", () => {
    const credentials = extractKeyCredentials(
      request({ authorization: "Bearer key-1:sec:ret" }),
    );
    expect(credentials).toEqual({ keyId: "key-1", secret: "sec:ret" });
  });

  test("reads the header pair", () => {
    const credentials = extractKeyCredentials(
      request({ "x-api-key": "key-1", "x-api-secret": "s" }),
    );
    expect(credentials).toEqual({ keyId: "key-1", secret: "s" });
  });

  test("reads query parameters only when a url is supplied", () => {
    const url = new URL("http://test.local/_ws/x?api_key=k&api_secret=s");
    expect(extractKeyCredentials(request({}), null)).toBeNull();
    expect(extractKeyCredentials(request({}), url)).toEqual({
      keyId: "k",
      secret: "s",
    });
  });

  test("rejects malformed bearer tokens", () => {
    expect(
      extractKeyCredentials(request({ authorization: "Bearer nocolon" })),
    ).toBeNull();
    expect(
      extractKeyCredentials(request({ authorization: "Basic key:secret" })),
    ).toBeNull();
  });

  test("verifies hashed secrets", async () => {
    const hash = await hashSecret("top-secret");
    expect(await verifySecret("top-secret", hash)).toBe(true);
    expect(await verifySecret("other", hash)).toBe(false);
  });
});

// The hub tests live in ./websocket.test.ts, next to the socket lifecycle
// coverage they share fixtures with.

describe("static asset resolution", () => {
  test("keeps paths inside the ui directory", () => {
    expect(resolveAssetPath("/srv/ui", "index.html")).toBe(
      "/srv/ui/index.html",
    );
    expect(resolveAssetPath("/srv/ui", "../secrets")).toBeNull();
    expect(resolveAssetPath("/srv/ui", "assets/../../secrets")).toBeNull();
  });
});
