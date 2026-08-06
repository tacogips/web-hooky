# Deploying web-hooky to Cloudflare Workers

The Cloudflare target runs the same webhook runtime on Workers, with D1 for persistence, a
Durable Object for WebSocket subscribers, Workers Assets for the admin UI, and a scheduled
trigger for relay delivery and retention.

## Platform differences

| Capability | Bun target | Cloudflare Workers target |
|------------|------------|---------------------------|
| Persistence | Local SQLite file | Cloudflare D1 |
| WebSocket fan-out | In-process hub | Durable Object per destination |
| Background work | In-process timers | Scheduled Worker trigger |
| Admin UI | Files from `dist/admin-ui` | Workers Assets |
| Addon uploads | Supported | Not supported; addons must be bundled |

The Worker entry point is `src/platform/cloudflare/worker.ts`. Database changes must be kept
in sync between the Bun schema and `migrations/`, because D1 migrations are applied explicitly
and do not run during Worker startup.

## Prerequisites

- Bun and the repository dependencies installed with `bun install`
- A Cloudflare account with Workers, D1, and Durable Objects available
- Wrangler authenticated for that account:

```bash
bunx wrangler whoami
```

If authentication is required, run `bunx wrangler login` and complete the browser flow.

## First deployment

1. Create a D1 database:

   ```bash
   bunx wrangler d1 create web-hooky
   ```

2. Replace `database_id` under `[[d1_databases]]` in `wrangler.toml` with the ID returned by
   Cloudflare. Change `database_name` too if a different name was used.

3. Apply the schema to the remote database:

   ```bash
   bunx wrangler d1 migrations apply web-hooky --remote
   ```

4. Generate a bootstrap administrator credential and store it as a Worker secret. Save the
   generated `keyId:secret` value in a password manager because Cloudflare will not reveal it
   later.

   ```bash
   bun -e 'const b=(n)=>Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");console.log(`bootstrap-${b(6)}:${b(32)}`)'
   bunx wrangler secret put WEBHOOKY_ADMIN_BOOTSTRAP_KEY
   ```

   Paste the generated credential into Wrangler's prompt. Do not add it to `wrangler.toml` or
   any committed file.

5. Verify, build, preview the deployment bundle, and deploy:

   ```bash
   task ci
   bun run build:ui
   bunx wrangler deploy --dry-run
   bunx wrangler deploy
   ```

## Routine deployment

Apply any pending D1 migrations before deploying code that depends on them:

```bash
bunx wrangler d1 migrations apply web-hooky --remote
task ci
bun run build:ui
bunx wrangler deploy --dry-run
bunx wrangler deploy
```

Non-secret Worker settings belong in `[vars]` in `wrangler.toml`. Store secrets with
`bunx wrangler secret put <NAME>`. The setting names and meanings are documented in
`design-docs/specs/command.md`.

## Verify the deployment

Replace the example origin with the URL printed by Wrangler:

```bash
WEBHOOKY_ORIGIN=https://web-hooky.example-account.workers.dev
curl -fsS "$WEBHOOKY_ORIGIN/_health"
curl -fsS -o /dev/null -w '%{http_code}\n' "$WEBHOOKY_ORIGIN/_admin/"
```

The health endpoint should return a JSON response with `"status":"ok"`, and the admin UI
should return HTTP 200. Before treating a production deployment as complete, use the admin
API to create a temporary destination and consumer, submit a correctly signed webhook, read
it through `/_get/{fetchUuid}`, and then delete the temporary records.

## Security and operations

- Keep `WEBHOOKY_ADMIN_AUTH="disabled"` on a directly reachable `workers.dev` origin and use
  admin API keys. `trusted-header` is safe only when the origin is exclusively behind an
  identity-aware proxy; also set `WEBHOOKY_ADMIN_AUTH_SHARED_SECRET` in that configuration.
- The `RATE_LIMITER` binding in `wrangler.toml` provides per-client-IP flood control. Its
  counters are per Cloudflare edge server, so it is not a hard global quota.
- Cloudflare WAF and bot-management rules require a custom domain. Do not apply blanket bot
  challenges to webhook or consumer routes: allow `/{addon}/*`, `/_get/*`, and `/_ws/*`.
- Workers has no in-process timers. The cron in `wrangler.toml` drives relay delivery and
  retention; shorten the interval if relays need lower latency.
- Runtime addon uploads return HTTP 501 on Workers. Add new addons to the source bundle and
  redeploy.

Useful operational commands:

```bash
bunx wrangler tail
bunx wrangler d1 execute web-hooky --remote --command "SELECT COUNT(*) FROM records"
```

For architecture details and the D1 transaction constraints, see
`design-docs/specs/architecture.md`.
