# web-hooky

A self-hostable webhook destination server. It receives webhooks from third-party vendors,
authenticates and transforms them through an addon pipeline, persists the result, and serves
the stored records to authorized consumers over HTTP and WebSocket.

- **Vendor addons** perform per-request authentication (Wrike `X-Hook-Signature` HMAC, GitHub
  `X-Hub-Signature-256` HMAC, ...) and declare the data they accept and return as JSON Schema.
- **Destination addons** run after the vendor addon, so each destination can apply its own
  validation and transform.
- **Relays** forward every accepted record to downstream HTTP targets, signed with HMAC-SHA256
  and retried with exponential backoff.
- **Storage adapters** are pluggable with SQLite-compatible semantics; the local
  implementation uses `bun:sqlite`, and a configurable retention window deletes old records
  together with the payload copies held by finished relay deliveries.
- **Admin UI** (SolidJS) at `/_admin/` (destinations, relays, fetch API users, addons, admin
  keys), with full programmatic parity under `/_admin/api`.
- **No in-process end-user auth**: admin identities come from an external IdP behind the
  `AdminAuthProvider` abstraction, or from admin API keys.

## Quick start

```bash
bun install
bun run build:ui                    # build the admin UI into dist/admin-ui
WEBHOOKY_ADMIN_BOOTSTRAP_KEY=local-admin:local-secret \
WEBHOOKY_ADMIN_AUTH=dev \
WEBHOOKY_ADMIN_SUBJECTS=dev@localhost \
  bun run start
```

The server listens on `http://127.0.0.1:8787` by default.

### Issue a destination

```bash
ADMIN='Authorization: Bearer local-admin:local-secret'

curl -sX POST http://127.0.0.1:8787/_admin/api/destinations -H "$ADMIN" \
  -H 'content-type: application/json' \
  -d '{"name":"wrike prod","vendorAddon":"wrike","destinationAddon":"envelope",
       "vendorConfig":{"secret":"wrike-webhook-secret"},
       "destinationConfig":{"label":"prod"}}'
```

The response contains two UUIDs:

- `inboundUuid` - give `/{vendorAddon}/{inboundUuid}` to the vendor.
- `fetchUuid` - used by `/_get/{fetchUuid}` and `/_ws/{fetchUuid}`. It is returned only by the
  admin API and must not be shared outside the destination's administrators.

### Register a consumer and read records

```bash
# create an API key/secret pair (the secret is shown once)
curl -sX POST http://127.0.0.1:8787/_admin/api/users -H "$ADMIN" \
  -H 'content-type: application/json' -d '{"label":"reporting"}'

# authorize it for a destination
curl -sX PUT http://127.0.0.1:8787/_admin/api/users/<keyId>/grants/<destinationId> -H "$ADMIN"

# read new records, newest first
curl -s "http://127.0.0.1:8787/_get/<fetchUuid>?only_unfetched=true&limit=50" \
  -H 'Authorization: Bearer <keyId>:<secret>'
```

Records are shaped `{ "t": <unix seconds>, "fetched": <bool>, "payload": { ... } }` and are
returned in descending `t`. `GET /_get/` marks what it returns as fetched (disable with
`mark_fetched=false`); `fetched` in the response reflects the value before marking.
`/_ws/{fetchUuid}` streams `{ "type": "record", "record": { ... } }` frames and accepts
`?api_key=&api_secret=` because browsers cannot set headers on a WebSocket handshake.

Disabling a destination (`PATCH /_admin/api/destinations/{id} {"enabled":false}`) stops every
public surface: the inbound route, `/_get/` and `/_ws/` all answer `403`. Stored records stay
readable for administrators through `GET /_admin/api/records/{destinationId}`.

## Relays (forwarding)

Attach one or more forwarding targets to a destination; each accepted record is queued and
delivered to every enabled relay, with retries.

```bash
curl -sX POST http://127.0.0.1:8787/_admin/api/relays -H "$ADMIN" \
  -H 'content-type: application/json' \
  -d '{"destinationId":"<id>","name":"downstream","targetUrl":"https://downstream.example/hook",
       "secret":"relay-signing-secret","maxAttempts":5}'

curl -s "http://127.0.0.1:8787/_admin/api/relays/<relayId>/deliveries" -H "$ADMIN"
curl -sX POST "http://127.0.0.1:8787/_admin/api/relays/<relayId>/retry" -H "$ADMIN"
```

The outbound request is `POST {targetUrl}` with a JSON body
`{ id, destinationId, recordId, t, attempt, payload }` and, when a secret is configured,
`x-webhooky-signature: sha256=<hex hmac of "{x-webhooky-timestamp}.{body}">`. Non-`2xx`
responses and transport errors are retried with exponential backoff up to `maxAttempts`, after
which the delivery is marked `failed` and can be requeued. The relay signing secret is never
returned by the API - responses report `hasSecret` only.

The worker polls every `WEBHOOKY_RELAY_POLL_INTERVAL_SECONDS` (`0` disables it; serverless
deployments call `runRelayDeliveries()` from a scheduled trigger instead).

### Delivery contract

- **Delivery is at-least-once.** The outcome is recorded after the POST returns, so a worker
  that dies in between re-sends the request once the claim lease expires. Treat
  `x-webhooky-delivery` as the idempotency key: it is stable across every attempt of the same
  delivery, while `x-webhooky-attempt` counts up.
- A `2xx` response ends the delivery; anything else is retried. Respond `2xx` as soon as the
  payload is safely stored on your side.
