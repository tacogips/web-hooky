/**
 * Configuration loading from environment variables and CLI flags.
 *
 * Flags take precedence over the environment. Every value is validated up
 * front so a misconfigured server fails at startup instead of at first request.
 */
import { type AppError, errors } from "./core/errors";
import { err, ok, type Result } from "./core/result";

export enum AdminAuthMode {
  TrustedHeader = "trusted-header",
  Dev = "dev",
  Disabled = "disabled",
}

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly retentionSeconds: number;
  readonly retentionSweepIntervalSeconds: number;
  readonly addonsDir: string;
  readonly adminUiDir: string;
  readonly adminSubjects: readonly string[];
  readonly adminAuthMode: AdminAuthMode;
  readonly adminAuthHeader: string;
  readonly adminAuthSharedSecret: string | null;
  readonly adminAuthSharedSecretHeader: string;
  readonly adminDevSubject: string;
  /** Extra origins allowed to issue IdP-authenticated admin mutations. */
  readonly adminAllowedOrigins: readonly string[];
  readonly bootstrapAdminKey: string | null;
  readonly maxBodyBytes: number;
  readonly defaultFetchLimit: number;
  readonly maxFetchLimit: number;
  readonly cacheTtlSeconds: number;
  /** Outbound buffer a single WebSocket subscriber may accumulate. */
  readonly wsMaxBufferedBytes: number;
  readonly relay: RelayConfig;
}

/** Relay (forwarding) worker settings and per-relay defaults. */
export interface RelayConfig {
  /** Worker poll period; 0 disables the in-process timer. */
  readonly pollIntervalSeconds: number;
  readonly batchSize: number;
  readonly maxBackoffSeconds: number;
  /**
   * How long a claimed delivery is hidden from other workers. Must exceed the
   * largest relay timeout in use.
   */
  readonly leaseSeconds: number;
  /** How long a delivery waits while its relay is disabled. */
  readonly parkSeconds: number;
  readonly defaultMaxAttempts: number;
  readonly defaultBackoffSeconds: number;
  readonly defaultTimeoutSeconds: number;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8787,
  dbPath: "./data/web-hooky.sqlite",
  retentionSeconds: 2_592_000,
  retentionSweepIntervalSeconds: 300,
  addonsDir: "./data/addons",
  adminUiDir: "./dist/admin-ui",
  adminAuthHeader: "cf-access-authenticated-user-email",
  adminAuthSharedSecretHeader: "x-webhooky-proxy-secret",
  adminDevSubject: "dev@localhost",
  maxBodyBytes: 1_048_576,
  defaultFetchLimit: 100,
  maxFetchLimit: 1000,
  cacheTtlSeconds: 30,
  wsMaxBufferedBytes: 1_048_576,
  relayPollIntervalSeconds: 5,
  relayBatchSize: 20,
  relayMaxBackoffSeconds: 3600,
  relayLeaseSeconds: 300,
  relayParkSeconds: 300,
  relayMaxAttempts: 5,
  relayBackoffSeconds: 10,
  relayTimeoutSeconds: 10,
} as const;

