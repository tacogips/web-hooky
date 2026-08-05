# web-hooky Foundation Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#3-data-model
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (sections 2, 3, 4), design-docs/specs/notes.md

### Summary

Core primitives, the JSON Schema validator, the storage adapter interfaces with a
`bun:sqlite` implementation, retention, and the addon runtime (manifest, registry, zip
package install, loader, built-in addons).

### Scope

**Included**: `src/core/`, `src/schema/`, `src/storage/`, `src/addons/`, `src/config.ts`
**Excluded**: HTTP routing, admin API, admin UI (see `web-hooky-server.md`,
`web-hooky-admin.md`)

---

## Modules

### 1. Core primitives

#### src/core/result.ts, src/core/json.ts, src/core/errors.ts, src/core/ids.ts, src/core/time.ts

**Status**: COMPLETED

```typescript
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
interface JsonObject { readonly [key: string]: JsonValue }

enum AppErrorKind {
  BadRequest = "bad_request",
  Unauthorized = "unauthorized",
  Forbidden = "forbidden",
  NotFound = "not_found",
  Conflict = "conflict",
  PayloadTooLarge = "payload_too_large",
  UnprocessableEntity = "unprocessable_entity",
  Internal = "internal",
}
interface AppError {
  readonly kind: AppErrorKind;
  readonly message: string;
  readonly details?: JsonValue;
}

interface Clock { nowSeconds(): number; nowMs(): number }
```

**Checklist**:
- [x] Result helpers (`ok`, `err`, `getErrorMessage`)
- [x] JSON value types + `isJsonObject` / `parseJsonText`
- [x] `AppError` + `statusForErrorKind`
- [x] `newUuid`, `newSecret`, `sha256Hex`, `hmacSha256`, `timingSafeEqualString`
- [x] Unit tests

### 2. JSON Schema validator

#### src/schema/types.ts, src/schema/validate.ts

**Status**: COMPLETED

```typescript
type JsonSchema = boolean | JsonSchemaObject;
interface SchemaIssue { readonly path: string; readonly message: string }
function validateJsonSchema(schema: JsonSchema, value: JsonValue): Result<JsonValue, readonly SchemaIssue[]>;
function parseJsonSchema(value: JsonValue): Result<JsonSchema, string>;
```

**Checklist**:
- [x] draft-07 subset (types, enum/const, object, array, string, number, combinators)
- [x] `$ref` rejected explicitly at parse time
- [x] Unit tests covering each keyword group

### 3. Storage interfaces and SQLite adapter

#### src/storage/types.ts, src/storage/persistence.ts, src/storage/cache.ts, src/storage/sql-driver.ts, src/storage/sqlite/*.ts, src/storage/memory-cache.ts, src/storage/retention.ts

**Status**: COMPLETED

```typescript
interface PersistenceAdapter {
  readonly destinations: DestinationStore;
  readonly records: RecordStore;
  readonly apiUsers: ApiUserStore;
  readonly adminKeys: AdminKeyStore;
  readonly adminUsers: AdminUserStore;
  readonly addons: InstalledAddonStore;
  init(): Promise<void>;
  close(): Promise<void>;
}

interface RecordStore {
  insert(record: WebhookRecord): Promise<void>;
  query(query: RecordQuery): Promise<readonly WebhookRecord[]>;
  queryAndMark(query: RecordQuery): Promise<readonly WebhookRecord[]>;
  deleteExpired(nowSeconds: number, defaultRetentionSeconds: number): Promise<number>;
}

interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
```

**Checklist**:
- [x] `SqlDriver` interface + `bun:sqlite` driver with serialized transactions
- [x] DDL + all six stores implemented on `SqlDriver`
- [x] `queryAndMark` transactional (descending `t`, filters, limit)
- [x] Memory cache with TTL, retention sweeper
- [x] Unit tests

### 4. Addon runtime

