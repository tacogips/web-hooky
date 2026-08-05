# web-hooky Admin Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#6-admin-surface
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (section 6)

### Summary

Admin authentication behind an external-IdP abstraction, the `/_admin/api` surface with full
parity to the UI, and the SolidJS single-page admin UI served at `/_admin/`.

### Scope

**Included**: `src/admin/`, `src/admin-ui/`, static asset serving
**Excluded**: server core (see `web-hooky-server.md`)

---

## Modules

### 1. Admin authentication

#### src/admin/auth.ts

**Status**: COMPLETED

```typescript
enum AdminAuthMode { TrustedHeader = "trusted-header", Dev = "dev", Disabled = "disabled" }

interface AdminIdentity { readonly subject: string; readonly provider: string }

interface AdminAuthProvider {
  readonly name: string;
  authenticate(request: Request): Promise<AdminIdentity | null>;
}

interface AdminPrincipal {
  readonly subject: string;
  readonly viaApiKey: boolean;
  readonly keyId: string | null;
}

function createAdminAuthProvider(config: AppConfig): AdminAuthProvider;
function resolveAdminPrincipal(ctx: AppContext, request: Request): Promise<Result<AdminPrincipal, AppError>>;
```

**Checklist**:
- [x] Admin API key credential path (`Bearer <keyId>:<secret>`), constant-time compare
- [x] Trusted-header provider with optional proxy shared secret
- [x] Dev provider for local testing, `disabled` mode
- [x] Subject must exist in the admin user store
- [x] Unit tests for each provider and rejection paths

### 2. Admin API

#### src/admin/api.ts, destinations-api.ts, users-api.ts, addons-api.ts, keys-api.ts

**Status**: COMPLETED

```typescript
function handleAdminApi(ctx: AppContext, request: Request, segments: readonly string[]): Promise<Response>;
```

**Checklist**:
- [x] Destinations: list, create, read, patch, delete, rotate fetch UUID
- [x] Records inspection endpoint (never marks fetched)
- [x] Fetch users: list, create (secret shown once), rotate, delete, grant, revoke
- [x] Addons: list built-in + installed, upload zip, delete installed
- [x] Admin keys: list, create, delete; admin users: list, create, delete
- [x] Unauthenticated and non-admin requests rejected with 401/403
- [x] Integration tests over the HTTP surface

### 3. Static UI serving

#### src/server/static-ui.ts

**Status**: COMPLETED

```typescript
function handleAdminUi(ctx: AppContext, pathname: string): Promise<Response>;
```

**Checklist**:
- [x] Serves the built SPA with index fallback
- [x] Placeholder page with build instructions when assets are absent
- [x] Path traversal rejected

### 4. SolidJS admin UI

#### src/admin-ui/main.tsx, app.tsx, api-client.ts, build.ts, views/*.tsx

**Status**: COMPLETED

```typescript
interface AdminApiClient {
  listDestinations(): Promise<readonly AdminDestination[]>;
  createDestination(input: CreateDestinationInput): Promise<AdminDestination>;
  listUsers(): Promise<readonly AdminApiUser[]>;
  createUser(label: string): Promise<CreatedApiUser>;
  setGrant(userId: string, destinationId: string, granted: boolean): Promise<void>;
  listAddons(): Promise<readonly AdminAddon[]>;
  uploadAddon(file: File): Promise<AdminAddon>;
  listAdminKeys(): Promise<readonly AdminKeySummary[]>;
  createAdminKey(label: string): Promise<CreatedAdminKey>;
}
```

**Checklist**:
- [x] Destinations view (issue destination URLs, show inbound + fetch UUID)
- [x] Users view (register key/secret, grant/revoke per destination)
- [x] Addons view (list, upload zip package)
- [x] Admin keys view (issue, revoke) and admin users view
- [x] Builds with `bun run build:ui` into `dist/admin-ui`

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Admin auth | `src/admin/auth.ts` | COMPLETED | `src/admin/auth.test.ts` |
| Admin API | `src/admin/*.ts` | COMPLETED | `src/admin/admin-api.test.ts` |
| Static UI serving | `src/server/static-ui.ts` | COMPLETED | `src/server/static-ui.test.ts` |
| SolidJS UI | `src/admin-ui/**` | COMPLETED | `src/admin-ui/app.test.ts` |

## Tasks

### TASK-001: Admin authentication

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `src/admin/auth.ts`
**Dependencies**: web-hooky-foundation:TASK-002

**Completion Criteria**:
- [x] API key and IdP paths implemented behind one abstraction
- [x] Unit tests pass

### TASK-002: Admin API endpoints

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/admin/api.ts` and handler modules
**Dependencies**: TASK-001, web-hooky-server:TASK-002

**Completion Criteria**:
- [x] Full parity with the admin UI capability list
- [x] Integration tests cover create/list/upload/issue and rejection paths

### TASK-003: Admin UI

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `src/admin-ui/**`, `src/server/static-ui.ts`
**Dependencies**: TASK-002

**Completion Criteria**:
- [x] All four management areas implemented
- [x] UI bundle builds with Bun (babel-preset-solid plugin)
- [x] Served at `/_admin/`

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Admin API | Admin auth, storage | Available |
| Admin UI | Admin API | Available |

## Completion Criteria

- [x] All modules implemented
- [x] All tests passing
- [x] Type checking passes
- [x] Biome reports no errors

## Progress Log

### Session: 2026-08-05

**Tasks Completed**: TASK-001, TASK-002, TASK-003
**Tasks In Progress**: None
**Blockers**: None
**Notes**: The hyperscript JSX runtime (`solid-js/h`) was implemented first and then replaced:
its eager prop evaluation meant the UI never re-rendered after data loaded. The admin UI is
now compiled with `babel-preset-solid` through a Bun bundler plugin
(`src/admin-ui/build.ts`), and `src/admin-ui/app.test.ts` renders the produced bundle against
happy-dom. See `design-docs/specs/notes.md`. Real IdP integration is exercised only through
the trusted-header provider locally.

## Related Plans

- **Previous**: `impl-plans/completed/web-hooky-server.md`
- **Depends On**: `web-hooky-foundation.md`, `web-hooky-server.md`
