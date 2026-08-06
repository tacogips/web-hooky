---
name: cloudflare-deploy
description: Use when deploying web-hooky to Cloudflare Workers, creating or migrating its D1 database, managing Worker secrets, verifying a deployment, tuning rate limiting, or attaching a custom domain with WAF/bot protection. Covers wrangler workflows and the platform constraints that differ from the Bun target.
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# Cloudflare Workers Deployment Skill

Deploys web-hooky to Cloudflare Workers with D1 (SQLite-equivalent storage), a
Durable Object WebSocket hub, Workers Assets for the admin UI, and cron-driven
background work. All operations go through `wrangler` (installed as a
devDependency; run it with `bunx wrangler`).

## Architecture Facts You Must Not Violate

1. **The Workers entry is `src/platform/cloudflare/worker.ts`.** The core never
   imports platform code. `bun:sqlite` may appear only in modules the Workers
   bundle never reaches (`storage/sqlite/bun-adapter.ts`, `bun-driver.ts`,
   `runtime.ts`, `main.ts`). If `wrangler deploy` fails with
   `Could not resolve "bun:sqlite"`, a new import has broken this separation -
   fix the module graph, never alias the specifier away.
2. **D1 has no interactive transactions.** `SqlDriver.transaction()` throws on
   D1 by design. Any store operation needing read-and-claim atomicity must be a
   single statement (`UPDATE ... RETURNING`); see
   `design-docs/specs/architecture.md` section "Deployment Targets".
3. **Schema changes go through `migrations/`**, applied with
   `wrangler d1 migrations apply` - there is no startup hook on D1. Keep
   `src/storage/sqlite/schema.ts` (the Bun startup DDL) and `migrations/` in
   step: a new table or index must be added to both.
4. **Addon upload is impossible on Workers** (no writable filesystem, no
   runtime `import()`). `POST /_admin/api/addons` answers 501 there; only
   built-in addons exist. Ship new addons in the bundle.

## Prerequisites

```bash
bunx wrangler whoami   # must show an authenticated account with d1 + workers scopes
```

If not authenticated, the user must run `bunx wrangler login` themselves (it is
a browser OAuth flow). Ask them to run it via `! bunx wrangler login`.

## First-Time Setup (new account or new database)

```bash
# 1. Create the database, then write the returned database_id into wrangler.toml
bunx wrangler d1 create web-hooky

# 2. Apply the schema
bunx wrangler d1 migrations apply web-hooky --remote

# 3. Seed the bootstrap admin credential (generate keyId:secret, keep the secret safe)
bun -e 'const b=(n)=>Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");console.log(`bootstrap-${b(6)}:${b(32)}`)' \
  | bunx wrangler secret put WEBHOOKY_ADMIN_BOOTSTRAP_KEY
# Show the credential to the user exactly once; it cannot be read back.

# 4. Build the admin UI and deploy
bun run build:ui
bunx wrangler deploy
```

## Routine Deploy

```bash
bun run lint && bun test          # never deploy red
bun run build:ui                  # the Assets binding serves dist/admin-ui
bunx wrangler deploy --dry-run    # catches bundling regressions cheaply
bunx wrangler deploy
```

## Post-Deploy Verification (always do this)

```bash
B=https://web-hooky.<account>.workers.dev
curl -s $B/_health                                   # {"status":"ok",...}
curl -s -o /dev/null -w "%{http_code}" $B/_admin/    # 200 (admin UI)
# Full round trip: create a destination + user via /_admin/api with the admin
# key, POST a signed webhook to /{addon}/{inboundUuid} expecting 202, read it
# back via /_get/{fetchUuid}, then DELETE the probe destination and user.
```

A deployment is not "done" until a signed webhook round-trips. Delete any probe
data you create.

## Configuration

- Non-secret settings: `[vars]` in `wrangler.toml`. Same names and meanings as
  `design-docs/specs/command.md`.
- Secrets: `bunx wrangler secret put <NAME>` - never put secrets in
  `wrangler.toml`, it is committed.
