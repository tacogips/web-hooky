# Design Notes

This document contains research findings, investigations, and miscellaneous design notes.

## Overview

Notable items that do not fit into architecture or client categories.

---

## Sections

### Why a hand-written JSON Schema validator

Addon input/output contracts are declared as JSON Schema. The obvious dependency is `ajv`,
but ajv's default mode compiles validators with `new Function`, which is unavailable on
Cloudflare Workers (and undesirable for uploaded, admin-provided schemas). Ajv's standalone
mode needs a build step per schema, which does not fit runtime-uploaded addons.

`src/schema/validate.ts` therefore implements an interpreted draft-07 subset with no code
generation:

- `type` (single or array), `enum`, `const`
- objects: `properties`, `required`, `additionalProperties`, `patternProperties`,
  `minProperties`, `maxProperties`
- arrays: `items`, `minItems`, `maxItems`, `uniqueItems`
- strings: `minLength`, `maxLength`, `pattern`, `format` (`date-time`, `date`, `email`, `uuid`, `uri`)
- numbers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
- combinators: `allOf`, `anyOf`, `oneOf`, `not`
- boolean schemas (`true` / `false`)

**Not supported**: `$ref`, `$defs`/`definitions`, `if`/`then`/`else`, `dependentSchemas`,
remote schema resolution. A schema containing `$ref` is rejected at manifest-parse time with
a clear message rather than silently ignored.

### Bun + SolidJS build pipeline

Bun's built-in JSX transform cannot produce Solid's fine-grained reactive DOM updates. Two
routes were evaluated:

1. **Solid's hyperscript runtime** (`jsxImportSource: "solid-js/h"`), which needs no Babel.
   It was implemented first and rejected: with the automatic JSX runtime, props and children
   are evaluated eagerly, so the UI renders once and never updates when a signal changes.
   The admin UI would have shown empty tables forever after its first paint.
2. **`babel-preset-solid`** behind a Bun bundler plugin - the official transform, with real
   reactivity. This is what ships.

`src/admin-ui/build.ts` exposes `createSolidPlugin()` and `buildAdminUi()`. The plugin runs
`.tsx` sources through `@babel/preset-typescript` and `babel-preset-solid`;
`scripts/build-admin-ui.ts` (`bun run build:ui`) writes the bundle plus `index.html` into
`dist/admin-ui`. `tsconfig.json` keeps `"jsx": "react-jsx"` with
`"jsxImportSource": "solid-js"` so editor and `tsc` typing match the shipped transform.

