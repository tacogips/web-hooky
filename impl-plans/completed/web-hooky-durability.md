# web-hooky Delivery Durability Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#4-storage-adapters, #6-relay-forwarding
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (sections 4 and 6), design-docs/specs/notes.md

### Summary

Second round of independent-review findings, all concerning data that outlives or escapes its
intended lifetime: relay deliveries were never swept by retention, overlapping addon uploads
could orphan the winner's files, shutdown could re-send an already delivered webhook, and the
at-least-once delivery contract was undocumented.

### Scope

**Included**: `src/storage/{persistence,retention}.ts`,
`src/storage/sqlite/relay-store.ts`, `src/relay/worker.ts`, `src/runtime.ts`,
`src/admin/{addons-api,relays-api}.ts`, `src/core/async.ts`, `src/config.ts`, `README.md`,
`design-docs/specs/{architecture,command,notes}.md`
**Excluded**: a per-endpoint circuit breaker, a shared (cross-process) cache adapter

---

## Modules

### 1. Relay deliveries under retention (R1)

#### src/storage/persistence.ts, src/storage/sqlite/relay-store.ts, src/storage/retention.ts

**Status**: COMPLETED

```typescript
interface RelayDeliveryStore {
  deleteExpired(nowSeconds: number, defaultRetentionSeconds: number): Promise<number>;
}

interface RetentionSweepResult {
  readonly records: number;
  readonly relayDeliveries: number;
}

function sweepExpiredRecords(
  persistence: PersistenceAdapter,
  clock: Clock,
  defaultRetentionSeconds: number,
): Promise<RetentionSweepResult>;
```

**Checklist**:
- [x] Delivery sweep joins `destinations`, so the per-destination override and the
      "retention <= 0 disables" rule match `records.deleteExpired` exactly
- [x] Only `delivered` and `failed` rows are removed; `pending` rows survive at any age
- [x] One timestamp shared by both passes of a sweep
- [x] `RetentionSweeper.sweep()` and `WebhookyRuntime.sweepRetention()` report both counts
- [x] Store-level tests: terminal rows pruned, pending kept, override honoured, zero disables
- [x] End-to-end test: a delivered relay job's payload copy is gone after `sweepRetention()`

### 2. Serialised addon installation (R2)

#### src/core/async.ts, src/admin/addons-api.ts

**Status**: COMPLETED

```typescript
interface KeyedLock {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
function createKeyedLock(): KeyedLock;
```

**Checklist**:
- [x] Parse -> conflict check -> install -> load -> register -> persist runs under a lock
      keyed on addons directory plus manifest name
- [x] The losing upload never runs `removeAddonFiles` against the winner's directory
- [x] Test: two overlapping uploads of one name yield `201` and `409`, the winner's entry file
      is on disk and its inbound route still accepts webhooks

### 3. Draining shutdown (R3)

#### src/core/async.ts, src/relay/worker.ts, src/storage/retention.ts, src/runtime.ts

**Status**: COMPLETED

```typescript
interface InFlightTracker {
  track<T>(work: Promise<T>): Promise<T>;
  drain(): Promise<void>;
}
interface RelayWorker { drain(): Promise<void>; }
interface RetentionSweeper { drain(): Promise<void>; }
```

**Checklist**:
- [x] `runOnce()` and `sweep()` register their run with the tracker
- [x] `shutdown()` awaits both drains before `cache.close()` and `persistence.close()`
- [x] Test: `drain()` resolves only after the in-flight delivery is marked delivered
- [x] Test: a shutdown issued while a delivery is in flight still records the success

### 4. Delivery contract and lease invariant (R4)

#### README.md, design-docs/specs/*.md, src/config.ts, src/admin/relays-api.ts

**Status**: COMPLETED

**Checklist**:
- [x] README states that delivery is at-least-once and that `x-webhooky-delivery` is the
      idempotency key
- [x] Retention statement in README and architecture.md is accurate for relayed destinations
- [x] Lease-must-exceed-timeout is enforced: startup rejects a default timeout that reaches
      the lease, the admin API rejects a per-relay `timeoutSeconds` that does
- [x] Tests for both rejections

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Delivery retention | Relay storage | Available |
| Draining shutdown | Relay worker, retention sweeper | Available |
| Install lock | Admin addon API | Available |

## Completion Criteria

- [x] All modules implemented
- [x] All tests passing (`bun test`)
- [x] Type checking passes (`tsc --noEmit`)
- [x] Biome reports no errors

## Progress Log

### Session: 2026-08-05

**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004
**Tasks In Progress**: None
**Blockers**: None
**Notes**: The R2 and R3 regression tests were confirmed to fail against the previous
behaviour before the fixes were kept: with the lock removed the concurrent-upload test fails
with `ENOENT` on the winner's entry file, and with `drain()` stubbed out to resolve
immediately both drain tests fail with "Cannot use a closed database" and a delivery left
pending. Retention deliberately keeps `pending` deliveries at any age; the alternative would
turn a retention policy into silent data loss for jobs that are still queued.

## Related Plans

- **Previous**: `impl-plans/completed/web-hooky-hardening.md`
- **Related**: `impl-plans/completed/web-hooky-relay.md`
