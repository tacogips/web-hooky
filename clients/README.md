# web-hooky clients

Official clients for a [web-hooky](../README.md) server in **Swift**, **Python**, **Node** and
**Go**. Each one is a library first and a `webhooky` CLI second, and all four are held to the
same contract: the same capabilities, the same command names, the same environment variables,
the same error model. Learn one and you know all four.

Contract and rationale: [`design-docs/specs/clients.md`](../design-docs/specs/clients.md).

| Client | Path | Library | CLI |
|--------|------|---------|-----|
| Go | [`go/`](go) | `github.com/tacogips/web-hooky/clients/go/webhooky` | `go build ./cmd/webhooky` |
| Python | [`python/`](python) | `webhooky` | `webhooky` console script |
| Node | [`node/`](node) | `@web-hooky/client` | `bin/webhooky.js` |
| Swift | [`swift/`](swift) | `WebHooky` | `swift build --product webhooky` |

## What they cover

| Surface | Server route | Credential |
|---------|--------------|------------|
| **Read** | `GET /_get/{fetchUuid}` | fetch API user (`keyId` + `secret`) |
| **Stream** | `WS /_ws/{fetchUuid}` | fetch API user (`keyId` + `secret`) |
| **Admin** | `/_admin/api/**` | admin API key, or identity-provider headers |

Inbound webhook delivery (`POST /{vendorAddon}/{inboundUuid}`) is deliberately out of scope:
that request is made by the vendor, signed with the vendor's own scheme.

## Library versus CLI

> **Nothing in a client library reads the process environment.** Credentials, base URL,
> timeouts and extra headers arrive as explicit parameters. Only the CLI entry point reads
> `WEBHOOKY_*`, and it builds the very same configuration object a library caller would.

That is what makes an embedding testable, thread-safe, and able to hold several identities in
one process.

## Environment variables (CLI only)

| Variable | Used by | Default | Meaning |
|----------|---------|---------|---------|
| `WEBHOOKY_URL` | all | `http://127.0.0.1:8787` | Server base URL |
| `WEBHOOKY_API_KEY` | `records` | - | Fetch API user key id |
| `WEBHOOKY_API_SECRET` | `records` | - | Fetch API user secret |
| `WEBHOOKY_CREDENTIAL` | `records` | - | `<keyId>:<secret>`, instead of the pair above |
| `WEBHOOKY_FETCH_UUID` | `records` | - | Default `--fetch-uuid` |
| `WEBHOOKY_ADMIN_CREDENTIAL` | `admin` | - | `<keyId>:<secret>` admin API key |
| `WEBHOOKY_ADMIN_KEY` | `admin` | - | Admin key id, with `WEBHOOKY_ADMIN_SECRET` |
| `WEBHOOKY_ADMIN_SECRET` | `admin` | - | Admin key secret |
| `WEBHOOKY_TIMEOUT_SECONDS` | all | `30` | Per-request timeout |
| `WEBHOOKY_HEADERS` | all | - | Extra headers, `name=value` separated by `,` |

Precedence is **flag > environment > default**. No client ever prints a credential it was
given.

`WEBHOOKY_HEADERS` exists for the trusted-header admin path. Calling such a deployment
directly needs the identity header and the proxy shared secret:

```bash
export WEBHOOKY_HEADERS='cf-access-authenticated-user-email=ops@example.com,x-webhooky-proxy-secret=...'
```

## CLI

Identical in all four clients:

```
webhooky [global flags] <group> <command> [flags]

Global flags
  --url <url>              --timeout <seconds>
  --header <name=value>    repeatable
  --pretty                 --version   --help

records get      --fetch-uuid --only-unfetched --no-mark-fetched --from --to --limit
records stream   --fetch-uuid --reconnect --max-records --query-credentials

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

`--vendor-config` and `--destination-config` take inline JSON or `@path/to/file.json`.

**Output is JSON on stdout, always** - one document per command, `--pretty` to indent.
`records stream` writes newline-delimited JSON, one record per line, flushed as it arrives, so
it composes with `jq` and `head`. Diagnostics go to stderr.

| Exit code | Meaning |
|-----------|---------|
| `0` | success |
| `1` | the server returned an error, or the request failed |
| `2` | usage error: unknown command, missing flag, missing credentials |

```bash
export WEBHOOKY_URL=https://hooks.example.com
export WEBHOOKY_ADMIN_CREDENTIAL=admin-id:admin-secret

