# Client Design

This document specifies the official web-hooky client libraries and their command line
interfaces. Four implementations exist - Swift, Python, Node, Go - and they are held to one
contract: the same capabilities, the same command names, the same environment variables, the
same error model. A user who learns one client knows all four.

Server surfaces they cover are defined in [architecture.md](./architecture.md); the server's
own configuration is in [command.md](./command.md).

---

## Sections

### 1. Scope

Each client covers three surfaces.

| Surface | Server route | Credential |
|---------|--------------|------------|
| **Read** | `GET /_get/{fetchUuid}` | fetch API user (`keyId` + `secret`) |
| **Stream** | `WS /_ws/{fetchUuid}` | fetch API user (`keyId` + `secret`) |
| **Admin** | `/_admin/api/**` | admin API key (`keyId` + `secret`) or IdP headers |

Inbound webhook delivery (`POST /{vendorAddon}/{inboundUuid}`) is deliberately **out of
scope**: that request is made by the vendor, signed with the vendor's own scheme, and is not
something a consumer of this server performs.

### 2. Dual use: library and CLI

Every client is a library first and a CLI second. The CLI is a thin argument parser plus an
output formatter over the same public functions a library consumer calls.

The rule that keeps them honest:

> **Nothing in the library reads the process environment.** Credentials, base URL, timeouts
> and extra headers arrive as explicit constructor/function parameters. Only the CLI entry
> point reads environment variables, and it does so in exactly one place, producing the same
> config object a library caller would build by hand.

This makes a library embedding testable, thread-safe, and usable with several different
credentials in one process - none of which holds if configuration is ambient.

### 3. Configuration

Two client types, because they authenticate differently and are usually held by different
parties.

```
FetchConfig
  baseUrl         required   e.g. "https://hooks.example.com"
  apiKey          required   fetch API user key id
  apiSecret       required   fetch API user secret
  timeoutSeconds  default 30
  headers         default {} extra request headers
  userAgent       default "webhooky-<lang>/<version>"

AdminConfig
  baseUrl         required
  credential      optional   "<keyId>:<secret>"; omit when authenticating through an IdP proxy
  timeoutSeconds  default 30
  headers         default {} extra request headers (IdP identity header, proxy shared secret)
  userAgent       default "webhooky-<lang>/<version>"
```

`baseUrl` is normalized by stripping trailing slashes. A `ws://` or `wss://` base URL is
accepted and mapped to `http://`/`https://` for HTTP calls; the reverse mapping produces the
stream URL. `fetchUuid` is a per-call parameter, not part of the config, because one fetch API
user may be granted several destinations.

### 4. Environment variables (CLI only)

| Variable | Used by | Default | Meaning |
|----------|---------|---------|---------|
| `WEBHOOKY_URL` | all | `http://127.0.0.1:8787` | Server base URL |
| `WEBHOOKY_API_KEY` | `records` | (unset) | Fetch API user key id |
| `WEBHOOKY_API_SECRET` | `records` | (unset) | Fetch API user secret |
| `WEBHOOKY_CREDENTIAL` | `records` | (unset) | `<keyId>:<secret>`; alternative to the pair above |
| `WEBHOOKY_FETCH_UUID` | `records` | (unset) | Default `--fetch-uuid` |
| `WEBHOOKY_ADMIN_CREDENTIAL` | `admin` | (unset) | `<keyId>:<secret>` admin API key |
| `WEBHOOKY_ADMIN_KEY` | `admin` | (unset) | Admin key id; used with `WEBHOOKY_ADMIN_SECRET` |
| `WEBHOOKY_ADMIN_SECRET` | `admin` | (unset) | Admin key secret |
| `WEBHOOKY_TIMEOUT_SECONDS` | all | `30` | Request timeout |
| `WEBHOOKY_HEADERS` | all | (unset) | Extra headers, `name=value` separated by `,` |

Precedence is **flag > environment > default**. Secrets are accepted from the environment and
never echoed: no client prints a credential it was given, and `--help` output shows variable
names only.

`WEBHOOKY_HEADERS` exists for the trusted-header admin path, where an IdP proxy normally
injects the identity. Calling such a deployment directly requires sending both the identity
header and the proxy shared secret:

```bash
WEBHOOKY_HEADERS='cf-access-authenticated-user-email=ops@example.com,x-webhooky-proxy-secret=...'
```

### 5. Authentication mechanics