- `WEBHOOKY_RELAY_LEASE_SECONDS` (default `300`) must be larger than every relay's
  `timeoutSeconds`, or an attempt that is still running can be claimed a second time. The
  server refuses to start with a default timeout that reaches the lease, and the admin API
  rejects a per-relay `timeoutSeconds` that does.
- Retention prunes `delivered` and `failed` deliveries with their payload copy on the same
  schedule as records. `pending` deliveries are kept until they finish, so nothing still
  queued is silently dropped.

## Admin authentication and CSRF

The default `WEBHOOKY_ADMIN_AUTH=trusted-header` mode **trusts the identity header
unconditionally**: any client that can reach the origin directly can set
`cf-access-authenticated-user-email` (or whatever `WEBHOOKY_ADMIN_AUTH_HEADER` names) to a
seeded admin subject and obtain full `/_admin/api` access. Only run it when the origin is
reachable *exclusively* through the IdP proxy that injects the header. When the origin can be
reached directly - any public port, any shared network - set
`WEBHOOKY_ADMIN_AUTH_SHARED_SECRET` so the proxy must also prove itself, or use
`WEBHOOKY_ADMIN_AUTH=disabled` and admin API keys only. The default bind address is
`127.0.0.1`; widening it with `WEBHOOKY_HOST` is the moment to revisit this setting.

Admin API keys are unaffected by CSRF because a browser never attaches them. Requests
authenticated by the identity-provider path are ambient, so state-changing `/_admin/api`
requests on that path must either carry an `Origin` matching this deployment (or one listed in
`WEBHOOKY_ADMIN_ALLOWED_ORIGINS`) or use `content-type: application/json`. Set
`WEBHOOKY_ADMIN_ALLOWED_ORIGINS` when the admin UI is served from a different origin than the
API.

### Issuing admin API keys

`WEBHOOKY_ADMIN_BOOTSTRAP_KEY=<id>:<secret>` seeds one key at startup so a fresh deployment is
reachable. Every further key is minted through the admin API (or the admin UI), and a key
issued this way carries the same privileges as the seeded one:

```bash
curl -sX POST http://127.0.0.1:8787/_admin/api/admin-keys -H "$ADMIN" \
  -H 'content-type: application/json' -d '{"label":"ci"}'

curl -s http://127.0.0.1:8787/_admin/api/admin-keys -H "$ADMIN"
curl -sX DELETE http://127.0.0.1:8787/_admin/api/admin-keys/<id> -H "$ADMIN"
```

The response carries `secret` and a ready-to-use `credential` (`<id>:<secret>`) exactly once;
listing a key afterwards never returns it. Send it as `Authorization: Bearer <id>:<secret>`.
Admin keys grant every `/_admin/api` capability, including reading destination `fetchUuid`
values - rotate by issuing a replacement and deleting the old key.

## Addons

Built-in:

| Addon | Kind | Authentication |
|-------|------|----------------|
| `wrike` | vendor | HMAC-SHA256 of the raw body in `X-Hook-Signature` (hex or base64), plus the secure-webhook `X-Hook-Secret` handshake |
| `github` | vendor | HMAC-SHA256 of the raw body in `X-Hub-Signature-256` (`sha256=<hex>`) |
| `passthrough` | vendor, destination | none; identity transform |
| `envelope` | destination | none; wraps the payload with receipt metadata |

Wrike does not document whether it hex- or base64-encodes `X-Hook-Signature`, so the addon
accepts either rendering (both comparisons are constant time). Registering a *secure* Wrike
webhook sends `{"requestType":"WebHook secret verification"}` with a random `X-Hook-Secret`
header; the addon verifies the signature and answers with `X-Hook-Secret` set to
`hmacSha256(secret, received X-Hook-Secret)`. Handshake requests are never stored, broadcast
or relayed.

Because that reply signs a value the caller supplies, the challenge is constrained before it
is signed: a challenge longer than 100 characters, or containing anything outside
`[A-Za-z0-9._-]`, is rejected with 400 and nothing is signed. Without this guard the endpoint
would be a signing oracle - the handshake body is a constant, so its signature never rotates,
and anyone who observed one genuine handshake could replay it with a forged event body as the
challenge and receive a valid `X-Hook-Signature` for that body in return.

An addon package is a zip archive with `addon.json` at the root:

```json
{
  "name": "acme",
  "version": "1.0.0",
  "kind": "vendor",
  "entry": "addon.js",
  "acceptsSchema": { "type": "object" },
  "returnsSchema": { "type": "object" }
}
```

`entry` exports `authenticate(ctx)` and/or `transform(input, ctx)`. `authenticate` returns
`{ ok: true }`, `{ ok: false, status, message }`, or - for vendor handshakes -
`{ ok: true, respondWith: { status, headers, body } }`, which answers the request directly
and skips parsing, transformation and persistence. Upload the package from the admin UI, or:

```bash
curl -sX POST http://127.0.0.1:8787/_admin/api/addons -H "$ADMIN" \
  -F 'package=@acme.zip;type=application/zip'
```

Uploaded addon code is imported into the server process and therefore fully trusted; only
administrators can install packages.

## Development

```bash
bun test              # unit + integration tests
bun run typecheck     # tsc --noEmit
bun run lint:biome    # biome check
bun run build         # server bundle + admin UI
task ci               # everything above
```

Configuration reference: `design-docs/specs/command.md`.
Architecture and data model: `design-docs/specs/architecture.md`.
Design decisions and portability notes: `design-docs/specs/notes.md`.
Implementation plans: `impl-plans/`.