- `WEBHOOKY_ADMIN_AUTH` must stay `disabled` on a workers.dev origin. The
  `trusted-header` mode trusts the identity header unconditionally, and a
  workers.dev origin is directly reachable, so anyone could assert a seeded
  admin subject. Only switch to `trusted-header` once the origin is exclusively
  behind an IdP proxy (Cloudflare Access) on a custom domain, and set
  `WEBHOOKY_ADMIN_AUTH_SHARED_SECRET`.

## Background Work

Workers has no in-process timers. The cron trigger in `wrangler.toml`
(`[triggers] crons`) calls `scheduled()`, which runs one relay-delivery batch
and one retention sweep per firing. If relays need lower latency, shorten the
cron; both operations are idempotent.

## Protection Posture

| Layer | Status | Notes |
|-------|--------|-------|
| DDoS (L3/4/7) | Always on | Cloudflare mitigates volumetric attacks in front of every Worker; nothing to configure. |
| Rate limiting | Enforced in the Worker | `RATE_LIMITER` binding, per client IP (`cf-connecting-ip`), checked before any routing so a flood never reaches D1. Tune `limit`/`period` under `[[ratelimits]]`. Counters are **per Cloudflare edge server**: one client on one connection hits the limit exactly, a widely parallel flood sees a higher aggregate ceiling. It is flood control, not a billing-grade quota. Limiter outages fail open by design. |
| Bot management / WAF | Requires a custom domain | Not available on workers.dev. See below before enabling. |

### Bot protection: the rule that matters

web-hooky's legitimate clients ARE bots: vendor webhook senders (GitHub, Wrike),
polling consumers on `/_get/`, WebSocket subscribers on `/_ws/`. A blanket
"block bots" configuration breaks the application.

When the deployment gets a custom domain (Workers route on a Cloudflare zone):

1. Enable Bot Fight Mode / WAF **with skip rules** for
   `/{addon}/*` (inbound webhooks), `/_get/*` and `/_ws/*`.
2. Challenge freely on `/_admin/*` - that surface is for human browsers.
3. Add WAF rate-limiting rules if a hard per-IP quota is needed; zone-level
   rules have counters the Workers binding does not.
4. Put Cloudflare Access in front of `/_admin/*`, then switch
   `WEBHOOKY_ADMIN_AUTH` to `trusted-header` with the shared secret set.

The programmatic surfaces are protected by HMAC signature verification (before
any parsing or persistence), high-entropy API credentials compared in constant
time, and the rate limiter - not by browser challenges.

## Troubleshooting

- `Could not resolve "bun:sqlite"`: platform separation broken; see fact 1.
- `/_admin/` serves 404: the UI bundle was not built (`bun run build:ui`) or
  the asset rewrite in `worker.ts` (`adminAssetRequest`) was changed. The
  bundle is flat; the UI root must map to `/`, not `/index.html` (Wrangler
  redirects the latter).
- `D1 does not support interactive transactions` in logs: some code called
  `SqlDriver.transaction()` on the D1 driver. Rewrite the operation as a
  single atomic statement; do not catch and retry.
- Behaviour differs between local and deployed: remember the Worker memoises
  its runtime per isolate; config changes need a redeploy, not just a secret
  update, to propagate promptly.
- Inspect production logs: `bunx wrangler tail` (add `--format json` for
  machine reading).
- Query production data: `bunx wrangler d1 execute web-hooky --remote --command "SELECT ..."`.

## Current Deployment

- URL: https://web-hooky.tacotest.workers.dev
- D1: `web-hooky` (id `95ff9d87-840a-4ee6-934f-ca67f2ac13ca`, region APAC)
- Admin auth: API key only (`WEBHOOKY_ADMIN_AUTH=disabled`); bootstrap key id
  `bootstrap-5daFDCMQ`, secret stored in `WEBHOOKY_ADMIN_BOOTSTRAP_KEY`.
