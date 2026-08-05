# web-hooky Relay Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#6-relay-forwarding
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (section 6), design-docs/specs/notes.md

### Summary

Store-and-forward relaying: every record accepted by a destination is queued for delivery to
the destination's enabled relay targets, signed with HMAC-SHA256, retried with exponential
backoff, and observable and manageable from the admin surface.

### Scope

**Included**: `src/relay/`, relay stores in `src/storage/`, `src/admin/relays-api.ts`,
the admin UI relays view, relay configuration
**Excluded**: local command execution on receipt (different trust model, see `notes.md`);
per-endpoint circuit breaking

---

## Modules

### 1. Relay data model and stores

#### src/storage/types.ts, persistence.ts, sqlite/relay-store.ts, sqlite/schema.ts

**Status**: COMPLETED

```typescript
enum RelayDeliveryStatus { Pending = "pending", Delivered = "delivered", Failed = "failed" }

interface RelayRecord {
  readonly id: string;
  readonly destinationId: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
  readonly timeoutSeconds: number;
  readonly createdAt: number;
  readonly createdBy: string | null;
}

interface RelayDeliveryRecord {
  readonly id: string;
  readonly relayId: string;
  readonly destinationId: string;
  readonly recordId: string;
  readonly t: number;
  readonly payload: JsonValue;
  readonly status: RelayDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deliveredAt: number | null;
}

interface RelayStore { create; update; delete; findById; list; listForDestination; listEnabledForDestination }
interface RelayDeliveryStore {
  enqueue(delivery: RelayDeliveryRecord): Promise<void>;
  claimDue(nowSeconds: number, limit: number, leaseSeconds: number): Promise<readonly RelayDeliveryRecord[]>;
  markDelivered; reschedule; park; markFailed; requeueFailed; listForRelay; statsForRelay;
}
```

**Checklist**:
- [x] `relays` and `relay_deliveries` tables, SQLite/libSQL/D1 compatible DDL only
- [x] Cascade from `destinations` and from `relays`
- [x] `claimDue` reads and leases inside one transaction
- [x] Payload snapshotted into the delivery row

### 2. Dispatch and worker

#### src/relay/dispatch.ts, src/relay/queue.ts, src/relay/worker.ts

**Status**: COMPLETED

```typescript
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function deliverRelayOnce(options: DeliverRelayOptions): Promise<RelayAttemptResult>;
function backoffSeconds(baseSeconds: number, attempts: number, maxBackoffSeconds: number): number;
function enqueueRelayDeliveries(persistence: PersistenceAdapter, clock: Clock, record: WebhookRecord): Promise<number>;
function createRelayWorker(deps: RelayWorkerDeps): RelayWorker;   // runOnce / start / stop
```

**Checklist**:
- [x] Signed `"{timestamp}.{body}"` HMAC-SHA256 header when a secret is configured
- [x] Per-relay request timeout via `AbortSignal.timeout`
- [x] Exponential backoff capped by configuration; final attempt marks the delivery failed
- [x] Deliveries for a disabled relay are parked, not dropped, and parking returns the
      attempt consumed by the claim
- [x] Injectable `fetch` so tests never touch the network

### 3. Admin surface and configuration

#### src/admin/relays-api.ts, src/admin-ui/views/relays-view.tsx, src/config.ts, src/runtime.ts

**Status**: COMPLETED

```
GET    /_admin/api/relays[?destinationId=]   POST   /_admin/api/relays
GET    /_admin/api/relays/:id                PATCH  /_admin/api/relays/:id
DELETE /_admin/api/relays/:id
GET    /_admin/api/relays/:id/deliveries     POST   /_admin/api/relays/:id/retry
```

**Checklist**:
- [x] Target URL validated (`http:`/`https:` only), destination existence checked
- [x] Signing secret is write-only; responses expose `hasSecret`
- [x] Delivery listing plus per-status stats; failed deliveries requeueable
- [x] Relays tab in the admin UI with create, enable/disable, retry, delete
- [x] `WEBHOOKY_RELAY_*` settings with CLI flag equivalents
- [x] Worker lifecycle wired into the runtime; `runRelayDeliveries()` exposed for schedulers

---

## Tasks

### TASK-001: Relay storage

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/storage/types.ts`, `src/storage/persistence.ts`,
`src/storage/sqlite/{schema,rows,relay-store,adapter}.ts`

**Completion Criteria**:
- [x] Stores implemented on the `SqlDriver` port only
- [x] Claim-once behaviour covered by a test

### TASK-002: Dispatch and worker

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/relay/{dispatch,queue,worker}.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [x] Success, retry-with-backoff, exhaustion and disabled-relay paths tested
- [x] Signature verified in a test against an independent HMAC computation

### TASK-003: Admin API, UI and configuration

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/admin/relays-api.ts`, `src/admin-ui/views/relays-view.tsx`,
`src/config.ts`, `src/runtime.ts`, `src/server/webhook.ts`
**Dependencies**: TASK-002

**Completion Criteria**:
- [x] Full parity between the UI and the API
- [x] End-to-end test: signed inbound webhook forwarded to a stubbed target
- [x] Documentation updated (architecture, notes, command, README)

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Relay storage | Storage adapters | Available |
| Worker | Relay storage | Available |
| Admin API and UI | Worker, admin surface | Available |

## Completion Criteria

- [x] All modules implemented
- [x] All tests passing (`bun test`)
- [x] Type checking passes (`tsc --noEmit`)
- [x] Biome reports no errors

## Progress Log

### Session: 2026-08-05

**Tasks Completed**: TASK-001, TASK-002, TASK-003
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented in response to review finding F4 (relay/forwarding was requested in the
outcome statement but had been deferred). Command execution on receipt, the other half of
`adnanh/webhook`, is deliberately out of scope: it is a different trust model, and the addon
system already covers in-process transformation. Per-endpoint circuit breaking is not
implemented; a persistently failing target exhausts `maxAttempts` per delivery instead.

## Related Plans

- **Previous**: `impl-plans/completed/web-hooky-admin.md`
- **Related**: `impl-plans/completed/web-hooky-hardening.md`