/** Addresses that are only reachable from the machine itself. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const FLAG_TO_ENV: ReadonlyMap<string, string> = new Map([
  ["--host", "WEBHOOKY_HOST"],
  ["--port", "WEBHOOKY_PORT"],
  ["--db", "WEBHOOKY_DB_PATH"],
  ["--retention", "WEBHOOKY_RETENTION_SECONDS"],
  ["--sweep-interval", "WEBHOOKY_RETENTION_SWEEP_INTERVAL_SECONDS"],
  ["--addons-dir", "WEBHOOKY_ADDONS_DIR"],
  ["--admin-ui-dir", "WEBHOOKY_ADMIN_UI_DIR"],
  ["--admin-subjects", "WEBHOOKY_ADMIN_SUBJECTS"],
  ["--admin-auth", "WEBHOOKY_ADMIN_AUTH"],
  ["--admin-auth-header", "WEBHOOKY_ADMIN_AUTH_HEADER"],
  ["--admin-auth-shared-secret", "WEBHOOKY_ADMIN_AUTH_SHARED_SECRET"],
  [
    "--admin-auth-shared-secret-header",
    "WEBHOOKY_ADMIN_AUTH_SHARED_SECRET_HEADER",
  ],
  ["--admin-dev-subject", "WEBHOOKY_ADMIN_DEV_SUBJECT"],
  ["--admin-allowed-origins", "WEBHOOKY_ADMIN_ALLOWED_ORIGINS"],
  ["--bootstrap-admin-key", "WEBHOOKY_ADMIN_BOOTSTRAP_KEY"],
  ["--max-body-bytes", "WEBHOOKY_MAX_BODY_BYTES"],
  ["--default-limit", "WEBHOOKY_DEFAULT_FETCH_LIMIT"],
  ["--max-limit", "WEBHOOKY_MAX_FETCH_LIMIT"],
  ["--cache-ttl", "WEBHOOKY_CACHE_TTL_SECONDS"],
  ["--ws-max-buffered-bytes", "WEBHOOKY_WS_MAX_BUFFERED_BYTES"],
  ["--relay-interval", "WEBHOOKY_RELAY_POLL_INTERVAL_SECONDS"],
  ["--relay-batch", "WEBHOOKY_RELAY_BATCH_SIZE"],
  ["--relay-max-backoff", "WEBHOOKY_RELAY_MAX_BACKOFF_SECONDS"],
  ["--relay-lease", "WEBHOOKY_RELAY_LEASE_SECONDS"],
  ["--relay-park", "WEBHOOKY_RELAY_PARK_SECONDS"],
  ["--relay-max-attempts", "WEBHOOKY_RELAY_MAX_ATTEMPTS"],
  ["--relay-backoff", "WEBHOOKY_RELAY_BACKOFF_SECONDS"],
  ["--relay-timeout", "WEBHOOKY_RELAY_TIMEOUT_SECONDS"],
]);

/** Converts `--flag value` / `--flag=value` pairs into environment overrides. */
export function parseArgv(
  argv: readonly string[],
): Result<Record<string, string>, AppError> {
  const overrides: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.startsWith("--") === false) {
      continue;
    }
    const separator = token.indexOf("=");
    const flag = separator === -1 ? token : token.slice(0, separator);
    const envKey = FLAG_TO_ENV.get(flag);
    if (envKey === undefined) {
      if (flag === "--help") {
        continue;
      }
      return err(errors.badRequest(`Unknown flag: ${flag}`));
    }
    if (separator !== -1) {
      overrides[envKey] = token.slice(separator + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return err(errors.badRequest(`Flag ${flag} requires a value`));
    }
    overrides[envKey] = next;
    index += 1;
  }
  return ok(overrides);
}

/**
 * Whole-string integer form.
 *
 * `Number.parseInt` stops at the first character it cannot read, so it turns
 * `8787x` into 8787 and `1e6` into 1: a typo becomes a silently wrong setting
 * instead of a startup failure.
 */
const INTEGER_PATTERN = /^[+-]?\d+$/;

function readInteger(
  env: EnvSource,
  key: string,
  fallback: number,
  minimum: number,
): Result<number, AppError> {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return ok(fallback);
  }
  const trimmed = raw.trim();
  if (INTEGER_PATTERN.test(trimmed) === false) {
    return err(errors.badRequest(`${key} must be an integer (got "${raw}")`));
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isSafeInteger(parsed) === false) {
    return err(
      errors.badRequest(`${key} must be an integer below 2^53 (got "${raw}")`),
    );
  }
  if (parsed < minimum) {
    return err(
      errors.badRequest(`${key} must be >= ${minimum} (got ${parsed})`),
    );
  }
  return ok(parsed);
}

function readString(env: EnvSource, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim().length === 0 ? fallback : raw.trim();
}