#### src/addons/types.ts, manifest.ts, registry.ts, package.ts, loader.ts, builtin/*.ts

**Status**: COMPLETED

```typescript
enum AddonKind { Vendor = "vendor", Destination = "destination", Both = "both" }

interface AddonManifest {
  readonly name: string;
  readonly version: string;
  readonly kind: AddonKind;
  readonly description: string;
  readonly entry: string | null;
  readonly acceptsSchema: JsonSchema;
  readonly returnsSchema: JsonSchema;
  readonly configSchema: JsonSchema | null;
}

interface AddonModule {
  authenticate?(ctx: AddonRequestContext): Promise<AddonAuthResult> | AddonAuthResult;
  transform?(input: JsonValue, ctx: AddonTransformContext): Promise<JsonValue> | JsonValue;
}
```

**Checklist**:
- [x] Manifest parsing/validation (unique name pattern, reserved prefixes)
- [x] Registry enforcing server-wide unique names
- [x] Zip package reader with traversal/size guards (`fflate`)
- [x] Dynamic loader for installed addons
- [x] Built-in `wrike`, `github`, `passthrough`, `envelope`
- [x] Unit tests (HMAC accept/reject, schema enforcement, zip guards)

### 5. Configuration

#### src/config.ts

**Status**: COMPLETED

```typescript
interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly retentionSeconds: number;
  readonly retentionSweepIntervalSeconds: number;
  readonly addonsDir: string;
  readonly adminUiDir: string;
  readonly adminSubjects: readonly string[];
  readonly adminAuthMode: AdminAuthMode;
  readonly maxBodyBytes: number;
  readonly defaultFetchLimit: number;
  readonly maxFetchLimit: number;
  readonly cacheTtlSeconds: number;
}
function loadConfig(env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): Result<AppConfig, AppError>;
```

**Checklist**:
- [x] Env + argv parsing with validation errors
- [x] Unit tests

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Core primitives | `src/core/*.ts` | COMPLETED | `src/core/*.test.ts` |
| Schema validator | `src/schema/validate.ts` | COMPLETED | `src/schema/validate.test.ts` |
| Storage interfaces | `src/storage/*.ts` | COMPLETED | `src/storage/sqlite-adapter.test.ts` |
| SQLite adapter | `src/storage/sqlite/*.ts` | COMPLETED | `src/storage/sqlite-adapter.test.ts` |
| Addon runtime | `src/addons/*.ts` | COMPLETED | `src/addons/*.test.ts` |
| Configuration | `src/config.ts` | COMPLETED | `src/config.test.ts` |

## Tasks

### TASK-001: Core primitives and schema validator

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/core/*.ts`, `src/schema/*.ts`
**Dependencies**: None

**Completion Criteria**:
- [x] Types and helpers implemented
- [x] Validator covers the documented draft-07 subset
- [x] Unit tests pass

### TASK-002: Storage adapters

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/storage/**`
**Dependencies**: TASK-001

**Completion Criteria**:
- [x] `SqlDriver` + `bun:sqlite` implementation
- [x] Six stores with SQLite-compatible SQL only
- [x] Retention sweeper honours per-destination override
- [x] Unit tests pass

### TASK-003: Addon runtime

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/addons/**`
**Dependencies**: TASK-001

**Completion Criteria**:
- [x] Manifest, registry, package install, loader
- [x] Built-in addons including wrike HMAC
- [x] Unit tests pass

### TASK-004: Configuration

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/config.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [x] Env + flag parsing with validation
- [x] Unit tests pass

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Storage adapters | Core primitives | Available |
| Addon runtime | Core primitives, schema validator | Available |

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
**Notes**: Hand-written JSON Schema validator chosen over ajv for Workers compatibility
(no `new Function`); rationale recorded in `design-docs/specs/notes.md`.

## Related Plans

- **Next**: `impl-plans/completed/web-hooky-server.md`
- **Depends On**: None
