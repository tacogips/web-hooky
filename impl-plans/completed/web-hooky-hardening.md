# web-hooky Hardening Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#4-storage-adapters, #9-security-notes
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (sections 1, 4, 5, 9),
design-docs/specs/notes.md

### Summary

Correctness and security fixes raised by the independent implementation review: SQL driver
transaction isolation, destructive addon re-upload, admin CSRF, disabled-destination
semantics, and a path-separator inconsistency.

### Scope

**Included**: `src/storage/sqlite/bun-driver.ts`, `src/storage/sql-driver.ts`,
`src/addons/package.ts`, `src/admin/{addons-api,csrf,api}.ts`, `src/server/{app,fetch-api,
static-ui}.ts`, `src/config.ts`
**Excluded**: relay/forwarding (see `web-hooky-relay.md`)

---

## Modules

### 1. SQL driver isolation (F1)

#### src/storage/sqlite/bun-driver.ts, src/storage/sql-driver.ts

**Status**: COMPLETED

```typescript
// Every call is routed through one FIFO promise queue.
function enqueue<T>(task: () => Promise<T>): Promise<T>;
// Transaction callbacks receive an `inner` driver that executes directly and
// never opens a nested transaction.
```

**Checklist**:
- [x] `run`/`all`/`get` queued alongside `transaction`
- [x] Re-entrant `transaction()` from a concurrent caller can no longer join an open one
- [x] Port contract documents the isolation guarantee and the `tx`-handle obligation
- [x] Regression tests: concurrent `only_unfetched` readers are disjoint; a write issued
      during a transaction that rolls back survives; a statement queued behind a committing
      transaction observes its result

### 2. Addon upload conflict handling (F2)

#### src/addons/package.ts, src/admin/addons-api.ts

**Status**: COMPLETED

```typescript
function installParsedAddonPackage(options: InstallParsedAddonOptions): Promise<Result<InstalledAddonRecord, AppError>>;
function installAddonPackage(options: InstallAddonOptions): Promise<Result<InstalledAddonRecord, AppError>>;
```

**Checklist**:
- [x] Archive parsed and the name conflict resolved before any filesystem write
- [x] Conflict with a persisted-but-unloaded addon row rejected with a clear message
- [x] `DELETE /_admin/api/addons/:name` can remove such an orphan row so the name is reusable
- [x] Tests: re-upload returns 409 with the first installation's files, registration and
      usability intact; an orphan row can be removed and the name reinstalled

### 3. Admin CSRF defence (F3)

#### src/admin/csrf.ts, src/admin/api.ts, src/config.ts

**Status**: COMPLETED

```typescript
function checkAdminCsrf(config: AppConfig, request: Request, principal: AdminPrincipal): Result<null, AppError>;
```

**Checklist**:
- [x] Applies only to non-safe methods on the IdP-authenticated path
- [x] Present `Origin` must match the request origin or `WEBHOOKY_ADMIN_ALLOWED_ORIGINS`
- [x] Absent `Origin` requires `content-type: application/json`
- [x] Admin API key requests unaffected
- [x] Tests: text/plain rejected, foreign origin rejected, same-origin and configured origin
      accepted, multipart from a foreign origin rejected, key path unaffected

### 4. Disabled destination semantics (F5) and path separator (F6)

#### src/server/fetch-api.ts, src/server/app.ts, src/server/static-ui.ts

**Status**: COMPLETED

**Checklist**:
- [x] `/_get/` and `/_ws/` answer 403 for a disabled destination, matching the inbound route
- [x] Admin record inspection remains available for draining
- [x] Behaviour documented in `architecture.md` and `README.md`
- [x] Integration and WebSocket tests cover both surfaces
- [x] `resolveAssetPath` containment check uses `node:path` `sep`

---

## Tasks

### TASK-001: Driver isolation

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/storage/sqlite/bun-driver.ts`, `src/storage/sql-driver.ts`,
`src/storage/driver-isolation.test.ts`

**Completion Criteria**:
- [x] New tests fail against the previous driver and pass against the fixed one

### TASK-002: Addon upload and admin CSRF

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/addons/package.ts`, `src/admin/{addons-api,csrf,api}.ts`,
`src/config.ts`, `src/admin/csrf.test.ts`, `src/admin/admin-api.test.ts`

**Completion Criteria**:
- [x] No destructive path on a rejected upload
- [x] CSRF guard covers the IdP path only

### TASK-003: Fetch surface semantics and portability

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/server/{fetch-api,app,static-ui}.ts`,
`src/server/integration.test.ts`, `src/server/websocket.test.ts`

**Completion Criteria**:
- [x] Disabled destination behaviour enforced and documented
- [x] Separator handling consistent with `addons/loader.ts` and `addons/package.ts`

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Driver isolation | Storage adapters | Available |
| CSRF guard | Admin auth | Available |
| Fetch semantics | Server core | Available |

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
**Notes**: Driver isolation was verified by running the new regression tests against a copy of
the previous driver implementation: all three failed there and pass against the fixed driver.
The isolation fix trades a silent correctness bug for a loud one - a transaction callback that
uses the outer driver now deadlocks instead of corrupting isolation - which is documented on
the port. `WEBHOOKY_ADMIN_ALLOWED_ORIGINS` is new configuration and is needed only when the
admin UI is served from a different origin than the API.

## Related Plans

- **Previous**: `impl-plans/completed/web-hooky-admin.md`
- **Related**: `impl-plans/completed/web-hooky-relay.md`