destination=$(webhooky admin destinations create \
  --name 'wrike prod' --vendor-addon wrike --destination-addon envelope \
  --vendor-config '{"secret":"wrike-webhook-secret"}')

user=$(webhooky admin users create --label reporting)   # its secret is shown once

export WEBHOOKY_CREDENTIAL=$(echo "$user" | jq -r .credential)
export WEBHOOKY_FETCH_UUID=$(echo "$destination" | jq -r .fetchUuid)

webhooky records get --only-unfetched --limit 50
webhooky records stream --reconnect | jq '.payload'
```

## Library usage

**Go**

```go
client, err := webhooky.NewClient(webhooky.Config{
    BaseURL: "https://hooks.example.com", APIKey: key, APISecret: secret,
})
records, err := client.Records(ctx, fetchUUID, webhooky.RecordQuery{OnlyUnfetched: true})

err = client.Stream(ctx, fetchUUID, webhooky.StreamOptions{Reconnect: true},
    func(record webhooky.Record) error { return handle(record) })

admin, err := webhooky.NewAdminClient(webhooky.Config{
    BaseURL: "https://hooks.example.com", Credential: "id:secret",
})
```

**Python**

```python
from webhooky import FetchClient, AdminClient, StreamOptions

with FetchClient(base_url=url, api_key=key, api_secret=secret) as client:
    for record in client.records(fetch_uuid, only_unfetched=True):
        print(record.t, record.payload)
    for record in client.stream(fetch_uuid, StreamOptions(reconnect=True)):
        handle(record)
```

`AsyncFetchClient` and `AsyncAdminClient` offer the same surface with `await`.

**Node**

```ts
import { WebhookyFetchClient, WebhookyAdminClient } from "@web-hooky/client";

const client = new WebhookyFetchClient({ baseUrl, apiKey, apiSecret });
const records = await client.records(fetchUuid, { onlyUnfetched: true });
for await (const record of client.stream(fetchUuid, { reconnect: true })) {
  handle(record);
}
```

**Swift**

```swift
let client = try WebHookyFetchClient(
    config: FetchClientConfig(baseURL: url, apiKey: key, apiSecret: secret))
let records = try await client.records(
    fetchUUID: uuid, query: RecordQuery(onlyUnfetched: true))
for try await record in client.stream(fetchUUID: uuid) { handle(record) }
```

Every client raises/returns one error type carrying `status`, `kind`, `message` and
`details`. A `status` of `0` means the request never reached the server, which is how you tell
a transport failure from a refusal.

## Streaming credentials

The server accepts handshake credentials as an `Authorization` header or as
`?api_key=&api_secret=` query parameters; the query form exists because browsers cannot set
headers on a WebSocket handshake. Query strings reach proxy access logs, so clients send the
header wherever their WebSocket implementation can set one:

| Client | Handshake credential | Reason |
|--------|----------------------|--------|
| Go | header | `coder/websocket` accepts `HTTPHeader` |
| Python | header | `websockets` accepts `additional_headers` |
| Swift | header | the task is built from a `URLRequest` |
| Node | query | the WHATWG `WebSocket` constructor takes no headers |

`--query-credentials` (Go, Python, Swift) forces the query form for a proxy that strips
`Authorization` from upgrade requests.

Reconnection is opt-in. A close with code `1008` means the credential or grant was revoked, so
it ends the stream even with `--reconnect`: retrying cannot fix it.

## Building and testing

```bash
# Go
cd clients/go && go build ./... && go test ./...

# Python
cd clients/python
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest

# Node (Bun for tests, plain Node 22+ for the built CLI)
cd clients/node && bun install && bun test && bunx tsc --noEmit && bun run build

# Swift
cd clients/swift && swift build && swift test
```

On macOS with a Nix-provided SDK, SwiftPM may pick an SDK older than the Xcode compiler.
Clear the injected variables for Swift commands:

```bash
env -u SDKROOT -u DEVELOPER_DIR -u MACOSX_DEPLOYMENT_TARGET swift build
```

### Cross-client live smoke test

```bash
clients/scripts/smoke.sh              # every client whose toolchain is present
clients/scripts/smoke.sh go node      # only the named clients
```

It boots a real server on a throwaway SQLite database, seeds an admin key, a destination, a
fetch API user and a grant, posts webhooks, and drives every client's CLI through read,
streaming and admin commands, comparing what each returns against the server. Unit tests can
pass while every client shares the same wrong assumption; this is what catches that. Clients
whose toolchain is missing are reported as skipped, not failed.
