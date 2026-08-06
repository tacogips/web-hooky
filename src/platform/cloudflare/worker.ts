/**
 * Cloudflare Workers entry point.
 *
 * Wires the D1 persistence adapter, the Durable Object hub proxy and the admin
 * UI assets into the platform-agnostic runtime, then serves the same router the
 * Bun target serves. Nothing here is imported by the core.
 *
 * Two things differ from a long-running process and are handled explicitly
 * rather than silently:
 *
 * - `/_ws/` cannot be upgraded by a Worker isolate, so it is authorized here -
 *   with the same `lookups.ts` helpers the local router uses - and then handed
 *   to the destination's Durable Object, which owns the socket.
 * - There are no in-process timers, so the retention sweeper and the relay
 *   worker run from the cron trigger in `scheduled()` instead.
 */
import { configWarnings, loadConfig } from "../../config";
import { createRuntimeCore, type WebhookyRuntime } from "../../runtime-core";
import {
  authorizeFetchConsumer,
  findDestinationByFetchUuid,
} from "../../server/lookups";
import { publicErrorResponse } from "../../server/responses";
import { errors } from "../../core/errors";
import { createMemoryCache } from "../../storage/cache";
import { createSqlPersistenceAdapter } from "../../storage/sqlite/adapter";
import { createD1Driver, type D1DatabaseLike } from "./d1-driver";
import {
  createDurableObjectHub,
  type DurableObjectNamespaceLike,
} from "./hub-proxy";
import { STREAM_HUB_ROUTES } from "./stream-hub";

export { StreamHub } from "./stream-hub";

interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  readonly DB: D1DatabaseLike;
  readonly STREAM_HUB: DurableObjectNamespaceLike;
  readonly ASSETS: FetcherLike;
  readonly [key: string]: unknown;
}

interface ExecutionContextLike {
  waitUntil(work: Promise<unknown>): void;
}

/** Only string-valued entries are configuration; the rest are bindings. */
function environmentStrings(env: Env): Record<string, string> {
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      source[key] = value;
    }
  }
  return source;
}

/**
 * One runtime per isolate.
 *
 * Building it seeds admin access, which is a database write; doing that per
 * request would add a round trip to every webhook. The isolate is discarded
 * often enough that configuration changes still take effect promptly.
 */
let runtimePromise: Promise<WebhookyRuntime> | null = null;

async function buildRuntime(
  env: Env,
  ctx: ExecutionContextLike,
): Promise<WebhookyRuntime> {
  const config = loadConfig(environmentStrings(env));
  if (config.ok === false) {
    throw new Error(`Configuration error: ${config.error.message}`);
  }
  for (const warning of configWarnings(config.value)) {
    console.warn(`[web-hooky] warning: ${warning}`);
  }

  // The schema is applied by `wrangler d1 migrations apply`, not at startup:
  // D1 has no startup hook, and running the DDL per isolate would cost a round
  // trip for no benefit. `persistence.init()` is therefore deliberately unused.
  const persistence = createSqlPersistenceAdapter(createD1Driver(env.DB));

  const hub = createDurableObjectHub({
    namespace: env.STREAM_HUB,
    waitUntil: (work) => {
      ctx.waitUntil(work);
    },
    destinationsForApiUser: (apiUserId) =>
      persistence.apiUsers.listGrants(apiUserId),
    onError: (error) => {
      console.warn("[web-hooky] durable object call failed", error);
    },
  });

  const runtime = await createRuntimeCore(config.value, {
    persistence,
    cache: createMemoryCache(() => Date.now()),
    hub,
    // Uploaded addon packages need a writable filesystem and a runtime
    // `import()`; a Workers bundle has neither, so only the built-ins are
    // registered. `POST /_admin/api/addons` reports this rather than failing
    // obscurely.
    installedAddons: [],
    backgroundTimers: false,
  });
  if (runtime.ok === false) {
    throw new Error(`Startup failed: ${runtime.error.message}`);
  }
  return runtime.value;
}