**HTTP.** `Authorization: Bearer <keyId>:<secret>` on every request. The server also accepts
`X-Api-Key`/`X-Api-Secret`, but clients use the bearer form only, so there is one code path.

**WebSocket.** The server accepts credentials on the handshake either as an `Authorization`
header or as `?api_key=&api_secret=` query parameters; the query form exists because browsers
cannot set headers on a WebSocket handshake. Query strings leak into proxy and server access
logs, so **clients send the header whenever their WebSocket implementation can set one** and
fall back to query parameters only where it cannot:

| Client | Handshake credential | Reason |
|--------|----------------------|--------|
| Go | header | `coder/websocket` accepts `HTTPHeader` |
| Python | header | `websockets` accepts `additional_headers` |
| Swift | header | the task is built from a `URLRequest` |
| Node | query | the WHATWG `WebSocket` constructor takes no headers |

A `useQueryCredentials` option forces the query form everywhere, for deployments whose proxy
strips `Authorization` from upgrade requests.

**CSRF.** Admin API keys bypass the server's CSRF check, but the IdP path does not: a
state-changing request must carry either a matching `Origin` or `content-type:
application/json`. Clients therefore send `content-type: application/json` on **every**
state-changing admin request, including the ones with no body (`POST .../rotate`, `PUT
.../grants/...`, every `DELETE`), and set `Origin` to the base URL's origin on the multipart
addon upload, which cannot use that content type. This costs nothing on the API-key path and
makes the IdP path work without further configuration.

### 6. Error model

One error type per client, carrying everything the caller needs to branch:

```
WebhookyError
  status   int      HTTP status; 0 for a transport or protocol failure
  kind     string   server error kind ("bad_request", "unauthorized", ... ); "" if absent
  message  string   server message, or the transport failure description
  details  json     optional machine-readable detail from the server
```

