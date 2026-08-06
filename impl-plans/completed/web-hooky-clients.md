# web-hooky Clients Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/clients.md
**Created**: 2026-08-06
**Last Updated**: 2026-08-06

---

## Design Document Reference

**Source**: design-docs/specs/clients.md

### Summary

Four official client implementations - Go, Python, Node, Swift - each usable as a library and
as a `webhooky` CLI, covering the read (`/_get/`), stream (`/_ws/`) and admin (`/_admin/api`)
surfaces. Library configuration is passed as explicit parameters; only the CLI reads the
environment.

### Scope

**Included**: fetch client, stream client, admin client, typed models, error envelope
decoding, CLI for all three surfaces, per-language unit tests, one cross-client live smoke
script, `clients/README.md`.

**Excluded**: inbound webhook posting (the vendor's job), publishing to package registries,
addon authoring helpers, retry/queueing on top of the fetch API.

---

## Modules

### 1. Go client - `clients/go`

**Status**: COMPLETE

```go
type Config struct {
    BaseURL        string
    APIKey, APISecret string      // fetch client
    Credential     string          // admin client, "<id>:<secret>"
    TimeoutSeconds int
    Headers        map[string]string
    UserAgent      string
}

type Client struct{ ... }                       // fetch + stream
func New(cfg Config) (*Client, error)
func (c *Client) Records(ctx context.Context, fetchUUID string, q RecordQuery) ([]Record, error)
func (c *Client) Stream(ctx context.Context, fetchUUID string, opts StreamOptions, fn func(Record) error) error

type AdminClient struct{ ... }
func NewAdmin(cfg Config) (*AdminClient, error)
```

**Checklist**:
- [x] `webhooky/config.go` - config normalization, base URL/ws URL derivation
- [x] `webhooky/errors.go` - `Error` type + envelope decoding
- [x] `webhooky/types.go` - Record, Destination, Relay, ApiUser, Addon, AdminKey, AdminUser
- [x] `webhooky/client.go` - transport, bearer auth, JSON decode
- [x] `webhooky/fetch.go` - `Records`, query building
- [x] `webhooky/stream.go` - `coder/websocket` loop, reconnect, 1008 handling
- [x] `webhooky/admin.go` - every admin endpoint
- [x] `cmd/webhooky/*.go` - CLI: env, global flags, records + admin groups
- [x] `webhooky/*_test.go` - httptest-backed unit tests

### 2. Python client - `clients/python`

**Status**: COMPLETE

```python
class FetchClient:
    def __init__(self, base_url, api_key, api_secret, timeout_seconds=30.0, headers=None, user_agent=None)
    def records(self, fetch_uuid, *, only_unfetched=False, mark_fetched=True, from_=None, to=None, limit=None) -> list[Record]
    def stream(self, fetch_uuid, **opts) -> Iterator[Record]
class AsyncFetchClient: ...          # same surface, awaitable / async iterator
class AdminClient / AsyncAdminClient: ...
```

**Checklist**:
- [x] `src/webhooky/config.py`, `errors.py`, `models.py`
- [x] `src/webhooky/_ops.py` - request descriptions shared by both flavours
- [x] `src/webhooky/_transport.py` - httpx execution of an operation
- [x] `src/webhooky/fetch.py` - sync + async fetch clients
- [x] `src/webhooky/stream.py` - `websockets` sync + async streaming
- [x] `src/webhooky/admin.py` - sync + async admin clients
- [x] `src/webhooky/cli.py` + `__main__.py` - argparse CLI
- [x] `pyproject.toml` with `webhooky` console script
- [x] `tests/` - stub-server unit tests

### 3. Node client - `clients/node`

**Status**: COMPLETE

```typescript
export class WebhookyFetchClient {
  constructor(config: FetchClientConfig);
  records(fetchUuid: string, query?: RecordQuery): Promise<readonly Record[]>;
  stream(fetchUuid: string, options?: StreamOptions): AsyncIterableIterator<Record>;
}
export class WebhookyAdminClient { constructor(config: AdminClientConfig); ... }
```

**Checklist**:
- [x] `src/config.ts`, `src/errors.ts`, `src/types.ts`
- [x] `src/http.ts` - fetch transport
- [x] `src/fetch-client.ts`, `src/stream.ts`, `src/admin-client.ts`
- [x] `src/index.ts` - public surface
- [x] `src/cli/*.ts` + `bin/webhooky.js`
- [x] own `tsconfig.json` (repo strictness) and `biome.json`
- [x] `test/*.test.ts` - bun/node test runner

### 4. Swift client - `clients/swift`

**Status**: COMPLETE

```swift
public struct FetchClientConfig { public var baseURL: URL; public var apiKey: String; ... }
public final class WebHookyFetchClient: Sendable {
    public init(config: FetchClientConfig) throws
    public func records(fetchUUID: String, query: RecordQuery) async throws -> [WebhookRecord]
    public func stream(fetchUUID: String, options: StreamOptions) -> AsyncThrowingStream<WebhookRecord, Error>
}
public final class WebHookyAdminClient: Sendable { ... }
```

**Checklist**:
- [x] `Sources/WebHooky/Config.swift`, `Errors.swift`, `Models.swift`
- [x] `Sources/WebHooky/Transport.swift`
- [x] `Sources/WebHooky/FetchClient.swift`, `Stream.swift`, `AdminClient.swift`
- [x] `Sources/WebHookyCLI/*.swift` - swift-argument-parser commands
- [x] `Package.swift` with library + executable products
- [x] `Tests/WebHookyTests/*.swift`

### 5. Cross-client verification - `clients/scripts`

**Status**: COMPLETE

**Checklist**:
- [x] `smoke.sh` - boot server, seed fixtures, exercise every CLI, compare output
- [x] `clients/README.md` - install, env vars, CLI reference, library snippets

---

## Module Status

| Module | Path | Status | Tests |
|--------|------|--------|-------|
| Go client | `clients/go` | COMPLETE | passing |
| Python client | `clients/python` | COMPLETE | passing |
| Node client | `clients/node` | COMPLETE | passing |
| Swift client | `clients/swift` | COMPLETE | passing |
| Smoke script | `clients/scripts/smoke.sh` | COMPLETE | passing |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| All clients | Fetch API, WS hub, admin API | Available |
| Smoke script | All four clients | Available |

The four client tasks are mutually independent and parallelizable; the smoke script depends on
all of them.

## Completion Criteria

- [x] Every client builds/typechecks with its own toolchain
- [x] Every client's unit tests pass
- [x] Every client's `--help` documents the same command tree
- [x] `clients/scripts/smoke.sh` passes against a live server for all four
- [x] `clients/README.md` documents env vars, commands and library usage

## Progress Log

### Session: 2026-08-06

**Tasks Completed**: All five modules. Go (20 tests), Python (46 tests), Node (42 tests) and
Swift (33 tests) build and pass their unit suites; `clients/scripts/smoke.sh` drives all four
CLIs against a live server and passes.
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Dependency policy, verification depth and `webhooky`/`WEBHOOKY_*` naming were
confirmed with the user before implementation.

Two divergences the live smoke test caught, which the unit suites could not:

- The `--mark-fetched` flag was spelled three different ways across the clients. All four now
  take `--no-mark-fetched`, and the design document was corrected to match.
- The Swift CLI printed webhook payloads with unstable key order, because a payload decodes
  into a Swift dictionary. Its encoder now always sorts keys, so repeated calls are
  byte-identical.

## Related Plans

- **Depends On**: `impl-plans/completed/web-hooky-server.md`, `web-hooky-admin.md`,
  `web-hooky-relay.md`