Consequence for tests: Bun's *runtime* cannot execute `.tsx` Solid sources, so
`src/admin-ui/app.test.ts` builds the real browser bundle with the same plugin and evaluates
it against happy-dom. The artifact under test is the artifact that ships. A related trap:
`bun test` resolves `solid-js` through the `node` export condition (Solid's server renderer),
which is why the test drives the bundle rather than importing the components directly.

### Zip package format

`fflate` (dependency-free, works on every deploy target) is used to read uploaded addon
archives. Guards applied before anything is written to disk:

- archive size cap and per-entry uncompressed size cap
- entry count cap
- entry names normalised and rejected when absolute, containing `..`, or backslashes
- `addon.json` required at the archive root
- the manifest `entry` must exist in the archive

### Portability to serverless targets

| Concern | Local Bun | Cloudflare Workers / Vercel / GCP / AWS |
|---------|-----------|------------------------------------------|
| SQL | `bun:sqlite` `SqlDriver` | new `SqlDriver` over D1 / Turso / RDS Data API |
| Cache | in-memory `CacheAdapter` | KV / Redis `CacheAdapter` |
| WebSocket | `Bun.serve` websocket handlers | Durable Objects / API Gateway WS |
| Addon upload | unpack to disk + dynamic `import()` | `POST /_admin/api/addons` answers `501 not_implemented`; ship addons in the bundle |
| Retention sweeper | `setInterval` | scheduled worker / cron trigger calling `sweepExpiredRecords` |
| Relay worker | `setInterval` | scheduled worker / cron trigger calling `runRelayDeliveries` |

The core (`pipeline/`, `schema/`, `addons/` registry) uses only web-standard APIs
(`fetch`, `Request`, `Response`, `crypto.subtle`, `TextEncoder`), so it is portable as-is.
Node/Bun-specific APIs are confined to `storage/sqlite/`, `addons/package.ts`,
`addons/loader.ts`, `server/static-ui.ts` and `main.ts`.

### Relay / forwarding (reference projects)

`adnanh/webhook` executes commands on receipt, and `frain-dev/convoy` fans webhooks out to
subscriber endpoints with retries and a circuit breaker. web-hooky ships the forwarding half:
a `relays` table (destination -> target URL, signing secret, retry policy), a
`relay_deliveries` queue table, and a worker driven by the same `PersistenceAdapter`. See
`architecture.md#6-relay-forwarding`.

Decisions worth recording:

- **Queue, do not forward inline.** Forwarding during the inbound request would tie the
  vendor's timeout to the slowest downstream endpoint and would make retries impossible. The
  inbound path only writes a row.
- **Snapshot the payload into the delivery row.** Otherwise the retention sweeper could
  delete a record that still has undelivered jobs pointing at it. The corollary is that the
  sweeper must also reach `relay_deliveries`, or the copy would outlive the window the
  operator configured; it prunes `delivered` and `failed` rows on the same cutoff and leaves
  `pending` rows alone, because dropping a queued job loses data instead of expiring it.
- **Drain before closing storage.** The delivery outcome is written after the POST returns,
  so shutting down in between would leave a delivered webhook `pending` and re-send it after
  the lease. `stop()` therefore has a companion `drain()` that `shutdown()` awaits. Delivery
  stays at-least-once regardless (a crash cannot be drained), which is why the delivery id is
  documented as an idempotency key.
- **Lease on claim, rather than a separate "in flight" status.** Incrementing `attempts` and
  pushing `next_attempt_at` past a lease window in the claiming transaction is one write, and
  a worker that dies mid-attempt simply makes the job due again.
- **Sign `"{timestamp}.{body}"`, not the body.** Signing the body alone gives a captured
  request unlimited replay value. This matches the convention used by Stripe and others.
- **No circuit breaker yet.** Convoy trips a breaker per endpoint; here a persistently failing
  target simply exhausts `max_attempts` per delivery. A breaker is worth adding when relays
  fan out to many endpoints.
- **Command execution is deliberately not implemented.** `adnanh/webhook` runs local commands
  on receipt; that is a different (and much larger) trust model than forwarding HTTP, and the
  addon system already covers in-process transformation.

### Why every statement is serialized in the bun:sqlite driver

An earlier driver serialized only `transaction()` calls and let plain `run`/`all`/`get` reach
the connection directly. Because `bun:sqlite` is synchronous and the port is async, an
`await` inside a transaction callback yields the thread, and any statement issued in that gap
executed *inside* the open transaction. Two concrete failures followed: two concurrent
`only_unfetched` readers received the same records (the second `queryAndMark` joined the
first's transaction instead of queueing behind it), and an insert that had already been
acknowledged with `202` was discarded when an unrelated transaction rolled back.

The fix routes every call through one FIFO promise queue. The cost is that a transaction
callback must use its `tx` handle - using the outer driver inside a callback now deadlocks
instead of silently corrupting isolation - which is documented on the port and asserted by
`src/storage/driver-isolation.test.ts`.

### Admin CSRF model

The admin surface has two credential paths with different exposure. An admin API key is never
attached by a browser, so key-authenticated requests need no CSRF defence. An identity
asserted by an IdP proxy is ambient, so `/_admin/api` mutations on that path require either a
matching `Origin` (own origin plus `WEBHOOKY_ADMIN_ALLOWED_ORIGINS`) or an
`application/json` content type, which cannot be sent cross-site without a preflight that no
CORS response header ever satisfies. A CSRF token was considered and rejected: it would need
server-side session state, which is exactly what "no in-process end-user auth" rules out.

### fetched semantics

`GET /_get/{uuid}` returns each record's `fetched` value *as it was before the call marked
it*. The alternative (always reporting `true`) discards the only signal telling a client
which records are new to it. `mark_fetched=false` allows peeking. WebSocket delivery never
marks records, so a client can use `/_ws/` for latency and `/_get/?only_unfetched=true` to
catch up on what the socket missed.

**`only_unfetched` is at-most-once, not guaranteed-once.** Marking happens inside the same
transaction as the read, before the response leaves the server, so a response lost in transit
takes those records out of every later `only_unfetched=true` call. That trade was chosen
deliberately: the alternative (mark on client acknowledgement) needs per-consumer delivery
state, which the fetch API does not have. A consumer that cannot tolerate losing a batch
should pass `mark_fetched=false` and page with explicit `from`/`to` bounds, which are
re-readable, or use a relay - relay delivery is at-least-once and retried.

### Inbound body cap

`WEBHOOKY_MAX_BODY_BYTES` is enforced twice. A `Content-Length` larger than the cap is
rejected before anything is read. Requests without it (chunked or streamed) are read from
`request.body` chunk by chunk and abandoned - the reader is cancelled - as soon as the
accumulated byte count passes the cap, so peak memory is bounded on both paths rather than
only on the declared-length one.

---