The server renders failures as `{"error": {"kind", "message", "details"?}}`, so clients parse
that envelope; a non-2xx response whose body is not that shape yields `kind: ""` and a message
naming the status. Error kinds and their statuses are fixed by the server
(`bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
`method_not_allowed` 405, `conflict` 409, `payload_too_large` 413,
`unprocessable_entity` 422, `not_implemented` 501, `internal` 500).

Languages surface this idiomatically - Go returns `*webhooky.Error` from `errors.As`, Python
raises `WebhookyError`, Swift throws `WebhookyError`, Node throws `WebhookyError` - but the
four fields are identical everywhere.

### 7. Library API

Names are adapted to each language's casing convention; the shape does not change.

**Fetch client**

```
FetchClient(config)
  fetchRecords(fetchUuid, query) -> [Record]
  stream(fetchUuid, options) -> stream of Record       # blocking loop / async iterator
```

```
RecordQuery
  onlyUnfetched  bool   default false   -> only_unfetched
  markFetched    bool   default true    -> mark_fetched
  from           time   optional        -> from   (unix seconds or ISO-8601)
  to             time   optional        -> to
  limit          int    optional        -> limit  (server caps at max-limit)

Record
  t        int64   receipt time, unix seconds
  fetched  bool    state *before* this call marked it
  payload  json
```

Query parameters are only emitted when they differ from the server's default, so a plain
`fetchRecords(uuid, {})` sends a bare URL.

**Stream client.** The stream yields `Record` values decoded from
`{"type":"record","record":{...}}` frames; the `{"type":"ready"}` frame that the server sends
on open is surfaced as an optional `onReady` callback rather than a record. Reconnection is
**opt-in** (`reconnect: true`, capped exponential backoff): a socket closed with code `1008`
means the credential or grant was revoked, and silently reconnecting on that would hammer a
server that has already said no - so `1008` ends the stream even when reconnection is enabled.

**Admin client.** One method per admin endpoint:

```
AdminClient(config)
  me()

  listDestinations()                          getDestination(id)
  createDestination(input)                    updateDestination(id, patch)
  deleteDestination(id)                       rotateFetchUuid(id)
  listDestinationRecords(id, limit)

  listRelays(destinationId?)                  getRelay(id)
  createRelay(input)                          updateRelay(id, patch)
  deleteRelay(id)                             listRelayDeliveries(id, limit)
  retryRelay(id)

  listApiUsers()                              getApiUser(id)
  createApiUser(label)                        rotateApiUserSecret(id)
  setApiUserEnabled(id, enabled)              deleteApiUser(id)
  grantDestination(userId, destinationId)     revokeDestination(userId, destinationId)

  listAddons()                                getAddon(name)
  uploadAddon(fileName, bytes)                deleteAddon(name)

  listAdminKeys()                             createAdminKey(label)
  deleteAdminKey(id)

  listAdminUsers()                            createAdminUser(subject)
  deleteAdminUser(subject)
```

List endpoints unwrap the server's envelope (`{"destinations": [...]}` becomes a plain array),
because the wrapper carries no information a typed client needs.

Responses are decoded into typed models: `Destination`, `ApiUser`, `CreatedApiUser`, `Relay`,
`RelayDelivery`, `RelayDeliveryStats`, `Addon`, `AdminKey`, `CreatedAdminKey`, `AdminUser`,
`AdminIdentity`. Secrets that the server returns exactly once (`secret`, `credential` on
creation and rotation) are present on the `Created*` types only, so a caller cannot mistake a
listing for something that carries a secret.

### 8. CLI

```
webhooky [global flags] <group> <command> [flags]

Global flags
  --url <url>              WEBHOOKY_URL
  --timeout <seconds>      WEBHOOKY_TIMEOUT_SECONDS
  --header <name=value>    repeatable; merged over WEBHOOKY_HEADERS
  --pretty                 indent JSON output
  --version, --help

records
  get      --fetch-uuid --only-unfetched --no-mark-fetched --from --to --limit
  stream   --fetch-uuid --reconnect --max-records --query-credentials

admin me
admin destinations   list | get <id> | create | patch <id> | delete <id> |
                     rotate-fetch-uuid <id> | records <id> [--limit]
admin relays         list [--destination-id] | get <id> | create | patch <id> |
                     delete <id> | deliveries <id> [--limit] | retry <id>
admin users          list | get <id> | create --label | rotate <id> |
                     enable <id> | disable <id> | delete <id> |
                     grant <id> <destinationId> | revoke <id> <destinationId>
admin addons         list | get <name> | upload <file.zip> | delete <name>
admin keys           list | create --label | delete <id>
admin admin-users    list | create <subject> | delete <subject>
```

`create` and `patch` for destinations and relays take typed flags
(`--name`, `--vendor-addon`, `--target-url`, `--max-attempts`, ...) plus `--vendor-config`
and `--destination-config`, which accept inline JSON or `@path/to/file.json`.

**Output is JSON on stdout, always.** One object or array per command, `--pretty` for
indentation; `records stream` writes newline-delimited JSON, one record per line, flushed as
it arrives so it composes with `jq`. Diagnostics go to stderr. Exit codes:

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | server returned an error, or a transport failure |
| `2` | usage error (unknown command, missing required flag, missing credentials) |

Mapping the whole error space onto `1` and usage onto `2` follows the convention scripts
already expect; the JSON error object on stderr carries the detail.

### 9. Layout

```
clients/
  README.md
  go/       go.mod, webhooky/*.go, cmd/webhooky/*.go, webhooky/*_test.go
  python/   pyproject.toml, src/webhooky/*.py, tests/*.py
  node/     package.json, tsconfig.json, src/*.ts, test/*.test.ts
  swift/    Package.swift, Sources/WebHooky, Sources/webhooky-cli, Tests/WebHookyTests
  scripts/  smoke.sh
```

Each client is an independent package with its own build and its own dependency set; nothing
under `clients/` is part of the server build, and the repository's root `tsconfig.json` and
`biome.json` do not reach into `clients/node`, which carries its own.

### 10. Dependencies

Idiomatic per language, minimal in count.

| Client | HTTP | WebSocket | CLI |
|--------|------|-----------|-----|
| Go | `net/http` | `github.com/coder/websocket` | `flag` |
| Python | `httpx` | `websockets` | `argparse` |
| Node | built-in `fetch` | built-in `WebSocket` | `node:util parseArgs` |
| Swift | `URLSession` | `URLSessionWebSocketTask` | `swift-argument-parser` |

Node needs no runtime dependency at all: `fetch`, `WebSocket` and `parseArgs` are all
built in on Node 22+ and on Bun.

### 11. Testing

- **Unit tests** per client, against an in-process stub HTTP server, covering URL and query
  construction, the bearer header, response decoding, the error envelope, and the WebSocket
  frame decoding.
- **`clients/scripts/smoke.sh`** boots a real server with a temporary SQLite database, seeds
  an admin key, a destination, a fetch API user and a grant, posts a webhook, and then drives
  every client's CLI through read, stream and admin commands, comparing the JSON they return.
  This is what catches a client that unit-tests green against its own assumptions.
