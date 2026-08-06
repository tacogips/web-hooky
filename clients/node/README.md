# @web-hooky/client (Node)

Client library and `webhooky` CLI for a [web-hooky](https://github.com/tacogips/web-hooky)
server. No runtime dependencies: `fetch`, `WebSocket` and `parseArgs` are built into Node 22+
and Bun.

```bash
npm install @web-hooky/client
```

## Library

Credentials are passed explicitly - nothing here reads `process.env` - so one process can hold
several clients with different identities.

```ts
import { WebhookyFetchClient, WebhookyAdminClient } from "@web-hooky/client";

const client = new WebhookyFetchClient({
  baseUrl: "https://hooks.example.com",
  apiKey: "key-id",
  apiSecret: "secret",
});

const records = await client.records(fetchUuid, { onlyUnfetched: true, limit: 50 });

for await (const record of client.stream(fetchUuid, { reconnect: true })) {
  console.log(record.t, record.payload);
}

const admin = new WebhookyAdminClient({
  baseUrl: "https://hooks.example.com",
  credential: "id:secret",
});
const destination = await admin.createDestination({
  name: "wrike prod",
  vendorAddon: "wrike",
});
```

Failures throw `WebhookyError`, carrying `status`, `kind`, `message` and `details`. A `status`
of `0` means the request never reached the server.

## CLI

```bash
export WEBHOOKY_URL=https://hooks.example.com
export WEBHOOKY_API_KEY=... WEBHOOKY_API_SECRET=... WEBHOOKY_FETCH_UUID=...

webhooky records get --only-unfetched --limit 50
webhooky records stream | jq '.payload'
```

Full environment variable and command reference: [`clients/README.md`](../README.md).
