"""Executing an :class:`~webhooky._ops.Operation` over httpx.

Both flavours share one request builder, so the sync and async clients cannot
send different bytes for the same operation.
"""

from __future__ import annotations

import json
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx

from ._ops import Operation, RequestSpec
from .config import ClientConfig
from .errors import WebhookyError, error_from_response

T = TypeVar("T")


def _origin_of(base_url: str) -> str:
    parts = urlsplit(base_url)
    return f"{parts.scheme}://{parts.netloc}"


def build_request(config: ClientConfig, spec: RequestSpec) -> dict[str, Any]:
    """Turn an operation's spec into httpx request arguments."""
    headers = config.request_headers(content_type=spec.resolved_content_type())
    if spec.send_origin:
        headers["origin"] = _origin_of(config.urls.http)

    arguments: dict[str, Any] = {
        "method": spec.method,
        "url": f"{config.urls.http}{spec.path}",
        "headers": headers,
    }
    if spec.params:
        arguments["params"] = dict(spec.params)
    if spec.content is not None:
        arguments["content"] = spec.content
    elif spec.json_body is not None:
        # Encoded here rather than through httpx's json= so the content type
        # set above stays authoritative.
        arguments["content"] = json.dumps(spec.json_body).encode()
    return arguments


def decode_response(operation: Operation[T], response: httpx.Response) -> T:
    """Check the status and decode a successful response."""
    if response.status_code < 200 or response.status_code >= 300:
        raise error_from_response(response.status_code, response.content)
    if response.status_code == 204 or not response.content.strip():
        return operation.decode(None)
    try:
        parsed = json.loads(response.content)
    except json.JSONDecodeError as exc:
        raise WebhookyError(
            f"failed to decode response: {exc}", status=response.status_code
        ) from exc
    return operation.decode(parsed)


def run_sync(client: httpx.Client, config: ClientConfig, operation: Operation[T]) -> T:
    try:
        response = client.request(**build_request(config, operation.spec))
    except httpx.HTTPError as exc:
        raise WebhookyError(f"request failed: {exc}") from exc
    return decode_response(operation, response)


async def run_async(
    client: httpx.AsyncClient, config: ClientConfig, operation: Operation[T]
) -> T:
    try:
        response = await client.request(**build_request(config, operation.spec))
    except httpx.HTTPError as exc:
        raise WebhookyError(f"request failed: {exc}") from exc
    return decode_response(operation, response)
