/**
 * Test harness that boots a complete runtime against an in-memory database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { hmacSha256Hex } from "../core/ids";
import type { JsonObject, JsonValue } from "../core/json";
import type { Clock } from "../core/time";
import type { FetchLike } from "../relay/dispatch";
import { createRuntime, type WebhookyRuntime } from "../runtime";

export const TEST_ADMIN_KEY_ID = "test-admin-key";
export const TEST_ADMIN_SECRET = "test-admin-secret-value";
export const TEST_ADMIN_CREDENTIAL = `${TEST_ADMIN_KEY_ID}:${TEST_ADMIN_SECRET}`;

export interface Harness {
  readonly runtime: WebhookyRuntime;
  readonly config: AppConfig;
  readonly addonsDir: string;
  /** Issues a request against the app without going through the network. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Issues an admin-authenticated request. */
  admin(path: string, init?: RequestInit): Promise<Response>;
  adminJson<T>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

export type EnvOverrides = Readonly<Record<string, string>>;

export interface HarnessOptions {
  /** Replaces the system clock so time dependent behaviour is deterministic. */
  readonly clock?: Clock;
  /** Replaces the relay worker's outbound `fetch`. */
  readonly relayFetch?: FetchLike;
}

export async function createHarness(
  overrides: EnvOverrides = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const addonsDir = await mkdtemp(join(tmpdir(), "web-hooky-test-"));
  const config = loadConfig({
    WEBHOOKY_DB_PATH: ":memory:",
    WEBHOOKY_ADDONS_DIR: addonsDir,
    WEBHOOKY_ADMIN_UI_DIR: join(addonsDir, "ui"),
    WEBHOOKY_ADMIN_AUTH: "disabled",
    WEBHOOKY_ADMIN_BOOTSTRAP_KEY: TEST_ADMIN_CREDENTIAL,
    WEBHOOKY_RETENTION_SWEEP_INTERVAL_SECONDS: "0",
    // Background timers are disabled so tests drive the workers explicitly.
    WEBHOOKY_RELAY_POLL_INTERVAL_SECONDS: "0",
    ...overrides,
  });
  if (config.ok === false) {
    throw new Error(`Test configuration invalid: ${config.error.message}`);
  }

  const runtime = await createRuntime(config.value, {
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.relayFetch === undefined
      ? {}
      : { relayFetch: options.relayFetch }),
  });
  if (runtime.ok === false) {
    throw new Error(`Test runtime failed to start: ${runtime.error.message}`);
  }
  const started = runtime.value;

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await started.app.fetch(
      new Request(`http://test.local${path}`, init),
      null,
    );
    if (response === null) {
      throw new Error("Request was upgraded unexpectedly");
    }
    return response;
  }

  function admin(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${TEST_ADMIN_CREDENTIAL}`);
    return request(path, { ...init, headers });
  }

  return {
    runtime: started,
    config: config.value,
    addonsDir,
    request,
    admin,

    async adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await admin(path, init);
      const text = await response.text();
      if (response.ok === false) {
        throw new Error(`${path} failed with ${response.status}: ${text}`);
      }
      return JSON.parse(text) as T;
    },

    async close(): Promise<void> {
      await started.shutdown();
      await rm(addonsDir, { recursive: true, force: true });
    },
  };
}

export interface CreatedDestination {
  readonly id: string;
  readonly inboundUuid: string;
  readonly fetchUuid: string;
  readonly name: string;
}

export interface CreatedApiUser {
  readonly id: string;
  readonly credential: string;
}

/** Creates a destination through the admin API. */
export function createDestination(
  harness: Harness,
  body: JsonObject,
): Promise<CreatedDestination> {
  return harness.adminJson<CreatedDestination>("/_admin/api/destinations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Creates a fetch API user and grants it access to a destination. */
export async function createAuthorizedUser(
  harness: Harness,
  destinationId: string,
): Promise<CreatedApiUser> {
  const user = await harness.adminJson<CreatedApiUser>("/_admin/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "test-consumer" }),
  });
  const granted = await harness.admin(
    `/_admin/api/users/${user.id}/grants/${destinationId}`,
    { method: "PUT" },
  );
  if (granted.ok === false) {
    throw new Error(`Failed to grant access: ${granted.status}`);
  }
  return user;
}

/**
 * Posts a Wrike-signed webhook body to an inbound endpoint.
 *
 * Wrike carries the body HMAC in `X-Hook-Signature`; `X-Hook-Secret` is used
 * only by the registration handshake.
 */
export async function postWrikeWebhook(
  harness: Harness,
  inboundUuid: string,
  secret: string,
  payload: JsonValue,
  signatureOverride?: string,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = signatureOverride ?? (await hmacSha256Hex(secret, body));
  return harness.request(`/wrike/${inboundUuid}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hook-signature": signature,
    },
    body,
  });
}
