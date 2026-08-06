# Command Design

This document describes CLI command interface design specifications.

## Overview

`web-hooky` ships a single executable entry point (`src/main.ts`) that starts the HTTP +
WebSocket server. Configuration comes from environment variables; every variable has a CLI
flag equivalent, and flags win over the environment.

---

## Sections

### Subcommands

There is a single command (the server). Behaviour is selected through flags.

```bash
bun run start -- [flags]
bun run dev                     # watch mode
```

### Flags and Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--host <host>` | string | `127.0.0.1` | Bind address |
| `--port <port>` | number | `8787` | Bind port |
| `--db <path>` | string | `./data/web-hooky.sqlite` | SQLite file, or `:memory:` |
| `--retention <seconds>` | number | `2592000` | Record and finished-delivery TTL; `0` disables deletion |
| `--sweep-interval <seconds>` | number | `300` | Retention sweeper period |
| `--addons-dir <path>` | string | `./data/addons` | Where uploaded addon packages are unpacked |
| `--admin-ui-dir <path>` | string | `./dist/admin-ui` | Built SolidJS assets served at `/_admin/` |
| `--admin-subjects <csv>` | string | (empty) | Seed IdP subjects allowed into the admin surface |
| `--admin-auth <mode>` | enum | `trusted-header` | `trusted-header` \| `dev` \| `disabled` |
| `--admin-auth-header <name>` | string | `cf-access-authenticated-user-email` | Identity header injected by the IdP proxy |
| `--admin-auth-shared-secret <value>` | string | (unset) | Proxy shared secret; set whenever the origin is directly reachable |
| `--admin-auth-shared-secret-header <name>` | string | `x-webhooky-proxy-secret` | Header carrying the proxy shared secret |
| `--admin-dev-subject <subject>` | string | `dev@localhost` | Identity used by the `dev` provider |
| `--admin-allowed-origins <csv>` | string | (empty) | Extra origins accepted for IdP-authenticated admin writes |
| `--bootstrap-admin-key <id:secret>` | string | (unset) | Seeds an admin API key on startup |
| `--max-body-bytes <n>` | number | `1048576` | Inbound webhook body cap |
| `--default-limit <n>` | number | `100` | `_get` default `limit` |
| `--max-limit <n>` | number | `1000` | `_get` `limit` ceiling |
| `--cache-ttl <seconds>` | number | `30` | Hot-lookup cache TTL |
| `--ws-max-buffered-bytes <n>` | number | `1048576` | Per-subscriber WebSocket send-buffer ceiling |
| `--relay-interval <seconds>` | number | `5` | Relay worker poll period; `0` disables the in-process timer |
| `--relay-batch <n>` | number | `20` | Deliveries claimed per poll |
| `--relay-max-backoff <seconds>` | number | `3600` | Retry backoff ceiling |
| `--relay-lease <seconds>` | number | `300` | Claim lease; must exceed the largest relay timeout |
| `--relay-park <seconds>` | number | `300` | Recheck period for deliveries of a disabled relay |
| `--relay-max-attempts <n>` | number | `5` | Default attempt budget for a new relay |
| `--relay-backoff <seconds>` | number | `10` | Default backoff base for a new relay |
| `--relay-timeout <seconds>` | number | `10` | Default request timeout for a new relay |
| `--help` | flag | - | Print usage and exit |

`--admin-auth disabled` rejects all IdP-derived identities; only admin API keys work. Use it
when the deployment is automation-only.

