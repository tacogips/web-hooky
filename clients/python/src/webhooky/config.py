"""Client configuration and URL normalization.

Nothing here reads the process environment: a library caller passes credentials
explicitly, so one process can hold several clients with different identities.
Only :mod:`webhooky.cli` consults ``WEBHOOKY_*`` variables.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final
from urllib.parse import urlsplit

from .errors import WebhookyError

VERSION: Final = "0.1.0"
DEFAULT_TIMEOUT_SECONDS: Final = 30.0
DEFAULT_USER_AGENT: Final = f"webhooky-python/{VERSION}"

_HTTP_SCHEMES: Final = {"http": ("http", "ws"), "ws": ("http", "ws")}
_SECURE_SCHEMES: Final = {"https": ("https", "wss"), "wss": ("https", "wss")}


@dataclass(frozen=True)
class BaseUrls:
    """The http and ws forms of one server base URL."""

    http: str
    ws: str


def normalize_base_url(raw: str) -> BaseUrls:
    """Parse a base URL into its http and ws forms.

    A ``ws://`` base URL is accepted and mapped to ``http://``; accepting both
    here saves every caller from remembering which scheme a given surface wants.
    """
    trimmed = (raw or "").strip().rstrip("/")
    if not trimmed:
        raise WebhookyError("base_url is required")

    parts = urlsplit(trimmed)
    if not parts.netloc:
        raise WebhookyError(f"base_url {raw!r} has no host")

    schemes = _HTTP_SCHEMES.get(parts.scheme) or _SECURE_SCHEMES.get(parts.scheme)
    if schemes is None:
        raise WebhookyError(
            f"base_url scheme {parts.scheme!r} must be http, https, ws or wss"
        )

    http_scheme, ws_scheme = schemes
    path = parts.path.rstrip("/")
    return BaseUrls(
        http=f"{http_scheme}://{parts.netloc}{path}",
        ws=f"{ws_scheme}://{parts.netloc}{path}",
    )


@dataclass(frozen=True)
class ClientConfig:
    """Resolved configuration shared by every client."""

    urls: BaseUrls
    authorization: str
    headers: dict[str, str] = field(default_factory=dict)
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    user_agent: str = DEFAULT_USER_AGENT

    def request_headers(self, *, content_type: str | None = None) -> dict[str, str]:
        """Build the header set for one request.

        Caller-supplied headers never override the ones this client owns: an
        Authorization header set through ``headers`` would silently defeat the
        credentials the caller passed explicitly.
        """
        headers = dict(self.headers)
        headers["accept"] = "application/json"
        headers["user-agent"] = self.user_agent
        if self.authorization:
            headers["authorization"] = self.authorization
        if content_type is not None:
            headers["content-type"] = content_type
        return headers


def bearer_from_pair(key_id: str, secret: str) -> str:
    """Build the Authorization value for a key/secret pair."""
    return f"Bearer {key_id}:{secret}"


def split_credential(credential: str) -> tuple[str, str]:
    """Split ``"<keyId>:<secret>"`` into its two halves."""
    trimmed = (credential or "").strip()
    key_id, separator, secret = trimmed.partition(":")
    if not separator or not key_id or not secret:
        raise WebhookyError('credential must be "<keyId>:<secret>"')
    return key_id, secret


def build_config(
    *,
    base_url: str,
    authorization: str,
    timeout_seconds: float | None,
    headers: dict[str, str] | None,
    user_agent: str | None,
) -> ClientConfig:
    """Validate and normalize the arguments every client constructor takes."""
    timeout = (
        DEFAULT_TIMEOUT_SECONDS
        if timeout_seconds is None or timeout_seconds <= 0
        else float(timeout_seconds)
    )
    agent = (user_agent or "").strip() or DEFAULT_USER_AGENT
    return ClientConfig(
        urls=normalize_base_url(base_url),
        authorization=authorization,
        headers=dict(headers or {}),
        timeout_seconds=timeout,
        user_agent=agent,
    )