function parseAdminAuthMode(raw: string): AdminAuthMode | null {
  switch (raw) {
    case AdminAuthMode.TrustedHeader:
      return AdminAuthMode.TrustedHeader;
    case AdminAuthMode.Dev:
      return AdminAuthMode.Dev;
    case AdminAuthMode.Disabled:
      return AdminAuthMode.Disabled;
    default:
      return null;
  }
}

/** Reads the relay worker settings and the per-relay defaults. */
function loadRelayConfig(env: EnvSource): Result<RelayConfig, AppError> {
  const pollInterval = readInteger(
    env,
    "WEBHOOKY_RELAY_POLL_INTERVAL_SECONDS",
    DEFAULT_CONFIG.relayPollIntervalSeconds,
    0,
  );
  if (pollInterval.ok === false) {
    return err(pollInterval.error);
  }
  const batchSize = readInteger(
    env,
    "WEBHOOKY_RELAY_BATCH_SIZE",
    DEFAULT_CONFIG.relayBatchSize,
    1,
  );
  if (batchSize.ok === false) {
    return err(batchSize.error);
  }
  const maxBackoff = readInteger(
    env,
    "WEBHOOKY_RELAY_MAX_BACKOFF_SECONDS",
    DEFAULT_CONFIG.relayMaxBackoffSeconds,
    1,
  );
  if (maxBackoff.ok === false) {
    return err(maxBackoff.error);
  }
  const lease = readInteger(
    env,
    "WEBHOOKY_RELAY_LEASE_SECONDS",
    DEFAULT_CONFIG.relayLeaseSeconds,
    1,
  );
  if (lease.ok === false) {
    return err(lease.error);
  }
  const park = readInteger(
    env,
    "WEBHOOKY_RELAY_PARK_SECONDS",
    DEFAULT_CONFIG.relayParkSeconds,
    1,
  );
  if (park.ok === false) {
    return err(park.error);
  }
  const maxAttempts = readInteger(
    env,
    "WEBHOOKY_RELAY_MAX_ATTEMPTS",
    DEFAULT_CONFIG.relayMaxAttempts,
    1,
  );
  if (maxAttempts.ok === false) {
    return err(maxAttempts.error);
  }
  const backoff = readInteger(
    env,
    "WEBHOOKY_RELAY_BACKOFF_SECONDS",
    DEFAULT_CONFIG.relayBackoffSeconds,
    1,
  );
  if (backoff.ok === false) {
    return err(backoff.error);
  }
  const timeout = readInteger(
    env,
    "WEBHOOKY_RELAY_TIMEOUT_SECONDS",
    DEFAULT_CONFIG.relayTimeoutSeconds,
    1,
  );
  if (timeout.ok === false) {
    return err(timeout.error);
  }
  // The lease hides a claimed delivery from other workers. A timeout that
  // reaches it would let a second worker claim a delivery whose request is
  // still open, so the same webhook is sent twice for no reason.
  if (timeout.value >= lease.value) {
    return err(
      errors.badRequest(
        `WEBHOOKY_RELAY_TIMEOUT_SECONDS (${timeout.value}) must be below ` +
          `WEBHOOKY_RELAY_LEASE_SECONDS (${lease.value})`,
      ),
    );
  }

  return ok({
    pollIntervalSeconds: pollInterval.value,
    batchSize: batchSize.value,
    maxBackoffSeconds: maxBackoff.value,
    leaseSeconds: lease.value,
    parkSeconds: park.value,
    defaultMaxAttempts: maxAttempts.value,
    defaultBackoffSeconds: backoff.value,
    defaultTimeoutSeconds: timeout.value,
  });
}

