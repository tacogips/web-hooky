"""The argparse command tree for the ``webhooky`` CLI.

Kept separate from :mod:`webhooky.cli` so the command surface can be inspected
and tested without importing the execution paths.
"""

from __future__ import annotations

import argparse

from ._env import (
    ENV_ADMIN_CREDENTIAL,
    ENV_API_KEY,
    ENV_FETCH_UUID,
    ENV_HEADERS,
    ENV_TIMEOUT,
    ENV_URL,
)

EPILOG = f"""
environment:
  {ENV_URL}                 server base URL (default http://127.0.0.1:8787)
  {ENV_API_KEY}             fetch API user key id       (records)
  WEBHOOKY_API_SECRET          fetch API user secret       (records)
  WEBHOOKY_CREDENTIAL          "<keyId>:<secret>" instead of the pair above
  {ENV_FETCH_UUID}          default --fetch-uuid
  {ENV_ADMIN_CREDENTIAL}    "<keyId>:<secret>" admin API key   (admin)
  WEBHOOKY_ADMIN_KEY           admin key id                       (admin)
  WEBHOOKY_ADMIN_SECRET        admin key secret                   (admin)
  {ENV_TIMEOUT}     request timeout in seconds
  {ENV_HEADERS}             "name=value,name=value" extra headers

exit codes:
  0 success   1 request failed   2 usage error
"""


def _add_globals(parser: argparse.ArgumentParser) -> None:
    """Attach the flags every command accepts.

    They are registered on each subcommand too, so both ``webhooky --pretty
    records get`` and ``webhooky records get --pretty`` work; users should not
    have to remember which side of the verb a flag lives on.
    """
    parser.add_argument("--url", default=None, help=f"server base URL ({ENV_URL})")
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help=f"request timeout in seconds ({ENV_TIMEOUT})",
    )
    parser.add_argument(
        "--header",
        action="append",
        default=None,
        metavar="NAME=VALUE",
        help=f"extra request header; repeatable ({ENV_HEADERS})",
    )
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")


def _sub(parent: argparse._SubParsersAction, name: str, help_text: str):
    parser = parent.add_parser(name, help=help_text, description=help_text)
    _add_globals(parser)
    return parser


def _build_records(subparsers: argparse._SubParsersAction) -> None:
    records = _sub(subparsers, "records", "read and stream a destination's records")
    commands = records.add_subparsers(dest="records_command", metavar="<command>")

    get = _sub(commands, "get", "read stored records, newest first")
    get.add_argument(
        "--fetch-uuid", default=None, help=f"destination fetch uuid ({ENV_FETCH_UUID})"
    )
    get.add_argument(
        "--only-unfetched",
        action="store_true",
        help="return only records no reader has taken yet",
    )
    get.add_argument(
        "--no-mark-fetched",
        action="store_true",
        help="leave the returned records unmarked",
    )
    get.add_argument(
        "--from",
        dest="from_",
        default=None,
        help="lower time bound: unix seconds or ISO-8601",
    )
    get.add_argument(
        "--to", default=None, help="upper time bound: unix seconds or ISO-8601"
    )
    get.add_argument(
        "--limit", type=int, default=None, help="maximum records to return"
    )

    stream = _sub(
        commands, "stream", "stream records as newline-delimited JSON until interrupted"
    )
    stream.add_argument(
        "--fetch-uuid", default=None, help=f"destination fetch uuid ({ENV_FETCH_UUID})"
    )
    stream.add_argument(
        "--reconnect",
        action="store_true",
        help="reconnect with backoff after a transport failure",
    )
    stream.add_argument(
        "--max-records", type=int, default=0, help="stop after this many records"
    )
    stream.add_argument(
        "--query-credentials",
        action="store_true",
        help="send credentials as query parameters instead of a header",
    )


def _build_destinations(commands: argparse._SubParsersAction) -> None:
    destinations = _sub(commands, "destinations", "manage webhook destinations")
    actions = destinations.add_subparsers(dest="action", metavar="<action>")

    _sub(actions, "list", "list every destination")

    for name, help_text in (
        ("get", "show one destination"),
        ("delete", "delete a destination and its records"),
        ("rotate-fetch-uuid", "issue a new fetch uuid"),
    ):
        parser = _sub(actions, name, help_text)
        parser.add_argument("id", help="destination id")

    records = _sub(actions, "records", "read stored records without marking them")
    records.add_argument("id", help="destination id")
    records.add_argument("--limit", type=int, default=None, help="maximum records")

    create = _sub(actions, "create", "register a destination")
    create.add_argument("--name", required=True, help="destination name")
    create.add_argument("--vendor-addon", required=True, help="vendor addon name")
    create.add_argument("--destination-addon", default=None, help="destination addon")
    create.add_argument(
        "--vendor-config", default=None, help="inline JSON or @file.json"
    )
    create.add_argument(
        "--destination-config", default=None, help="inline JSON or @file.json"
    )
    create.add_argument("--retention-seconds", type=int, default=None)

    patch = _sub(actions, "patch", "update a destination")
    patch.add_argument("id", help="destination id")
    patch.add_argument("--name", default=None)
    patch.add_argument(
        "--enabled",
        dest="enabled",
        action="store_true",
        default=None,
        help="enable every public surface of this destination",
    )
    patch.add_argument(
        "--disabled",
        dest="enabled",
        action="store_false",
        help="disable the inbound route, /_get/ and /_ws/",
    )
    patch.add_argument("--destination-addon", default=None)
    patch.add_argument("--vendor-config", default=None, help="inline JSON or @file.json")
    patch.add_argument(
        "--destination-config", default=None, help="inline JSON or @file.json"
    )
    patch.add_argument("--retention-seconds", type=int, default=None)


