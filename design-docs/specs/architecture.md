# Architecture Design

This document describes system architecture and design decisions for **web-hooky**, a
self-hostable webhook destination server.

## Overview

web-hooky receives webhooks from third-party vendors (Wrike, GitHub, Slack, ...),
authenticates and transforms them through an addon pipeline, persists the result, and
exposes the stored records to authorized consumers over HTTP GET and WebSocket.

```
   vendor                web-hooky                             consumer
  +--------+      +---------------------------+              +-----------+
  | Wrike  | ---> | POST /{addon}/{inbound}   |              |  polling  |
  +--------+      |   vendor addon auth       |              |  client   |
                  |   vendor addon transform  |  GET /_get/{fetch_uuid}  |
                  |   destination addon       | <----------- |           |
                  |   persist record          |              +-----------+
                  |   broadcast to WS         |  WS  /_ws/{fetch_uuid}   |
                  +---------------------------+ -----------> | streaming |
                              |                              |  client   |
                    persistence + cache adapters             +-----------+
```

Runtime: **Bun** locally. All non-trivial platform coupling is isolated behind adapters
(`SqlDriver`, `PersistenceAdapter`, `CacheAdapter`, `AdminAuthProvider`) so the core can be
hosted on Cloudflare Workers (D1), Vercel, GCP, or AWS later.

---

## Sections

### 1. Request Lifecycle

Inbound webhook (`POST /{addon_name}/{inbound_uuid}`):

1. **Route resolution** - `addon_name` selects the vendor addon; `inbound_uuid` selects the
   destination. A mismatch between the destination's configured vendor addon and the URL
   addon name is a `404`, so inbound UUIDs cannot be probed across addons.
2. **Vendor addon authentication** - e.g. Wrike HMAC-SHA256 over the raw body. Failure ends
   the request with `401` and nothing is persisted.
3. **Vendor addon input validation** - the parsed JSON body is validated against the addon's
   `acceptsSchema` (JSON Schema).
4. **Vendor addon transform** - output validated against the addon's `returnsSchema`.
5. **Destination-level addon** (optional) - authentication, `acceptsSchema` validation,
   transform, `returnsSchema` validation, applied to the vendor addon's output. This is the
   fixed ordering required by the specification: vendor first, destination second.
6. **Persist** - a record `{ t, fetched: false, payload }` is written.
7. **Broadcast** - the record is pushed to WebSocket subscribers of that destination.
8. **Relay enqueue** - one durable delivery job is queued per enabled relay of the
   destination. The record is already durable at this point, so a queueing failure is logged
   and the vendor still receives `202`: a `5xx` would only produce a duplicate retry.
9. **Retention** - a background sweeper deletes records older than the retention window, and
   with them the payload copies held by finished relay deliveries.

A destination can be disabled. Disabling stops *every* public surface: the inbound route, the
fetch API and the WebSocket stream all answer `403`. Stored records remain readable by
administrators through `GET /_admin/api/records/{destinationId}`, which never marks records
fetched.

Failure at any step short-circuits with a structured error body
`{ "error": { "kind": ..., "message": ... } }`.

### 2. Addon System

An addon adapts one webhook source (vendor-level) or one destination's post-processing
(destination-level).

Manifest (`addon.json`):

```jsonc
{
  "name": "wrike",              // unique server-wide, [a-z0-9][a-z0-9-]*
  "version": "1.0.0",
  "kind": "vendor",             // vendor | destination | both
  "entry": "addon.js",          // module relative to package root (installed addons)
  "acceptsSchema": { "type": "object" },
  "returnsSchema": { "type": "object" },
  "configSchema": { "type": "object" }  // optional, validates destination config
}
```

Module contract (both hooks optional):

```typescript
interface AddonModule {
  authenticate?(ctx: AddonRequestContext): Promise<AddonAuthResult> | AddonAuthResult;
  transform?(input: JsonValue, ctx: AddonTransformContext): Promise<JsonValue> | JsonValue;
}
```

