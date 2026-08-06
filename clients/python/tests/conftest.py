"""Shared fixtures: a stub transport that records what the client sent."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest


@dataclass
class Seen:
    """The last request the stub handled."""

    method: str = ""
    path: str = ""
    query: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    @property
    def json_body(self) -> Any:
        return json.loads(self.body) if self.body else None


class Stub:
    """An httpx transport that answers with a fixed status and body."""

    def __init__(self, status: int = 200, body: Any = None) -> None:
        self.status = status
        self.body = body
        self.seen = Seen()

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.seen.method = request.method
        self.seen.path = request.url.path
        self.seen.query = request.url.query.decode()
        self.seen.headers = {k.lower(): v for k, v in request.headers.items()}
        self.seen.body = request.content

        if self.body is None:
            return httpx.Response(self.status)
        if isinstance(self.body, (str, bytes)):
            return httpx.Response(self.status, content=self.body)
        return httpx.Response(
            self.status,
            content=json.dumps(self.body),
            headers={"content-type": "application/json"},
        )

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self._handle))

    def async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._handle))


@pytest.fixture
def stub() -> Stub:
    return Stub()


BASE_URL = "https://hooks.example.test"
