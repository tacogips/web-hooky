import { describe, expect, test } from "bun:test";
import {
  AdminAuthMode,
  configWarnings,
  DEFAULT_CONFIG,
  loadConfig,
  parseArgv,
} from "./config";

describe("parseArgv", () => {
  test("maps flags to environment keys", () => {
    const parsed = parseArgv(["--port", "9000", "--db=./tmp.sqlite"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["WEBHOOKY_PORT"]).toBe("9000");
      expect(parsed.value["WEBHOOKY_DB_PATH"]).toBe("./tmp.sqlite");
    }
  });

  test("rejects unknown flags", () => {
    expect(parseArgv(["--nope", "1"]).ok).toBe(false);
  });

  test("rejects flags without a value", () => {
    expect(parseArgv(["--port", "--db", "x"]).ok).toBe(false);
  });

  test("ignores --help", () => {
    const parsed = parseArgv(["--help"]);
    expect(parsed.ok).toBe(true);
  });
});

describe("loadConfig", () => {
  test("applies defaults when the environment is empty", () => {
    const config = loadConfig({});
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.port).toBe(DEFAULT_CONFIG.port);
      expect(config.value.retentionSeconds).toBe(
        DEFAULT_CONFIG.retentionSeconds,
      );
      expect(config.value.adminAuthMode).toBe(AdminAuthMode.TrustedHeader);
      expect(config.value.adminSubjects).toEqual([]);
    }
  });

  test("flags override the environment", () => {
    const config = loadConfig({ WEBHOOKY_PORT: "1111" }, ["--port", "2222"]);
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.port).toBe(2222);
    }
  });

  test("parses admin subjects as a comma separated list", () => {
    const config = loadConfig({
      WEBHOOKY_ADMIN_SUBJECTS: "a@example.com, b@example.com ,",
    });
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.adminSubjects).toEqual([
        "a@example.com",
        "b@example.com",
      ]);
    }
  });

  test("rejects a non-integer port", () => {
    expect(loadConfig({ WEBHOOKY_PORT: "abc" }).ok).toBe(false);
  });

  test("rejects numeric values with trailing or exponent syntax", () => {
    // `Number.parseInt` would read these as 8787 and 1, turning a typo into a
    // silently wrong setting.
    expect(loadConfig({ WEBHOOKY_PORT: "8787x" }).ok).toBe(false);
    expect(loadConfig({ WEBHOOKY_CACHE_TTL_SECONDS: "1e6" }).ok).toBe(false);
    expect(loadConfig({ WEBHOOKY_MAX_BODY_BYTES: "1_000" }).ok).toBe(false);
    expect(loadConfig({ WEBHOOKY_RETENTION_SECONDS: "30 " }).ok).toBe(true);
  });

  test("reads the websocket buffer ceiling", () => {
    const defaults = loadConfig({});
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      expect(defaults.value.wsMaxBufferedBytes).toBe(
        DEFAULT_CONFIG.wsMaxBufferedBytes,
      );
    }

    const overridden = loadConfig({}, ["--ws-max-buffered-bytes", "4096"]);
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.value.wsMaxBufferedBytes).toBe(4096);
    }

    expect(loadConfig({ WEBHOOKY_WS_MAX_BUFFERED_BYTES: "0" }).ok).toBe(false);
  });

  test("refuses dev admin auth on a non-loopback bind", () => {
    // Dev mode authenticates nobody, so exposing it is an open admin API.
    expect(
      loadConfig({ WEBHOOKY_ADMIN_AUTH: "dev", WEBHOOKY_HOST: "0.0.0.0" }).ok,
    ).toBe(false);
    expect(
      loadConfig({ WEBHOOKY_ADMIN_AUTH: "dev", WEBHOOKY_HOST: "127.0.0.1" }).ok,
    ).toBe(true);
    expect(
      loadConfig({ WEBHOOKY_ADMIN_AUTH: "dev", WEBHOOKY_HOST: "localhost" }).ok,
    ).toBe(true);
  });

  test("rejects an unknown admin auth mode", () => {
    expect(loadConfig({ WEBHOOKY_ADMIN_AUTH: "magic" }).ok).toBe(false);
  });

  test("rejects a malformed bootstrap admin key", () => {
    expect(
      loadConfig({ WEBHOOKY_ADMIN_BOOTSTRAP_KEY: "no-separator" }).ok,
    ).toBe(false);
  });

  test("rejects a default limit above the maximum limit", () => {
    const config = loadConfig({
      WEBHOOKY_DEFAULT_FETCH_LIMIT: "50",
      WEBHOOKY_MAX_FETCH_LIMIT: "10",
    });
    expect(config.ok).toBe(false);
  });

  test("normalises the allowed admin origins", () => {
    const config = loadConfig({
      WEBHOOKY_ADMIN_ALLOWED_ORIGINS: "https://Admin.Example/ , http://b.test",
    });
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.adminAllowedOrigins).toEqual([
        "https://admin.example",
        "http://b.test",
      ]);
    }
  });

  test("reads the relay settings and their defaults", () => {
    const defaults = loadConfig({});
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      expect(defaults.value.relay.pollIntervalSeconds).toBe(
        DEFAULT_CONFIG.relayPollIntervalSeconds,
      );
      expect(defaults.value.relay.defaultMaxAttempts).toBe(
        DEFAULT_CONFIG.relayMaxAttempts,
      );
    }

    const overridden = loadConfig({}, [
      "--relay-interval",
      "0",
      "--relay-max-attempts",
      "3",
    ]);
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.value.relay.pollIntervalSeconds).toBe(0);
      expect(overridden.value.relay.defaultMaxAttempts).toBe(3);
    }

    expect(loadConfig({ WEBHOOKY_RELAY_MAX_ATTEMPTS: "0" }).ok).toBe(false);
    expect(loadConfig({ WEBHOOKY_RELAY_BATCH_SIZE: "nope" }).ok).toBe(false);
  });

  test("rejects a default relay timeout that reaches the lease", () => {
    // An attempt still running when its lease expires is claimed again, so the
    // same webhook is delivered twice for no reason.
    expect(
      loadConfig({
        WEBHOOKY_RELAY_LEASE_SECONDS: "30",
        WEBHOOKY_RELAY_TIMEOUT_SECONDS: "30",
      }).ok,
    ).toBe(false);
    expect(
      loadConfig({
        WEBHOOKY_RELAY_LEASE_SECONDS: "30",
        WEBHOOKY_RELAY_TIMEOUT_SECONDS: "29",
      }).ok,
    ).toBe(true);
  });

  test("lower-cases header names", () => {
    const config = loadConfig({
      WEBHOOKY_ADMIN_AUTH_HEADER: "X-Custom-Identity",
    });
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.adminAuthHeader).toBe("x-custom-identity");
    }
  });
});

describe("configWarnings", () => {
  function warningsFor(
    env: Readonly<Record<string, string>>,
  ): readonly string[] {
    const config = loadConfig(env);
    if (config.ok === false) {
      throw new Error(config.error.message);
    }
    return configWarnings(config.value);
  }

  test("warns about spoofable trusted-header auth on a non-loopback bind", () => {
    const warnings = warningsFor({ WEBHOOKY_HOST: "0.0.0.0" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("trusted-header");
  });

  test("always warns about dev admin auth", () => {
    const warnings = warningsFor({ WEBHOOKY_ADMIN_AUTH: "dev" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dev");
  });

  test("stays silent on loopback, with a shared secret, or in another mode", () => {
    expect(warningsFor({})).toHaveLength(0);
    expect(
      warningsFor({
        WEBHOOKY_HOST: "0.0.0.0",
        WEBHOOKY_ADMIN_AUTH_SHARED_SECRET: "proxy-secret",
      }),
    ).toHaveLength(0);
    expect(
      warningsFor({
        WEBHOOKY_HOST: "0.0.0.0",
        WEBHOOKY_ADMIN_AUTH: "disabled",
      }),
    ).toHaveLength(0);
  });
});
