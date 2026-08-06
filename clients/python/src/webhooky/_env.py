"""Environment handling for the CLI.

This module is the only place in the client that reads the process
environment; the library takes its configuration as explicit parameters.
"""

from __future__ import annotations

import os
from typing import Final

from .config import DEFAULT_TIMEOUT_SECONDS

ENV_URL: Final = "WEBHOOKY_URL"
ENV_API_KEY: Final = "WEBHOOKY_API_KEY"
ENV_API_SECRET: Final = "WEBHOOKY_API_SECRET"
ENV_CREDENTIAL: Final = "WEBHOOKY_CREDENTIAL"
ENV_FETCH_UUID: Final = "WEBHOOKY_FETCH_UUID"
ENV_ADMIN_CREDENTIAL: Final = "WEBHOOKY_ADMIN_CREDENTIAL"
ENV_ADMIN_KEY: Final = "WEBHOOKY_ADMIN_KEY"
ENV_ADMIN_SECRET: Final = "WEBHOOKY_ADMIN_SECRET"
ENV_TIMEOUT: Final = "WEBHOOKY_TIMEOUT_SECONDS"
ENV_HEADERS: Final = "WEBHOOKY_HEADERS"

DEFAULT_BASE_URL: Final = "http://127.0.0.1:8787"


class UsageError(Exception):
    """The command was invoked incorrectly; exits with code 2."""


def _split_header(entry: str) -> tuple[str, str]:
    """Split ``name=value``.

    Only the first separator is significant: a value can itself contain ``=``,
    as a base64 proxy secret does.
    """
    name, separator, value = entry.partition("=")
    if not separator or not name.strip():
        raise UsageError(f'invalid header {entry!r}: expected "name=value"')
    return name.strip(), value.strip()


def resolve_headers(flag_values: list[str] | None) -> dict[str, str]:
    """Merge ``WEBHOOKY_HEADERS`` with repeated ``--header`` flags; flags win."""
    headers: dict[str, str] = {}
    for entry in (os.environ.get(ENV_HEADERS) or "").split(","):
        if entry.strip():
            name, value = _split_header(entry)
            headers[name] = value
    for entry in flag_values or []:
        name, value = _split_header(entry)
        headers[name] = value
    return headers


def resolve_base_url(flag_value: str | None) -> str:
    return flag_value or os.environ.get(ENV_URL) or DEFAULT_BASE_URL


def resolve_timeout(flag_value: float | None) -> float:
    if flag_value is not None and flag_value > 0:
        return flag_value
    raw = (os.environ.get(ENV_TIMEOUT) or "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        seconds = float(raw)
    except ValueError as exc:
        raise UsageError(f"{ENV_TIMEOUT} must be a positive number of seconds") from exc
    if seconds <= 0:
        raise UsageError(f"{ENV_TIMEOUT} must be a positive number of seconds")
    return seconds


def resolve_fetch_credentials() -> tuple[str, str]:
    """Read the fetch API user's key and secret, in either accepted form."""
    key = os.environ.get(ENV_API_KEY) or ""
    secret = os.environ.get(ENV_API_SECRET) or ""
    if not key and not secret:
        # The combined form is what the admin API hands out when a fetch API
        # user is created, so it is accepted verbatim.
        credential = os.environ.get(ENV_CREDENTIAL) or ""
        if credential:
            key, separator, secret = credential.partition(":")
            if not separator or not key or not secret:
                raise UsageError(f'{ENV_CREDENTIAL} must be "<keyId>:<secret>"')
    if not key or not secret:
        raise UsageError(
            f"missing fetch credentials: set {ENV_API_KEY} and {ENV_API_SECRET}, "
            f'or {ENV_CREDENTIAL}="<keyId>:<secret>"'
        )
    return key, secret


def resolve_admin_credential(headers: dict[str, str]) -> str:
    """Read the admin credential, which may be absent on the IdP path."""
    credential = os.environ.get(ENV_ADMIN_CREDENTIAL) or ""
    if not credential:
        key = os.environ.get(ENV_ADMIN_KEY) or ""
        secret = os.environ.get(ENV_ADMIN_SECRET) or ""
        if key and secret:
            credential = f"{key}:{secret}"
    if not credential and not headers:
        raise UsageError(
            f'missing admin credentials: set {ENV_ADMIN_CREDENTIAL}="<keyId>:<secret>" '
            f"(or {ENV_ADMIN_KEY} and {ENV_ADMIN_SECRET}), or pass "
            "identity-provider headers with --header"
        )
    return credential


def resolve_fetch_uuid(flag_value: str | None) -> str:
    uuid = flag_value or os.environ.get(ENV_FETCH_UUID) or ""
    if not uuid:
        raise UsageError(
            f"missing destination: pass --fetch-uuid or set {ENV_FETCH_UUID}"
        )
    return uuid
