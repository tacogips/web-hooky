"""Reading and streaming a destination's records."""

from __future__ import annotations

from datetime import datetime
from typing import Any, AsyncIterator, Iterator

import httpx

from . import _ops as ops
from ._transport import run_async, run_sync
from .config import ClientConfig, bearer_from_pair, build_config
from .errors import WebhookyError
from .models import Record
from .stream import StreamOptions, aiter_stream, iter_stream

TimeBound = int | float | str | datetime | None


def _fetch_config(
    base_url: str,
    api_key: str,
    api_secret: str,
    timeout_seconds: float | None,
    headers: dict[str, str] | None,
    user_agent: str | None,
) -> ClientConfig:
    if not (api_key or "").strip() or not (api_secret or "").strip():
        raise WebhookyError("api_key and api_secret are required")
    return build_config(
        base_url=base_url,
        authorization=bearer_from_pair(api_key.strip(), api_secret),
        timeout_seconds=timeout_seconds,
        headers=headers,
        user_agent=user_agent,
    )


class FetchClient:
    """Reads and streams records for a fetch API user.

    Credentials are passed here, not read from the environment, so one process
    can hold several clients with different identities.

    Usable as a context manager, which closes the underlying connection pool::

        with FetchClient(base_url=..., api_key=..., api_secret=...) as client:
            for record in client.records(fetch_uuid, only_unfetched=True):
                ...
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        api_secret: str,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
        user_agent: str | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._config = _fetch_config(
            base_url, api_key, api_secret, timeout_seconds, headers, user_agent
        )
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=self._config.timeout_seconds)

    @property
    def config(self) -> ClientConfig:
        return self._config

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "FetchClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def records(
        self,
        fetch_uuid: str,
        *,
        only_unfetched: bool = False,
        mark_fetched: bool = True,
        from_: TimeBound = None,
        to: TimeBound = None,
        limit: int | None = None,
    ) -> list[Record]:
        """Read stored records, newest first.

        Unless ``mark_fetched`` is turned off the server marks what it returns
        as fetched; each record's ``fetched`` field reflects the value from
        before that marking.
        """
        return run_sync(
            self._http,
            self._config,
            ops.records(
                fetch_uuid,
                only_unfetched=only_unfetched,
                mark_fetched=mark_fetched,
                from_=from_,
                to=to,
                limit=limit,
            ),
        )

    def stream(
        self, fetch_uuid: str, options: StreamOptions | None = None
    ) -> Iterator[Record]:
        """Stream records over WebSocket until the stream ends."""
        return iter_stream(self._config, fetch_uuid, options or StreamOptions())


class AsyncFetchClient:
    """The asynchronous twin of :class:`FetchClient`."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        api_secret: str,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
        user_agent: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = _fetch_config(
            base_url, api_key, api_secret, timeout_seconds, headers, user_agent
        )
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(
            timeout=self._config.timeout_seconds
        )

    @property
    def config(self) -> ClientConfig:
        return self._config

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncFetchClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def records(
        self,
        fetch_uuid: str,
        *,
        only_unfetched: bool = False,
        mark_fetched: bool = True,
        from_: TimeBound = None,
        to: TimeBound = None,
        limit: int | None = None,
    ) -> list[Record]:
        return await run_async(
            self._http,
            self._config,
            ops.records(
                fetch_uuid,
                only_unfetched=only_unfetched,
                mark_fetched=mark_fetched,
                from_=from_,
                to=to,
                limit=limit,
            ),
        )

    def stream(
        self, fetch_uuid: str, options: StreamOptions | None = None
    ) -> AsyncIterator[Record]:
        return aiter_stream(self._config, fetch_uuid, options or StreamOptions())
