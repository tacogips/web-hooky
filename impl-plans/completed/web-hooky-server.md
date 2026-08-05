# web-hooky Server Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#1-request-lifecycle
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (sections 1, 5, 7)

### Summary

HTTP + WebSocket server: routing, the inbound webhook pipeline (vendor addon before
destination addon), the `_get` fetch API and the `_ws` streaming API, plus runtime wiring
and the CLI entry point.

### Scope

**Included**: `src/pipeline/`, `src/server/`, `src/runtime.ts`, `src/main.ts`
**Excluded**: admin API and admin UI (see `web-hooky-admin.md`)

---

## Modules

### 1. Inbound pipeline

#### src/pipeline/process.ts

**Status**: COMPLETED

```typescript
interface ProcessInboundInput {
  readonly destination: DestinationRecord;
  readonly vendorAddon: LoadedAddon;
  readonly destinationAddon: LoadedAddon | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly method: string;
  readonly receivedAt: number;
}

function processInboundWebhook(
  input: ProcessInboundInput,
): Promise<Result<JsonValue, AppError>>;
```

**Checklist**:
- [x] Vendor authenticate -> parse -> accepts validation -> transform -> returns validation
- [x] Destination addon runs on the vendor addon output, same sequence
- [x] Failures map to `AppError` without leaking signature material
- [x] Unit tests asserting ordering and short-circuit behaviour

### 2. Routing and responses

#### src/server/router.ts, src/server/responses.ts, src/server/app.ts

**Status**: COMPLETED

```typescript
interface AppContext {
  readonly config: AppConfig;
  readonly persistence: PersistenceAdapter;
  readonly cache: CacheAdapter;
  readonly registry: AddonRegistry;
  readonly hub: WebSocketHub;
  readonly adminAuth: AdminAuthProvider;
  readonly clock: Clock;
}

interface WebhookyApp {
  fetch(request: Request, server: UpgradeCapableServer | null): Promise<Response>;
  readonly websocket: WebSocketHandlers;
}

function createApp(ctx: AppContext): WebhookyApp;
```

**Checklist**:
- [x] Reserved `_`-prefixed routes dispatched before addon routes
- [x] JSON error envelope `{ error: { kind, message } }`
- [x] Unknown routes -> 404

### 3. Inbound webhook endpoint

#### src/server/webhook.ts

**Status**: COMPLETED

```typescript
function handleInboundWebhook(
  ctx: AppContext,
  request: Request,
  addonName: string,
  inboundUuid: string,
): Promise<Response>;
```

**Checklist**:
- [x] Body size cap, method check
- [x] Destination lookup by inbound UUID with cache
- [x] Vendor addon name must match the destination
- [x] Persist `{ t, fetched: false, payload }` and broadcast to the hub

### 4. Fetch API and WebSocket

#### src/server/fetch-api.ts, src/server/ws.ts

**Status**: COMPLETED

```typescript
interface FetchQuery {
  readonly onlyUnfetched: boolean;
  readonly from: number | null;
  readonly to: number | null;
  readonly limit: number;
  readonly markFetched: boolean;
}
function parseFetchQuery(url: URL, config: AppConfig): Result<FetchQuery, AppError>;

interface WebSocketHub {
  add(destinationId: string, socket: WebSocketLike): void;
  remove(destinationId: string, socket: WebSocketLike): void;
  broadcast(destinationId: string, record: PublicRecord): void;
  countFor(destinationId: string): number;
}
```

**Checklist**:
- [x] `only_unfetched`, `from`, `to`, `limit`, `mark_fetched` parsing (unix + ISO-8601)
- [x] Descending `t`, `{ t, fetched, payload }` shape, transactional marking
- [x] API key/secret auth via header or query (WebSocket handshake)
- [x] Grant check per destination

### 5. Runtime wiring and CLI

#### src/runtime.ts, src/main.ts

**Status**: COMPLETED

```typescript
interface WebhookyRuntime {
  readonly app: WebhookyApp;
  readonly context: AppContext;
  sweepRetention(): Promise<number>;
  shutdown(): Promise<void>;
}
function createRuntime(config: AppConfig): Promise<Result<WebhookyRuntime, AppError>>;
```

**Checklist**:
- [x] Adapter construction, admin seeding, bootstrap admin key
- [x] Installed addon loading at startup
- [x] Retention sweeper interval start/stop
- [x] `Bun.serve` wiring, signal handling, `--help`

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Pipeline | `src/pipeline/process.ts` | COMPLETED | `src/pipeline/process.test.ts` |
| Router/app | `src/server/app.ts` | COMPLETED | `src/server/server.test.ts` |
| Webhook endpoint | `src/server/webhook.ts` | COMPLETED | `src/server/server.test.ts` |
| Fetch API | `src/server/fetch-api.ts` | COMPLETED | `src/server/fetch-api.test.ts` |
| WebSocket | `src/server/ws.ts` | COMPLETED | `src/server/integration.test.ts` |
| Runtime/CLI | `src/runtime.ts`, `src/main.ts` | COMPLETED | `src/server/integration.test.ts` |

## Tasks

### TASK-001: Inbound pipeline

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/pipeline/process.ts`
**Dependencies**: web-hooky-foundation:TASK-003

**Completion Criteria**:
- [x] Vendor-before-destination ordering enforced and tested
- [x] Schema validation applied on both sides

### TASK-002: HTTP routing and webhook endpoint

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/server/app.ts`, `src/server/webhook.ts`, `src/server/router.ts`
**Dependencies**: TASK-001, web-hooky-foundation:TASK-002

**Completion Criteria**:
- [x] Signed webhook accepted, bad signature rejected with 401
- [x] Record persisted with `fetched = false`

### TASK-003: Fetch API and WebSocket

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/server/fetch-api.ts`, `src/server/ws.ts`
**Dependencies**: TASK-002

**Completion Criteria**:
- [x] All query parameters honoured, descending order
- [x] Returned records marked fetched transactionally
- [x] WebSocket streams newly received records to authorized clients

### TASK-004: Runtime wiring and CLI

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/runtime.ts`, `src/main.ts`
**Dependencies**: TASK-003

**Completion Criteria**:
- [x] Server boots from configuration and serves every route
- [x] Retention sweeper lifecycle managed
- [x] Integration test exercises the full round trip

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Pipeline | Addon runtime | Available |
| Server | Pipeline, storage | Available |

## Completion Criteria

- [x] All modules implemented
- [x] All tests passing
- [x] Type checking passes
- [x] Biome reports no errors

## Progress Log

### Session: 2026-08-05

**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004
**Tasks In Progress**: None
**Blockers**: None
**Notes**: `queryAndMark` is a single transaction so concurrent `only_unfetched` readers
cannot both observe the same record as unfetched.

## Related Plans

- **Previous**: `impl-plans/completed/web-hooky-foundation.md`
- **Next**: `impl-plans/completed/web-hooky-admin.md`
- **Depends On**: `web-hooky-foundation.md`