def _build_relays(commands: argparse._SubParsersAction) -> None:
    relays = _sub(commands, "relays", "manage forwarding targets")
    actions = relays.add_subparsers(dest="action", metavar="<action>")

    listing = _sub(actions, "list", "list relays")
    listing.add_argument("--destination-id", default=None, help="narrow to one destination")

    for name, help_text in (
        ("get", "show one relay"),
        ("delete", "delete a relay"),
        ("retry", "requeue this relay's failed deliveries"),
    ):
        parser = _sub(actions, name, help_text)
        parser.add_argument("id", help="relay id")

    deliveries = _sub(actions, "deliveries", "list a relay's deliveries")
    deliveries.add_argument("id", help="relay id")
    deliveries.add_argument("--limit", type=int, default=None)

    create = _sub(actions, "create", "attach a forwarding target to a destination")
    create.add_argument("--destination-id", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--target-url", required=True, help="http(s) URL to forward to")
    create.add_argument("--secret", default=None, help="HMAC-SHA256 signing secret")
    create.add_argument("--max-attempts", type=int, default=None)
    create.add_argument("--backoff-seconds", type=int, default=None)
    create.add_argument(
        "--timeout-seconds",
        type=int,
        default=None,
        help="must stay below the server's delivery lease",
    )

    patch = _sub(actions, "patch", "update a relay")
    patch.add_argument("id", help="relay id")
    patch.add_argument("--name", default=None)
    patch.add_argument("--target-url", default=None)
    patch.add_argument("--secret", default=None, help="an empty value clears it")
    patch.add_argument(
        "--enabled", dest="enabled", action="store_true", default=None
    )
    patch.add_argument("--disabled", dest="enabled", action="store_false")
    patch.add_argument("--max-attempts", type=int, default=None)
    patch.add_argument("--backoff-seconds", type=int, default=None)
    patch.add_argument("--timeout-seconds", type=int, default=None)


def _build_users(commands: argparse._SubParsersAction) -> None:
    users = _sub(commands, "users", "manage fetch API users and their grants")
    actions = users.add_subparsers(dest="action", metavar="<action>")

    _sub(actions, "list", "list every fetch API user")

    for name, help_text in (
        ("get", "show one fetch API user"),
        ("rotate", "issue a new secret"),
        ("enable", "enable a fetch API user"),
        ("disable", "disable a fetch API user"),
        ("delete", "delete a fetch API user"),
    ):
        parser = _sub(actions, name, help_text)
        parser.add_argument("id", help="fetch API user id")

    create = _sub(actions, "create", "mint a key/secret pair")
    create.add_argument("--label", required=True, help="human-readable label")

    for name, help_text in (
        ("grant", "authorize a user to read a destination"),
        ("revoke", "withdraw a grant"),
    ):
        parser = _sub(actions, name, help_text)
        parser.add_argument("id", help="fetch API user id")
        parser.add_argument("destination_id", help="destination id")


def _build_addons_and_keys(commands: argparse._SubParsersAction) -> None:
    addons = _sub(commands, "addons", "manage vendor and destination addons")
    addon_actions = addons.add_subparsers(dest="action", metavar="<action>")
    _sub(addon_actions, "list", "list registered addons")
    for name, help_text in (
        ("get", "show one addon"),
        ("delete", "remove an installed addon"),
    ):
        parser = _sub(addon_actions, name, help_text)
        parser.add_argument("name", help="addon name")
    upload = _sub(addon_actions, "upload", "install an addon package")
    upload.add_argument("path", help="path to the zip archive")

    keys = _sub(commands, "keys", "manage admin API keys")
    key_actions = keys.add_subparsers(dest="action", metavar="<action>")
    _sub(key_actions, "list", "list admin API keys")
    create_key = _sub(key_actions, "create", "mint an admin API key")
    create_key.add_argument("--label", required=True)
    delete_key = _sub(key_actions, "delete", "revoke an admin API key")
    delete_key.add_argument("id", help="admin key id")

    admin_users = _sub(commands, "admin-users", "manage identity-provider subjects")
    admin_user_actions = admin_users.add_subparsers(dest="action", metavar="<action>")
    _sub(admin_user_actions, "list", "list admin subjects")
    for name, help_text in (
        ("create", "admit a subject"),
        ("delete", "remove a subject"),
    ):
        parser = _sub(admin_user_actions, name, help_text)
        parser.add_argument("subject", help="identity-provider subject")


def build_parser() -> argparse.ArgumentParser:
    """Build the full command tree."""
    parser = argparse.ArgumentParser(
        prog="webhooky",
        description="Client for a web-hooky server. Output is JSON on stdout.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    _add_globals(parser)
    parser.add_argument(
        "--version", action="store_true", help="print the client version and exit"
    )

    subparsers = parser.add_subparsers(dest="group", metavar="<group>")
    _build_records(subparsers)

    admin = _sub(subparsers, "admin", "administer the server")
    commands = admin.add_subparsers(dest="resource", metavar="<resource>")
    _sub(commands, "me", "show the identity the server resolved")
    _build_destinations(commands)
    _build_relays(commands)
    _build_users(commands)
    _build_addons_and_keys(commands)

    return parser
