"""WebSocket streaming of a destination's records.

The server accepts handshake credentials either as an ``Authorization`` header
or as ``?api_key=&api_secret=`` query parameters. The query form exists because
browsers cannot set headers on a WebSocket handshake; a query string ends up in
proxy and server access logs, so this client sends the header by default and
falls back to the query form only when asked.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Iterator
from urllib.parse import quote, urlencode

from .config import ClientConfig
from .errors import WebhookyError
from .models import Record

# RFC 6455 close code the server uses when the credential or grant behind a
# socket stops being valid.
POLICY_VIOLATION = 1008

DEFAULT_INITIAL_BACKOFF = 0.5
DEFAULT_MAX_BACKOFF = 30.0
# One inbound frame ceiling. The server's own inbound body cap defaults to
# 1 MiB, so this leaves generous headroom above it.
MAX_FRAME_BYTES = 8 * 1024 * 1024


class StreamClosedByServer(WebhookyError):
    """The server closed the socket with a policy violation (1008).

    The credential or the grant behind this stream is no longer valid;
    reconnecting will not help, so the stream ends even when reconnection is
    enabled.
    """

    def __init__(self) -> None:
        super().__init__(
            "stream closed by server policy (credential or grant revoked)",
            kind="forbidden",
        )


@dataclass(frozen=True)
class StreamOptions:
    """Configuration for one stream."""

    reconnect: bool = False
    """Reconnect with capped exponential backoff after a transport failure."""
    initial_backoff: float = DEFAULT_INITIAL_BACKOFF
    max_backoff: float = DEFAULT_MAX_BACKOFF
    query_credentials: bool = False
    """Send credentials as query parameters instead of an Authorization header."""
    max_records: int | None = None
    """Stop after this many records; ``None`` streams until interrupted."""
    on_ready: Callable[[], None] | None = None
    """Called once per successful connection, on the server's ready frame."""
    on_reconnect: Callable[[int, BaseException], None] | None = None
    """Called before each retry with the attempt number and the previous error."""


def stream_url(config: ClientConfig, fetch_uuid: str, *, query_credentials: bool) -> str:
    """Build the ``/_ws/{fetchUuid}`` URL for one stream."""
    url = f"{config.urls.ws}/_ws/{quote(fetch_uuid, safe='')}"
    if not query_credentials:
        return url
    token = config.authorization.removeprefix("Bearer ").strip()
    key_id, separator, secret = token.partition(":")
    if not separator:
        return url
    return f"{url}?{urlencode({'api_key': key_id, 'api_secret': secret})}"


def handshake_headers(config: ClientConfig, *, query_credentials: bool) -> dict[str, str]:
    headers = dict(config.headers)
    headers["user-agent"] = config.user_agent
    if not query_credentials and config.authorization:
        headers["authorization"] = config.authorization
    return headers


def backoff_for(attempt: int, initial: float, maximum: float) -> float:
    """Capped exponential backoff for reconnect attempt ``attempt`` (1-based)."""
    exponent = min(max(attempt - 1, 0), 20)
    return min(initial * (2**exponent), maximum)


def decode_frame(raw: str | bytes) -> tuple[str, Record | None]:
    """Decode one server frame into ``(type, record)``.

    Unknown frame types decode to ``(type, None)`` and are ignored by the
    callers, so a server that grows a new frame kind does not break an older
    client.
    """
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WebhookyError(f"failed to decode stream frame: {exc}") from exc
    if not isinstance(parsed, dict):
        raise WebhookyError("stream frame is not a JSON object")

    frame_type = parsed.get("type")
    frame_type = frame_type if isinstance(frame_type, str) else ""
    if frame_type == "record":
        record = parsed.get("record")
        if isinstance(record, dict):
            return frame_type, Record.from_json(record)
        raise WebhookyError('stream "record" frame carried no record object')
    return frame_type, None


def _is_policy_violation(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    if code == POLICY_VIOLATION:
        return True
    received = getattr(exc, "rcvd", None)
    return getattr(received, "code", None) == POLICY_VIOLATION


def iter_stream(
    config: ClientConfig,
    fetch_uuid: str,
    options: StreamOptions,
) -> Iterator[Record]:
    """Yield records from the stream, blocking until it ends.

    Requires the ``websockets`` package (a declared dependency).
    """
    from websockets.sync.client import connect as sync_connect

    url = stream_url(config, fetch_uuid, query_credentials=options.query_credentials)
    headers = handshake_headers(config, query_credentials=options.query_credentials)

    delivered = 0
    attempt = 0
    while True:
        try:
            with sync_connect(
                url,
                additional_headers=headers,
                max_size=MAX_FRAME_BYTES,
                open_timeout=config.timeout_seconds,
            ) as socket:
                for raw in socket:
                    frame_type, record = decode_frame(raw)
                    if frame_type == "ready":
                        if options.on_ready is not None:
                            options.on_ready()
                        continue
                    if record is None:
                        continue
                    yield record
                    delivered += 1
                    if options.max_records is not None and delivered >= options.max_records:
                        return
            # A clean server close ends the stream unless reconnecting.
            if not options.reconnect:
                return
            cause: BaseException = WebhookyError("stream closed by the server")
        except Exception as exc:  # noqa: BLE001 - re-raised or retried below
            if _is_policy_violation(exc):
                raise StreamClosedByServer() from exc
            if isinstance(exc, (KeyboardInterrupt, GeneratorExit, WebhookyError)):
                raise
            if not options.reconnect:
                raise WebhookyError(f"stream failed: {exc}") from exc
            cause = exc

        attempt += 1
        if options.on_reconnect is not None:
            options.on_reconnect(attempt, cause)
        _sleep(backoff_for(attempt, options.initial_backoff, options.max_backoff))


def _sleep(seconds: float) -> None:
    import time

    time.sleep(seconds)


async def aiter_stream(
    config: ClientConfig,
    fetch_uuid: str,
    options: StreamOptions,
) -> AsyncIterator[Record]:
    """Yield records from the stream, asynchronously."""
    import asyncio

    from websockets.asyncio.client import connect as async_connect

    url = stream_url(config, fetch_uuid, query_credentials=options.query_credentials)
    headers = handshake_headers(config, query_credentials=options.query_credentials)

    delivered = 0
    attempt = 0
    while True:
        try:
            async with async_connect(
                url,
                additional_headers=headers,
                max_size=MAX_FRAME_BYTES,
                open_timeout=config.timeout_seconds,
            ) as socket:
                async for raw in socket:
                    frame_type, record = decode_frame(raw)
                    if frame_type == "ready":
                        if options.on_ready is not None:
                            options.on_ready()
                        continue
                    if record is None:
                        continue
                    yield record
                    delivered += 1
                    if options.max_records is not None and delivered >= options.max_records:
                        return
            if not options.reconnect:
                return
            cause: BaseException = WebhookyError("stream closed by the server")
        except Exception as exc:  # noqa: BLE001 - re-raised or retried below
            if _is_policy_violation(exc):
                raise StreamClosedByServer() from exc
            if isinstance(exc, (asyncio.CancelledError, GeneratorExit, WebhookyError)):
                raise
            if not options.reconnect:
                raise WebhookyError(f"stream failed: {exc}") from exc
            cause = exc

        attempt += 1
        if options.on_reconnect is not None:
            options.on_reconnect(attempt, cause)
        await asyncio.sleep(
            backoff_for(attempt, options.initial_backoff, options.max_backoff)
        )
