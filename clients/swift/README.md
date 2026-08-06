# WebHooky (Swift)

Client library and `webhooky` CLI for a [web-hooky](https://github.com/tacogips/web-hooky)
server.

```swift
.package(url: "https://github.com/tacogips/web-hooky", from: "0.1.0")
```

## Library

Credentials are passed explicitly - nothing here reads the environment - so one process can
hold several clients with different identities.

```swift
import WebHooky

let client = try WebHookyFetchClient(
    config: FetchClientConfig(
        baseURL: "https://hooks.example.com",
        apiKey: "key-id",
        apiSecret: "secret"
    )
)

let records = try await client.records(
    fetchUUID: uuid,
    query: RecordQuery(onlyUnfetched: true, limit: 50)
)

for try await record in client.stream(
    fetchUUID: uuid,
    options: StreamOptions(reconnect: true)
) {
    print(record.t, record.payload)
}

let admin = try WebHookyAdminClient(
    config: AdminClientConfig(
        baseURL: "https://hooks.example.com",
        credential: "id:secret"
    )
)
let destination = try await admin.createDestination(
    CreateDestinationInput(name: "wrike prod", vendorAddon: "wrike")
)
```

Failures throw `WebhookyError`, carrying `status`, `kind`, `message` and `details`. A `status`
of `0` means the request never reached the server.

## CLI

```bash
swift build --product webhooky
export WEBHOOKY_URL=https://hooks.example.com
export WEBHOOKY_API_KEY=... WEBHOOKY_API_SECRET=... WEBHOOKY_FETCH_UUID=...

.build/debug/webhooky records get --only-unfetched --limit 50
.build/debug/webhooky records stream | jq '.payload'
```

On macOS with a Nix-provided SDK, clear the injected variables so SwiftPM uses the toolchain's
own SDK:

```bash
env -u SDKROOT -u DEVELOPER_DIR -u MACOSX_DEPLOYMENT_TARGET swift build
```

Full environment variable and command reference: [`clients/README.md`](../README.md).
