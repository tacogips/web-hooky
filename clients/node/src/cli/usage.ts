/**
 * The `--help` text.
 *
 * Kept in its own module so the command tree it documents is easy to diff
 * against the other clients, which offer the same commands.
 */
export const USAGE = `webhooky - client for a web-hooky server

Usage:
  webhooky [flags] <group> <command> [flags]

Global flags:
  --url <url>            server base URL (WEBHOOKY_URL, default http://127.0.0.1:8787)
  --timeout <seconds>    request timeout (WEBHOOKY_TIMEOUT_SECONDS, default 30)
  --header <name=value>  extra request header; repeatable (WEBHOOKY_HEADERS)
  --pretty               indent JSON output
  --version              print the client version
  --help                 print this help

Commands:
  records get       --fetch-uuid --only-unfetched --no-mark-fetched --from --to --limit
  records stream    --fetch-uuid --reconnect --max-records
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

Create and patch flags:
  --name --vendor-addon --destination-addon --retention-seconds
  --vendor-config --destination-config   inline JSON or @file.json
  --destination-id --target-url --secret --max-attempts --backoff-seconds --timeout-seconds
  --enabled true|false

Environment:
  WEBHOOKY_URL                 server base URL
  WEBHOOKY_API_KEY             fetch API user key id       (records)
  WEBHOOKY_API_SECRET          fetch API user secret       (records)
  WEBHOOKY_CREDENTIAL          "<keyId>:<secret>" instead of the pair above
  WEBHOOKY_FETCH_UUID          default --fetch-uuid
  WEBHOOKY_ADMIN_CREDENTIAL    "<keyId>:<secret>" admin API key   (admin)
  WEBHOOKY_ADMIN_KEY           admin key id                       (admin)
  WEBHOOKY_ADMIN_SECRET        admin key secret                   (admin)
  WEBHOOKY_TIMEOUT_SECONDS     request timeout in seconds
  WEBHOOKY_HEADERS             "name=value,name=value" extra headers

Exit codes:
  0 success   1 request failed   2 usage error
`;