/** Loads and validates the application configuration. */
export function loadConfig(
  env: EnvSource,
  argv: readonly string[] = [],
): Result<AppConfig, AppError> {
  const overrides = parseArgv(argv);
  if (overrides.ok === false) {
    return err(overrides.error);
  }
  const merged: EnvSource = { ...env, ...overrides.value };

  const port = readInteger(merged, "WEBHOOKY_PORT", DEFAULT_CONFIG.port, 0);
  if (port.ok === false) {
    return err(port.error);
  }
  const retention = readInteger(
    merged,
    "WEBHOOKY_RETENTION_SECONDS",
    DEFAULT_CONFIG.retentionSeconds,
    0,
  );
  if (retention.ok === false) {
    return err(retention.error);
  }
  const sweepInterval = readInteger(
    merged,
    "WEBHOOKY_RETENTION_SWEEP_INTERVAL_SECONDS",
    DEFAULT_CONFIG.retentionSweepIntervalSeconds,
    0,
  );
  if (sweepInterval.ok === false) {
    return err(sweepInterval.error);
  }
  const maxBodyBytes = readInteger(
    merged,
    "WEBHOOKY_MAX_BODY_BYTES",
    DEFAULT_CONFIG.maxBodyBytes,
    1,
  );
  if (maxBodyBytes.ok === false) {
    return err(maxBodyBytes.error);
  }
  const defaultFetchLimit = readInteger(
    merged,
    "WEBHOOKY_DEFAULT_FETCH_LIMIT",
    DEFAULT_CONFIG.defaultFetchLimit,
    1,
  );
  if (defaultFetchLimit.ok === false) {
    return err(defaultFetchLimit.error);
  }
  const maxFetchLimit = readInteger(
    merged,
    "WEBHOOKY_MAX_FETCH_LIMIT",
    DEFAULT_CONFIG.maxFetchLimit,
    1,
  );
  if (maxFetchLimit.ok === false) {
    return err(maxFetchLimit.error);
  }
  if (defaultFetchLimit.value > maxFetchLimit.value) {
    return err(
      errors.badRequest(
        "WEBHOOKY_DEFAULT_FETCH_LIMIT must not exceed WEBHOOKY_MAX_FETCH_LIMIT",
      ),
    );
  }
  const cacheTtlSeconds = readInteger(
    merged,
    "WEBHOOKY_CACHE_TTL_SECONDS",
    DEFAULT_CONFIG.cacheTtlSeconds,
    0,
  );
  if (cacheTtlSeconds.ok === false) {
    return err(cacheTtlSeconds.error);
  }
  const wsMaxBufferedBytes = readInteger(
    merged,
    "WEBHOOKY_WS_MAX_BUFFERED_BYTES",
    DEFAULT_CONFIG.wsMaxBufferedBytes,
    1,
  );
  if (wsMaxBufferedBytes.ok === false) {
    return err(wsMaxBufferedBytes.error);
  }

  const relay = loadRelayConfig(merged);
  if (relay.ok === false) {
    return err(relay.error);
  }

  const adminAuthRaw = readString(
    merged,
    "WEBHOOKY_ADMIN_AUTH",
    AdminAuthMode.TrustedHeader,
  );
  const adminAuthMode = parseAdminAuthMode(adminAuthRaw);
  if (adminAuthMode === null) {
    return err(
      errors.badRequest(
        `WEBHOOKY_ADMIN_AUTH must be one of trusted-header, dev, disabled (got "${adminAuthRaw}")`,
      ),
    );
  }

  const host = readString(merged, "WEBHOOKY_HOST", DEFAULT_CONFIG.host);
  // Dev mode hands full administrator rights to every request that reaches
  // `/_admin`, so a non-loopback bind is an open door rather than a
  // misconfiguration worth warning about.
  if (
    adminAuthMode === AdminAuthMode.Dev &&
    LOOPBACK_HOSTS.has(host) === false
  ) {
    return err(
      errors.badRequest(
        `WEBHOOKY_ADMIN_AUTH=dev accepts every admin request without authentication ` +
          `and must not be bound to ${host}: bind to loopback, or use ` +
          "WEBHOOKY_ADMIN_AUTH=trusted-header or disabled.",
      ),
    );
  }

  const bootstrapKey = merged["WEBHOOKY_ADMIN_BOOTSTRAP_KEY"];
  if (
    bootstrapKey !== undefined &&
    bootstrapKey.length > 0 &&
    bootstrapKey.includes(":") === false
  ) {
    return err(
      errors.badRequest(
        "WEBHOOKY_ADMIN_BOOTSTRAP_KEY must use the form <keyId>:<secret>",
      ),
    );
  }

  const sharedSecret = merged["WEBHOOKY_ADMIN_AUTH_SHARED_SECRET"];

  return ok({
    host,
    port: port.value,
    dbPath: readString(merged, "WEBHOOKY_DB_PATH", DEFAULT_CONFIG.dbPath),
    retentionSeconds: retention.value,
    retentionSweepIntervalSeconds: sweepInterval.value,
    addonsDir: readString(
      merged,
      "WEBHOOKY_ADDONS_DIR",
      DEFAULT_CONFIG.addonsDir,
    ),
    adminUiDir: readString(
      merged,
      "WEBHOOKY_ADMIN_UI_DIR",
      DEFAULT_CONFIG.adminUiDir,
    ),
    adminSubjects: parseSubjects(merged["WEBHOOKY_ADMIN_SUBJECTS"]),
    adminAuthMode,
    adminAuthHeader: readString(
      merged,
      "WEBHOOKY_ADMIN_AUTH_HEADER",
      DEFAULT_CONFIG.adminAuthHeader,
    ).toLowerCase(),
    adminAuthSharedSecret:
      sharedSecret === undefined || sharedSecret.length === 0
        ? null
        : sharedSecret,
    adminAuthSharedSecretHeader: readString(
      merged,
      "WEBHOOKY_ADMIN_AUTH_SHARED_SECRET_HEADER",
      DEFAULT_CONFIG.adminAuthSharedSecretHeader,
    ).toLowerCase(),
    adminDevSubject: readString(
      merged,
      "WEBHOOKY_ADMIN_DEV_SUBJECT",
      DEFAULT_CONFIG.adminDevSubject,
    ),
    adminAllowedOrigins: parseOrigins(merged["WEBHOOKY_ADMIN_ALLOWED_ORIGINS"]),
    bootstrapAdminKey:
      bootstrapKey === undefined || bootstrapKey.length === 0
        ? null
        : bootstrapKey,
    maxBodyBytes: maxBodyBytes.value,
    defaultFetchLimit: defaultFetchLimit.value,
    maxFetchLimit: maxFetchLimit.value,
    cacheTtlSeconds: cacheTtlSeconds.value,
    wsMaxBufferedBytes: wsMaxBufferedBytes.value,
    relay: relay.value,
  });
}

