"""Dispatch for the ``webhooky admin ...`` command group."""

from __future__ import annotations

import argparse
from typing import Any

from ._clients import admin_client
from ._env import UsageError
from ._output import emit, json_arg
from .admin import AdminClient


def _patch_body(args: argparse.Namespace, fields: dict[str, str]) -> dict[str, Any]:
    """Collect only the flags the user actually typed.

    A patch must never reset a field the caller did not mention, so an argument
    left at its ``None`` default is omitted from the request entirely.
    """
    body: dict[str, Any] = {}
    for attribute, wire_name in fields.items():
        value = getattr(args, attribute, None)
        if value is not None:
            body[wire_name] = value
    return body


def _destinations(args: argparse.Namespace, client: AdminClient) -> None:
    action = args.action
    if action == "list":
        emit(client.list_destinations(), pretty=args.pretty)
    elif action == "get":
        emit(client.get_destination(args.id), pretty=args.pretty)
    elif action == "delete":
        client.delete_destination(args.id)
        emit({"deleted": args.id}, pretty=args.pretty)
    elif action == "rotate-fetch-uuid":
        emit(client.rotate_fetch_uuid(args.id), pretty=args.pretty)
    elif action == "records":
        emit(
            client.list_destination_records(args.id, args.limit), pretty=args.pretty
        )
    elif action == "create":
        emit(
            client.create_destination(
                name=args.name,
                vendor_addon=args.vendor_addon,
                destination_addon=args.destination_addon,
                vendor_config=json_arg(args.vendor_config, "vendor-config"),
                destination_config=json_arg(
                    args.destination_config, "destination-config"
                ),
                retention_seconds=args.retention_seconds,
            ),
            pretty=args.pretty,
        )
    elif action == "patch":
        body = _patch_body(
            args,
            {
                "name": "name",
                "enabled": "enabled",
                "destination_addon": "destinationAddon",
                "retention_seconds": "retentionSeconds",
            },
        )
        vendor_config = json_arg(args.vendor_config, "vendor-config")
        if vendor_config is not None:
            body["vendorConfig"] = vendor_config
        destination_config = json_arg(args.destination_config, "destination-config")
        if destination_config is not None:
            body["destinationConfig"] = destination_config
        emit(client.update_destination(args.id, body), pretty=args.pretty)
    else:
        raise UsageError("expected: list | get | create | patch | delete | rotate-fetch-uuid | records")


def _relays(args: argparse.Namespace, client: AdminClient) -> None:
    action = args.action
    if action == "list":
        emit(client.list_relays(args.destination_id), pretty=args.pretty)
    elif action == "get":
        emit(client.get_relay(args.id), pretty=args.pretty)
    elif action == "delete":
        client.delete_relay(args.id)
        emit({"deleted": args.id}, pretty=args.pretty)
    elif action == "deliveries":
        emit(client.list_relay_deliveries(args.id, args.limit), pretty=args.pretty)
    elif action == "retry":
        emit({"requeued": client.retry_relay(args.id)}, pretty=args.pretty)
    elif action == "create":
        emit(
            client.create_relay(
                destination_id=args.destination_id,
                name=args.name,
                target_url=args.target_url,
                secret=args.secret,
                max_attempts=args.max_attempts,
                backoff_seconds=args.backoff_seconds,
                timeout_seconds=args.timeout_seconds,
            ),
            pretty=args.pretty,
        )
    elif action == "patch":
        body = _patch_body(
            args,
            {
                "name": "name",
                "target_url": "targetUrl",
                "secret": "secret",
                "enabled": "enabled",
                "max_attempts": "maxAttempts",
                "backoff_seconds": "backoffSeconds",
                "timeout_seconds": "timeoutSeconds",
            },
        )
        emit(client.update_relay(args.id, body), pretty=args.pretty)
    else:
        raise UsageError("expected: list | get | create | patch | delete | deliveries | retry")


def _users(args: argparse.Namespace, client: AdminClient) -> None:
    action = args.action
    if action == "list":
        emit(client.list_api_users(), pretty=args.pretty)
    elif action == "get":
        emit(client.get_api_user(args.id), pretty=args.pretty)
    elif action == "create":
        # The secret appears here and nowhere else, ever.
        emit(client.create_api_user(args.label), pretty=args.pretty)
    elif action == "rotate":
        emit(client.rotate_api_user_secret(args.id), pretty=args.pretty)
    elif action in ("enable", "disable"):
        emit(
            client.set_api_user_enabled(args.id, action == "enable"),
            pretty=args.pretty,
        )
    elif action == "delete":
        client.delete_api_user(args.id)
        emit({"deleted": args.id}, pretty=args.pretty)
    elif action == "grant":
        emit(client.grant_destination(args.id, args.destination_id), pretty=args.pretty)
    elif action == "revoke":
        emit(
            client.revoke_destination(args.id, args.destination_id), pretty=args.pretty
        )
    else:
        raise UsageError(
            "expected: list | get | create | rotate | enable | disable | delete | grant | revoke"
        )


def _addons(args: argparse.Namespace, client: AdminClient) -> None:
    action = args.action
    if action == "list":
        emit(client.list_addons(), pretty=args.pretty)
    elif action == "get":
        emit(client.get_addon(args.name), pretty=args.pretty)
    elif action == "upload":
        try:
            with open(args.path, "rb") as handle:
                archive = handle.read()
        except OSError as exc:
            raise UsageError(f"failed to read {args.path}: {exc}") from exc
        import os.path

        emit(
            client.upload_addon(os.path.basename(args.path), archive),
            pretty=args.pretty,
        )
    elif action == "delete":
        client.delete_addon(args.name)
        emit({"deleted": args.name}, pretty=args.pretty)
    else:
        raise UsageError("expected: list | get | upload | delete")


def _keys(args: argparse.Namespace, client: AdminClient) -> None:
    action = args.action
    if action == "list":
        emit(client.list_admin_keys(), pretty=args.pretty)
    elif action == "create":
        emit(client.create_admin_key(args.label), pretty=args.pretty)
    elif action == "delete":
        client.delete_admin_key(args.id)
        emit({"deleted": args.id}, pretty=args.pretty)
    else:
        raise UsageError("expected: list | create | delete")


def _admin_users(args: argparse.Namespace, client: AdminClient) -> None:
    action = args.action
    if action == "list":
        emit(client.list_admin_users(), pretty=args.pretty)
    elif action == "create":
        emit(client.create_admin_user(args.subject), pretty=args.pretty)
    elif action == "delete":
        client.delete_admin_user(args.subject)
        emit({"deleted": args.subject}, pretty=args.pretty)
    else:
        raise UsageError("expected: list | create | delete")


_RESOURCES = {
    "destinations": _destinations,
    "relays": _relays,
    "users": _users,
    "addons": _addons,
    "keys": _keys,
    "admin-users": _admin_users,
}


def dispatch_admin(args: argparse.Namespace) -> None:
    """Run one ``webhooky admin ...`` command."""
    resource = getattr(args, "resource", None)
    if not resource:
        raise UsageError(
            "expected an admin resource: me, destinations, relays, users, addons, "
            "keys, admin-users"
        )

    with admin_client(args) as client:
        if resource == "me":
            emit(client.me(), pretty=args.pretty)
            return
        handler = _RESOURCES.get(resource)
        if handler is None:
            raise UsageError(f"unknown admin resource {resource!r}")
        if not getattr(args, "action", None):
            raise UsageError(f"expected an action for \"admin {resource}\"")
        handler(args, client)
