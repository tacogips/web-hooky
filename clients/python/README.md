# webhooky-client (Python)

Client library and `webhooky` CLI for a [web-hooky](https://github.com/tacogips/web-hooky)
server. Covers the three surfaces a consumer uses: reading stored records, streaming them over
WebSocket, and administration.

```bash
pip install -e .          # from clients/python
```

## Library

Credentials are passed explicitly - nothing here reads the environment - so one process can
hold several clients with different identities.

```python
from webhooky import FetchClient, AdminClient, StreamOptions

with FetchClient(
    base_url="https://hooks.example.com",
    api_key="key-id",
    api_secret="secret",
) as client:
    for record in client.records(fetch_uuid, only_unfetched=True, limit=50):
        print(record.t, record.payload)

    for record in client.stream(fetch_uuid, StreamOptions(reconnect=True)):
        print(record.payload)

with AdminClient(base_url="https://hooks.example.com", credential="id:secret") as admin:
    destination = admin.create_destination(
        name="wrike prod",
        vendor_addon="wrike",
        destination_addon="envelope",
        vendor_config={"secret": "wrike-webhook-secret"},
    )
    user = admin.create_api_user("reporting")   # user.secret is shown exactly once
    admin.grant_destination(user.id, destination.id)
```

`AsyncFetchClient` and `AsyncAdminClient` offer the same surface with `await` and an async
iterator for `stream`.

Failures raise `WebhookyError`, carrying `status`, `kind`, `message` and `details`. A
`status` of `0` means the request never reached the server.

## CLI

```bash
export WEBHOOKY_URL=https://hooks.example.com
export WEBHOOKY_API_KEY=... WEBHOOKY_API_SECRET=...
export WEBHOOKY_FETCH_UUID=...

webhooky records get --only-unfetched --limit 50
webhooky records stream | jq '.payload'

export WEBHOOKY_ADMIN_CREDENTIAL=id:secret
webhooky admin destinations list --pretty
webhooky admin users create --label reporting
```

Full environment variable and command reference: [`clients/README.md`](../README.md).