function runtimeFor(
  env: Env,
  ctx: ExecutionContextLike,
): Promise<WebhookyRuntime> {
  runtimePromise ??= buildRuntime(env, ctx).catch((error: unknown) => {
    // A failed build must not be cached, or one bad request would poison the
    // isolate for as long as it lives.
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

/**
 * Authorizes a stream subscriber and hands the socket to the destination's
 * Durable Object.
 *
 * The checks are the same ones `server/app.ts` performs locally, in the same
 * order, so the two targets accept and reject identically.
 */
async function handleStreamUpgrade(
  runtime: WebhookyRuntime,
  env: Env,
  request: Request,
  url: URL,
  fetchUuid: string,
): Promise<Response> {
  const ctx = runtime.context;
  const destination = await findDestinationByFetchUuid(ctx, fetchUuid);
  if (destination === null) {
    return publicErrorResponse(errors.notFound("Unknown fetch endpoint"));
  }
  if (destination.enabled === false) {
    return publicErrorResponse(errors.forbidden("Destination is disabled"));
  }
  const authorized = await authorizeFetchConsumer(
    ctx,
    request,
    url,
    destination,
  );
  if (authorized.ok === false) {
    return publicErrorResponse(authorized.error);
  }

  const target = new URL(
    STREAM_HUB_ROUTES.subscribe,
    "https://stream-hub.invalid",
  );
  target.searchParams.set("apiUserId", authorized.value.id);
  const stub = env.STREAM_HUB.get(env.STREAM_HUB.idFromName(destination.id));
  return stub.fetch(new Request(target, request));
}

/** True for admin UI paths the Assets binding should answer. */
function isAdminAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_admin") &&
    pathname.startsWith("/_admin/api") === false
  );
}

/**
 * Rewrites an `/_admin/...` request onto the asset bundle's own layout.
 *
 * The bundle is uploaded flat - `index.html` and `main.js` sit at its root -
 * while the UI is mounted under `/_admin/`. Without this rewrite the Assets
 * binding looks for a literal `/_admin/` key and answers 404. `index.html`
 * loads its script as `./main.js`, so the browser then asks for
 * `/_admin/main.js`, which maps back to `/main.js` here.
 *
 * The UI root maps to `/`, not `/index.html`: Wrangler's asset router serves
 * the index document at the directory path and answers `/index.html` with a
 * redirect, which would bounce the browser to the application root instead of
 * the admin UI.
 */
function adminAssetRequest(request: Request, url: URL): Request {
  const rest = url.pathname.slice("/_admin".length);
  const assetPath = rest === "" || rest === "/" ? "/" : rest;
  const target = new URL(url);
  target.pathname = assetPath;
  return new Request(target, request);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    let runtime: WebhookyRuntime;
    try {
      runtime = await runtimeFor(env, ctx);
    } catch (error) {
      return publicErrorResponse(
        errors.internal(`Runtime unavailable: ${String(error)}`),
        error,
      );
    }

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((part) => part.length > 0);

    if (segments[0] === "_ws" && segments.length === 2) {
      return handleStreamUpgrade(runtime, env, request, url, segments[1] ?? "");
    }
    if (isAdminAsset(url.pathname)) {
      return env.ASSETS.fetch(adminAssetRequest(request, url));
    }

    // `null` means the router upgraded the request, which cannot happen here:
    // `/_ws/` is handled above and never reaches the app.
    const response = await runtime.app.fetch(request, null);
    return response ?? new Response(null, { status: 204 });
  },

  async scheduled(
    _event: unknown,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    const runtime = await runtimeFor(env, ctx);
    // Both are idempotent and independent, so a failure in one must not stop
    // the other: a stalled relay queue should not also stop retention.
    const results = await Promise.allSettled([
      runtime.runRelayDeliveries(),
      runtime.sweepRetention(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[web-hooky] scheduled task failed", result.reason);
      }
    }
  },
};