`AddonRequestContext` exposes lower-cased headers, the raw body string, the destination id
and the destination-supplied `config` object. Addons never touch the database or the network
stack directly.

`AddonAuthResult` has three shapes:

```typescript
type AddonAuthResult =
  | { ok: true }                                        // continue the pipeline
  | { ok: false; status: number; message: string }      // reject the request
  | { ok: true; respondWith: AddonResponse };           // answer the request here
```

`respondWith` exists because some vendors require a handshake before they will register a
webhook, and the answer has to carry vendor-specific headers. A request answered this way is
never parsed, validated, transformed, persisted, broadcast or relayed; the server only checks
that the status is in the 200-599 range and that the headers are usable. Either stage may use
it, so a destination-level addon can also short-circuit.

**Packaging**: a zip archive with `addon.json` at the archive root plus the entry module.
Install is admin-only: the archive is validated (entry names may not escape the package root,
per-file and total size limits apply), unpacked into the configured addons directory, and
recorded in the persistence layer. Because installed addons are dynamically imported into
the server process, addon code is fully trusted; the trust model is *only server
administrators may upload addons*. Serverless targets that forbid dynamic module loading must
ship addons in the deployment bundle instead - see `notes.md`.

Built-in addons: `wrike` (HMAC of the raw body via `X-Hook-Signature`), `github` (HMAC via
`X-Hub-Signature-256`, hex), `passthrough` (no auth, identity transform, usable as vendor or
destination addon) and `envelope` (destination-level addon that wraps the payload with
receipt metadata).

**Wrike specifics.** Wrike sends `hmacSha256(key: secret, value: request body)` in
`X-Hook-Signature` on every delivery; `X-Hook-Secret` is a random string used only by the
secure-webhook registration handshake. Wrike's documentation does not state the encoding of
the signature, so the addon accepts the hex and the base64 rendering of the same HMAC, each
compared in constant time. The handshake (`{"requestType":"WebHook secret verification"}`) is
answered through `respondWith`: after the signature is verified, the reply carries
`X-Hook-Secret: hmacSha256(secret, received X-Hook-Secret)` in the encoding the incoming
signature used.

The challenge is validated before it is signed: at most 100 characters, and only
`[A-Za-z0-9._-]`, matching the random alphanumeric value Wrike actually sends. Anything else
is rejected with 400 without computing an HMAC. The guard is load-bearing, not cosmetic: the
handshake body is a fixed constant, so its signature is a constant that never rotates and must
be assumed observable (proxy logs, a captured `curl`, a former integrator). An unconstrained
echo would therefore let anyone submit a forged event body as the challenge and read back a
valid `X-Hook-Signature` for it, defeating delivery authentication entirely.

**Addon-authoring rule.** The hazard generalises: any addon that uses `respondWith` to echo
attacker-controlled input under the destination secret is a signing oracle unless the echoed
value is constrained to a shape that can never collide with a message the same secret
authenticates. Constrain the input at the addon boundary - length and character allowlist -
before signing it.

### 3. Data Model

| Entity | Purpose | Key fields |
|--------|---------|-----------|
| `destinations` | one webhook endpoint | `id`, `inbound_uuid`, `fetch_uuid`, `vendor_addon`, `destination_addon`, configs, `retention_seconds` |
| `records` | received payloads | `id`, `destination_id`, `t`, `fetched`, `payload` |
| `api_users` | fetch API key/secret | `id` (key id), `label`, `secret_hash`, `enabled` |
| `api_user_grants` | authorization | (`api_user_id`, `destination_id`) |
| `admin_keys` | admin-privileged API keys | `id`, `secret_hash`, `enabled` |
| `admin_users` | IdP subjects allowed into `/_admin/` | `subject`, `role` |
| `installed_addons` | uploaded addon packages | `name`, `version`, `kind`, `entry_path`, `manifest` |
| `relays` | forwarding targets | `id`, `destination_id`, `target_url`, `secret`, `enabled`, `max_attempts`, `backoff_seconds`, `timeout_seconds` |
| `relay_deliveries` | queued deliveries | `id`, `relay_id`, `record_id`, `payload`, `status`, `attempts`, `next_attempt_at`, `last_status_code`, `last_error` |