function parseCsv(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseSubjects(raw: string | undefined): readonly string[] {
  return parseCsv(raw);
}

/** Normalises configured origins so comparison is case and slash insensitive. */
function parseOrigins(raw: string | undefined): readonly string[] {
  return parseCsv(raw).map((entry) => entry.toLowerCase().replace(/\/+$/, ""));
}

/**
 * Configuration warnings worth printing at startup.
 *
 * `trusted-header` believes the identity header whoever sends it, so it is only
 * safe behind an IdP proxy. Binding beyond loopback without a proxy shared
 * secret exposes the whole admin API to anyone who can reach the port, which is
 * easy to do by accident and silent when it happens.
 *
 * `dev` authenticates nobody at all, so it is always reported: a server left in
 * that mode by accident is indistinguishable from a working one until someone
 * else opens the admin UI.
 */
export function configWarnings(config: AppConfig): readonly string[] {
  const warnings: string[] = [];
  if (config.adminAuthMode === AdminAuthMode.Dev) {
    warnings.push(
      `admin auth is "dev": every request to /_admin is granted full administrator ` +
        `rights as "${config.adminDevSubject}" with no credential of any kind. ` +
        "Use WEBHOOKY_ADMIN_AUTH=trusted-header or disabled outside local development.",
    );
  }
  if (
    config.adminAuthMode === AdminAuthMode.TrustedHeader &&
    config.adminAuthSharedSecret === null &&
    LOOPBACK_HOSTS.has(config.host) === false
  ) {
    warnings.push(
      `admin auth is "trusted-header" with no shared secret while bound to ${config.host}: ` +
        `anyone who can reach this port can forge "${config.adminAuthHeader}" and gain full admin access. ` +
        "Serve only through the IdP proxy and set WEBHOOKY_ADMIN_AUTH_SHARED_SECRET, or use WEBHOOKY_ADMIN_AUTH=disabled.",
    );
  }
  return warnings;
}

/** Usage text printed by `--help`. */
export const USAGE = `web-hooky - self-hostable webhook destination server

Usage: bun run src/main.ts [flags]

Flags:
  --host <host>                  Bind address (default ${DEFAULT_CONFIG.host})
  --port <port>                  Bind port (default ${DEFAULT_CONFIG.port})
  --db <path>                    SQLite path or :memory: (default ${DEFAULT_CONFIG.dbPath})
  --retention <seconds>          Record TTL, 0 disables (default ${DEFAULT_CONFIG.retentionSeconds})
  --sweep-interval <seconds>     Retention sweep period (default ${DEFAULT_CONFIG.retentionSweepIntervalSeconds})
  --addons-dir <path>            Installed addon root (default ${DEFAULT_CONFIG.addonsDir})
  --admin-ui-dir <path>          Built admin UI assets (default ${DEFAULT_CONFIG.adminUiDir})
  --admin-subjects <csv>         Seed admin identities
  --admin-auth <mode>            trusted-header | dev | disabled
  --admin-auth-header <name>     Identity header injected by the IdP proxy
  --admin-auth-shared-secret <value>  Proxy shared secret; set when the origin is directly reachable
  --admin-auth-shared-secret-header <name>  Header carrying the proxy shared secret
  --admin-dev-subject <subject>  Identity used by the dev provider
  --admin-allowed-origins <csv>  Extra origins allowed for IdP-authenticated admin writes
  --bootstrap-admin-key <id:secret>  Seed an admin API key
  --max-body-bytes <n>           Inbound body cap (default ${DEFAULT_CONFIG.maxBodyBytes})
  --default-limit <n>            _get default limit (default ${DEFAULT_CONFIG.defaultFetchLimit})
  --max-limit <n>                _get limit ceiling (default ${DEFAULT_CONFIG.maxFetchLimit})
  --cache-ttl <seconds>          Hot lookup cache TTL (default ${DEFAULT_CONFIG.cacheTtlSeconds})
  --ws-max-buffered-bytes <n>    Per-subscriber WebSocket buffer cap (default ${DEFAULT_CONFIG.wsMaxBufferedBytes})
  --relay-interval <seconds>     Relay worker poll period, 0 disables (default ${DEFAULT_CONFIG.relayPollIntervalSeconds})
  --relay-batch <n>              Deliveries claimed per poll (default ${DEFAULT_CONFIG.relayBatchSize})
  --relay-max-backoff <seconds>  Retry backoff ceiling (default ${DEFAULT_CONFIG.relayMaxBackoffSeconds})
  --relay-lease <seconds>        Claim lease, must exceed relay timeouts (default ${DEFAULT_CONFIG.relayLeaseSeconds})
  --relay-park <seconds>         Recheck period for a disabled relay (default ${DEFAULT_CONFIG.relayParkSeconds})
  --relay-max-attempts <n>       Default attempts per relay (default ${DEFAULT_CONFIG.relayMaxAttempts})
  --relay-backoff <seconds>      Default relay backoff base (default ${DEFAULT_CONFIG.relayBackoffSeconds})
  --relay-timeout <seconds>      Default relay request timeout (default ${DEFAULT_CONFIG.relayTimeoutSeconds})
  --help                         Show this message

Every flag has an environment variable equivalent; see design-docs/specs/command.md.
`;