**`--admin-auth trusted-header` (the default) trusts `--admin-auth-header` unconditionally.**
Whoever can reach the origin directly can send that header with a seeded admin subject and
gets full `/_admin/api` access. It is only safe when the origin is reachable exclusively
through the IdP proxy that injects the header - which the `127.0.0.1` default bind address
provides locally, and nothing provides once `--host` is widened. Whenever the origin can be
reached directly, set `--admin-auth-shared-secret`
(`WEBHOOKY_ADMIN_AUTH_SHARED_SECRET`) so the proxy must present a secret the caller does not
have, or switch to `--admin-auth disabled`. The server prints a startup warning when it is
bound to a non-loopback address in `trusted-header` mode without a shared secret.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBHOOKY_HOST` | no | `127.0.0.1` | Bind address |
| `WEBHOOKY_PORT` | no | `8787` | Bind port |
| `WEBHOOKY_DB_PATH` | no | `./data/web-hooky.sqlite` | SQLite path or `:memory:` |
| `WEBHOOKY_RETENTION_SECONDS` | no | `2592000` | Record and finished-delivery TTL, `0` disables |
| `WEBHOOKY_RETENTION_SWEEP_INTERVAL_SECONDS` | no | `300` | Sweeper period |
| `WEBHOOKY_ADDONS_DIR` | no | `./data/addons` | Installed addon root |
| `WEBHOOKY_ADMIN_UI_DIR` | no | `./dist/admin-ui` | Built admin UI assets |
| `WEBHOOKY_ADMIN_SUBJECTS` | no | (empty) | Comma-separated seed admin subjects |
| `WEBHOOKY_ADMIN_AUTH` | no | `trusted-header` | Admin IdP provider mode; `trusted-header` trusts the identity header unconditionally (see the warning above) |
| `WEBHOOKY_ADMIN_AUTH_HEADER` | no | `cf-access-authenticated-user-email` | Identity header; spoofable by anyone who can reach the origin directly |
| `WEBHOOKY_ADMIN_AUTH_SHARED_SECRET` | no | (unset) | Proxy shared secret value; set it whenever the origin is directly reachable |
| `WEBHOOKY_ADMIN_AUTH_SHARED_SECRET_HEADER` | no | `x-webhooky-proxy-secret` | Proxy shared secret header |
| `WEBHOOKY_ADMIN_DEV_SUBJECT` | no | `dev@localhost` | Identity used by the `dev` provider |
| `WEBHOOKY_ADMIN_BOOTSTRAP_KEY` | no | (unset) | `keyId:secret` seeded at startup |
| `WEBHOOKY_MAX_BODY_BYTES` | no | `1048576` | Inbound body cap |
| `WEBHOOKY_DEFAULT_FETCH_LIMIT` | no | `100` | `_get` default limit |
| `WEBHOOKY_MAX_FETCH_LIMIT` | no | `1000` | `_get` limit ceiling |
| `WEBHOOKY_ADMIN_ALLOWED_ORIGINS` | no | (empty) | Comma-separated extra origins for admin writes |
| `WEBHOOKY_CACHE_TTL_SECONDS` | no | `30` | Hot-lookup cache TTL |
| `WEBHOOKY_WS_MAX_BUFFERED_BYTES` | no | `1048576` | Per-subscriber WebSocket send-buffer ceiling |
| `WEBHOOKY_RELAY_POLL_INTERVAL_SECONDS` | no | `5` | Relay worker period, `0` disables |
| `WEBHOOKY_RELAY_BATCH_SIZE` | no | `20` | Deliveries claimed per poll |
| `WEBHOOKY_RELAY_MAX_BACKOFF_SECONDS` | no | `3600` | Retry backoff ceiling |
| `WEBHOOKY_RELAY_LEASE_SECONDS` | no | `300` | Claim lease for an in-flight delivery; must exceed every relay timeout |
| `WEBHOOKY_RELAY_PARK_SECONDS` | no | `300` | Recheck period while a relay is disabled |
| `WEBHOOKY_RELAY_MAX_ATTEMPTS` | no | `5` | Default attempts per relay |
| `WEBHOOKY_RELAY_BACKOFF_SECONDS` | no | `10` | Default relay backoff base |
| `WEBHOOKY_RELAY_TIMEOUT_SECONDS` | no | `10` | Default relay request timeout; startup fails if it reaches the lease |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean shutdown (SIGINT/SIGTERM) or `--help` |
| 1 | Configuration error or startup failure |

### Development Tasks

```bash
bun test              # unit + integration tests (bun:test)
bun run typecheck     # tsc --noEmit
bun run lint:biome    # biome check . --diagnostic-level=warn
bun run build:ui      # bundle the SolidJS admin UI into dist/admin-ui
bun run build         # server bundle + admin UI
task ci               # lint + format check + typecheck + test + build
```

---