**Two UUIDs per destination.** The *inbound* UUID appears in the URL handed to the vendor and
is therefore semi-public. The *fetch* UUID is used by `/_get/` and `/_ws/` and is returned
only by the admin API, satisfying the requirement that the fetch UUID is never disclosed to
anyone but the destination administrator.

### 4. Storage Adapters

```typescript
interface SqlDriver {
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | null>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

`PersistenceAdapter` groups the per-entity stores and is implemented once on top of
`SqlDriver` using SQLite-compatible SQL only (no vendor extensions). The local driver is
`bun:sqlite`; Turso/libSQL and Cloudflare D1 need only a new `SqlDriver`.

**Transaction isolation is a driver obligation.** `SqlDriver.transaction(fn)` guarantees that
no other statement issued through the driver runs between its start and its commit or
rollback - including statements issued while `fn` is awaiting. The `bun:sqlite` driver
achieves this by routing *every* call (`run`, `all`, `get` and `transaction`) through one FIFO
promise queue on the shared connection. Serializing only transactions is not sufficient: an
`await` inside a callback yields the thread, and anything that ran in that gap would execute
between BEGIN and COMMIT, which would let two `only_unfetched` readers claim the same record
and would let an unrelated rollback discard an already acknowledged write. The corollary for
callers is that a transaction callback must issue every statement through the `tx` handle it
receives; reaching for the outer driver deadlocks.

`CacheAdapter` is a small key/value TTL interface used for hot lookups (destination by UUID,
API user by key id). The default implementation is in-process memory; invalidation is
explicit on every admin write.

**Retention**: `COALESCE(destination.retention_seconds, config.retentionSeconds)` defines the
cutoff; a window of zero or less disables deletion for that destination. A sweeper runs on a
configurable interval and can also be triggered directly, which the tests use.

One sweep covers both tables that hold a payload:

| Table | Swept | Rule |
|-------|-------|------|
| `records` | every row past the cutoff | `t < now - retention` |
| `relay_deliveries` | `delivered` and `failed` rows past the cutoff | same cutoff, using the delivery's `t` |

`pending` deliveries are never swept, however old they are: a queued or parked job still owes
someone a webhook, and dropping it would lose data rather than expire it. They leave the queue
by being delivered or by exhausting `max_attempts`, after which the next sweep removes them.
Deleting a relay or a destination still cascades its deliveries immediately.

### 5. Fetch API

`GET /_get/{fetch_uuid}`

| Parameter | Meaning |
|-----------|---------|
| `only_unfetched` | `true`/`1` returns only records with `fetched = 0` |
| `from` / `to` | receipt-datetime range; unix seconds or ISO-8601, inclusive |
| `limit` | max records (default 100, capped by config) |
| `mark_fetched` | default `true`; set `false` to peek without marking |

Records are returned in **descending `t`** order, shaped `{ t, fetched, payload }`. The
`fetched` value in the response is the value *before* this request marked them, so a client
can tell which records it is seeing for the first time. Query and mark run in a single
transaction, so two concurrent readers cannot both receive the same record as unfetched.

`GET /_ws/{fetch_uuid}` (WebSocket) streams `{ "type": "record", "record": { t, fetched,
payload } }` frames for every newly received webhook. WS-delivered records are *not* marked
fetched: streaming is a notification channel, `_get` remains the authoritative cursor.

**Consumer authentication**: `Authorization: Bearer <key_id>:<secret>` or the
`X-Api-Key`/`X-Api-Secret` header pair. Browsers cannot set headers on a WebSocket handshake,
so `/_ws/` *additionally* accepts `?api_key=&api_secret=`; `/_get/` deliberately does not, to
keep secrets out of URLs. Secrets are 256-bit random values stored as SHA-256 hashes and
compared in constant time. Authorization is an explicit grant of (api user -> destination).

Both surfaces answer `403` for a disabled destination, matching the inbound route.

### 6. Relay (Forwarding)

A destination can have any number of *relays*: HTTP targets that every accepted record is
forwarded to. This is the store-and-forward half of the feature set found in `adnanh/webhook`
and `frain-dev/convoy`.

Delivery is queued, never inline:

1. On receipt, one `relay_deliveries` row is written per enabled relay. The payload is
   **snapshotted** into the row, so retention deletion of the source record cannot strand an
   undelivered job.
2. The worker claims a batch of due jobs inside one transaction, incrementing `attempts` and
   pushing `next_attempt_at` past a lease window (`WEBHOOKY_RELAY_LEASE_SECONDS`, which must
   exceed the largest relay timeout), so overlapping workers cannot claim the same job twice.
   A worker that dies mid-attempt simply makes the job due again when the lease expires.
3. Each claimed job is POSTed to the relay's `target_url`.
4. Success (`2xx`) marks the delivery `delivered`. Any other outcome either reschedules it
   with exponential backoff (`backoff_seconds * 2^(attempt-1)`, capped by
   `WEBHOOKY_RELAY_MAX_BACKOFF_SECONDS`) or, once `max_attempts` is reached, marks it
   `failed`. Failed deliveries can be requeued from the admin surface.

Deliveries queued for a relay that is subsequently disabled are *parked* rather than dropped:
they are rescheduled `WEBHOOKY_RELAY_PARK_SECONDS` ahead and the attempt consumed by the claim
is returned, so however long the relay stays disabled, enabling it resumes each delivery with
its full attempt budget.

Outbound request:

```
POST {target_url}
content-type: application/json
x-webhooky-delivery: {delivery id}
x-webhooky-destination: {destination id}
x-webhooky-attempt: {1-based attempt}
x-webhooky-timestamp: {unix seconds}
x-webhooky-signature: sha256={hex hmac of "{timestamp}.{body}"}   // when a secret is set

