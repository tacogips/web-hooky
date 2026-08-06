"""Building clients from parsed CLI arguments and the environment."""

from __future__ import annotations

import argparse

from ._env import (
    resolve_admin_credential,
    resolve_base_url,
    resolve_fetch_credentials,
    resolve_headers,
    resolve_timeout,
)
from .admin import AdminClient
from .config import VERSION
from .fetch import FetchClient

USER_AGENT = f"webhooky-python-cli/{VERSION}"


def fetch_client(args: argparse.Namespace) -> FetchClient:
    key, secret = resolve_fetch_credentials()
    return FetchClient(
        base_url=resolve_base_url(args.url),
        api_key=key,
        api_secret=secret,
        timeout_seconds=resolve_timeout(args.timeout),
        headers=resolve_headers(args.header),
        user_agent=USER_AGENT,
    )


def admin_client(args: argparse.Namespace) -> AdminClient:
    # The credential may be absent: a deployment fronted by an identity-provider
    # proxy authenticates through headers instead, which --header supplies.
    headers = resolve_headers(args.header)
    return AdminClient(
        base_url=resolve_base_url(args.url),
        credential=resolve_admin_credential(headers) or None,
        timeout_seconds=resolve_timeout(args.timeout),
        headers=headers,
        user_agent=USER_AGENT,
    )
