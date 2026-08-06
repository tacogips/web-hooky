# webhooky (Go)

Client library and `webhooky` CLI for a [web-hooky](https://github.com/tacogips/web-hooky)
server.

```bash
go get github.com/tacogips/web-hooky/clients/go
go build -o webhooky ./cmd/webhooky
```

## Library

Credentials are passed explicitly - nothing here reads the environment - so one process can
hold several clients with different identities.

```go
client, err := webhooky.NewClient(webhooky.Config{
    BaseURL:   "https://hooks.example.com",
    APIKey:    "key-id",
    APISecret: "secret",
})
records, err := client.Records(ctx, fetchUUID, webhooky.RecordQuery{
    OnlyUnfetched: true,
    Limit:         50,
})

err = client.Stream(ctx, fetchUUID, webhooky.StreamOptions{Reconnect: true},
    func(record webhooky.Record) error {
        fmt.Println(record.T, string(record.Payload))
        return nil
    })

admin, err := webhooky.NewAdminClient(webhooky.Config{
    BaseURL:    "https://hooks.example.com",
    Credential: "id:secret",
})
destination, err := admin.CreateDestination(ctx, webhooky.CreateDestinationInput{
    Name:        "wrike prod",
    VendorAddon: "wrike",
})
```

Failures are `*webhooky.Error`, carrying `Status`, `Kind`, `Message` and `Details`. A `Status`
of `0` means the request never reached the server. `webhooky.IsNotFound`, `IsUnauthorized` and
`IsForbidden` cover the common branches.

## CLI

```bash
export WEBHOOKY_URL=https://hooks.example.com
export WEBHOOKY_API_KEY=... WEBHOOKY_API_SECRET=... WEBHOOKY_FETCH_UUID=...

webhooky records get --only-unfetched --limit 50
webhooky records stream | jq '.payload'

export WEBHOOKY_ADMIN_CREDENTIAL=id:secret
webhooky admin destinations list --pretty
```

Full environment variable and command reference: [`clients/README.md`](../README.md).