{ "id", "destinationId", "recordId", "t", "attempt", "payload" }
```

The timestamp is inside the signed material so a receiver can reject replays by age. The
relay signing secret is write-only over the admin API: responses report `hasSecret` only.

**Delivery is at-least-once.** The outcome of an attempt is written after the POST returns, so
a worker that dies in between re-delivers once the lease expires. Receivers must therefore
deduplicate on `x-webhooky-delivery`, which is stable across attempts of the same delivery.
The window is kept as small as possible: `stop()` on the worker is followed by `drain()`, and
`WebhookyRuntime.shutdown()` awaits it before closing storage, so an orderly restart does not
duplicate.

`WEBHOOKY_RELAY_LEASE_SECONDS` must exceed every relay's `timeout_seconds`, otherwise a second
worker claims a delivery whose request is still open. This is enforced, not merely documented:
configuration is rejected at startup when the default timeout reaches the lease, and the admin
API rejects a per-relay `timeoutSeconds` that does.

The worker interval is a convenience for long-running processes. Serverless deployments call
`WebhookyRuntime.runRelayDeliveries()` from a scheduled trigger, exactly like the retention
sweeper.

### 7. Admin Surface

`/_admin/` serves the SolidJS single-page admin UI; `/_admin/api/*` is the programmatic
surface with complete parity. Every UI action is one admin API call.

Authentication is *never* implemented in-process. Two credential paths:

1. **Admin API key** - `Authorization: Bearer <key_id>:<secret>`, intended for automation.
2. **External IdP** via `AdminAuthProvider`:
   - `trusted-header` - reads an identity header injected by a proxy (Cloudflare Access,
     Vercel, GCP IAP). An optional shared-secret header prevents header spoofing when the
     origin is reachable directly.
   - `dev` - local development only, identity taken from configuration.

The resolved subject must exist in `admin_users`, which is seeded from startup parameters
(`WEBHOOKY_ADMIN_SUBJECTS`). A bootstrap admin API key can be supplied at startup so a fresh
deployment can be driven entirely through the API.

Admin API endpoints:

```
GET    /_admin/api/me
GET    /_admin/api/destinations           POST   /_admin/api/destinations
GET    /_admin/api/destinations/:id       PATCH  /_admin/api/destinations/:id
DELETE /_admin/api/destinations/:id
POST   /_admin/api/destinations/:id/rotate-fetch-uuid
GET    /_admin/api/records/:destinationId (admin inspection, never marks fetched)
GET    /_admin/api/relays[?destinationId=] POST   /_admin/api/relays
GET    /_admin/api/relays/:id             PATCH  /_admin/api/relays/:id
DELETE /_admin/api/relays/:id
GET    /_admin/api/relays/:id/deliveries  POST   /_admin/api/relays/:id/retry
GET    /_admin/api/users                  POST   /_admin/api/users
DELETE /_admin/api/users/:id              POST   /_admin/api/users/:id/rotate
PUT    /_admin/api/users/:id/grants/:destinationId
DELETE /_admin/api/users/:id/grants/:destinationId
GET    /_admin/api/addons                 POST   /_admin/api/addons        (zip upload)
DELETE /_admin/api/addons/:name
GET    /_admin/api/admin-keys             POST   /_admin/api/admin-keys
DELETE /_admin/api/admin-keys/:id
GET    /_admin/api/admin-users            POST   /_admin/api/admin-users
DELETE /_admin/api/admin-users/:subject
```

Secrets are returned exactly once, at creation or rotation time.

### 8. Module Layout

```
src/
  core/         result, json, errors, ids/crypto, time
  schema/       JSON Schema (draft-07 subset) validator, no eval - Workers safe
  storage/      adapter interfaces, sql driver, sqlite stores, memory cache, retention
  addons/       manifest, registry, package (zip) install, loader, builtin addons
  pipeline/     inbound processing (vendor -> destination ordering)
  relay/        outbound forwarding: queueing, signed dispatch, retry worker
  server/       router, responses, webhook/fetch/ws handlers, static UI serving
  admin/        auth providers, admin API handlers
  admin-ui/     SolidJS SPA sources plus its Babel/Bun build plugin
  test-support/ harness used by the integration tests
  types/        ambient declarations for untyped dependencies
  config.ts     configuration loading
  runtime.ts    dependency wiring, seeding, sweeper lifecycle
  main.ts       CLI entry point
scripts/
  build-admin-ui.ts   writes the admin UI bundle into dist/admin-ui
```

Every source file stays below the 1000-line Biome limit.

### 9. Security Notes

- Vendor signature verification happens before any parsing or persistence.
- Constant-time comparison for every secret and signature check.
- Request bodies are capped (`WEBHOOKY_MAX_BODY_BYTES`, default 1 MiB).
- Fetch UUIDs are only ever returned from admin-authenticated endpoints.
- Addon uploads are admin-only and path-traversal checked. An upload whose name collides with
  an existing addon is rejected *before* anything is written, so a rejected upload can never
  destroy the installation it collided with.
- **CSRF**: an identity asserted by an IdP proxy is an ambient credential (it rides on a
  cookie the browser sends automatically), so state-changing `/_admin/api` requests
  authenticated that way are guarded. A present `Origin` header must match this deployment's
  own origin or one listed in `WEBHOOKY_ADMIN_ALLOWED_ORIGINS`; without an `Origin` header
  only `application/json` bodies are accepted, because every CORS-simple content type
  (`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`) can be sent
  cross-site without a preflight while `application/json` cannot. Admin-API-key requests are
  exempt: a browser never attaches that credential on its own.
- Error responses never echo secrets or signature material.
- Admin destination responses include `vendorConfig`, which holds the vendor webhook secret
  the administrator configured. This is intentional (the admin UI edits it) and is the reason
  the admin surface must sit behind the IdP proxy or admin API keys only.
- There is no built-in rate limiting; put the deployment behind a proxy or CDN that provides
  it.
- Relay targets are administrator-chosen, so only the URL scheme is constrained
  (`http:`/`https:`). Reaching internal addresses is therefore possible by design; treat
  admin access as equivalent to outbound request capability.

## References

See `design-docs/references/README.md` for external references.
