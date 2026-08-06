"""The error type every web-hooky call raises on failure."""

from __future__ import annotations

import json
from typing import Any, Final

# Error kinds the server emits, mirroring src/core/errors.ts.
KIND_BAD_REQUEST: Final = "bad_request"
KIND_UNAUTHORIZED: Final = "unauthorized"
KIND_FORBIDDEN: Final = "forbidden"
KIND_NOT_FOUND: Final = "not_found"
KIND_METHOD_NOT_ALLOWED: Final = "method_not_allowed"
KIND_CONFLICT: Final = "conflict"
KIND_PAYLOAD_TOO_LARGE: Final = "payload_too_large"
KIND_UNPROCESSABLE_ENTITY: Final = "unprocessable_entity"
KIND_NOT_IMPLEMENTED: Final = "not_implemented"
KIND_INTERNAL: Final = "internal"

# How much of a failure body is kept in a message. An error path must not be a
# way to make the client hold an unbounded string, and no useful server message
# is anywhere near this long.
_MAX_SNIPPET = 200


class WebhookyError(Exception):
    """A failed call against a web-hooky server.

    ``status`` is the HTTP status code, or ``0`` when the request never reached
    the server (a transport or protocol failure). ``kind`` is the server's
    machine-readable discriminator, empty when the response carried none - which
    is how a caller tells "the server refused" from "the server was unreachable".
    """

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        kind: str = "",
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.kind = kind
        self.details = details

    def __str__(self) -> str:
        prefix = ""
        if self.status:
            prefix += f"{self.status} "
        if self.kind:
            prefix += f"({self.kind}) "
        return f"{prefix}{self.message}"

    def __repr__(self) -> str:
        return (
            f"WebhookyError(status={self.status!r}, kind={self.kind!r}, "
            f"message={self.message!r})"
        )

    @property
    def is_not_found(self) -> bool:
        return self.kind == KIND_NOT_FOUND

    @property
    def is_unauthorized(self) -> bool:
        return self.kind == KIND_UNAUTHORIZED

    @property
    def is_forbidden(self) -> bool:
        return self.kind == KIND_FORBIDDEN


def error_from_response(status: int, body: bytes | str) -> WebhookyError:
    """Build an error from a non-2xx response body.

    A body that is not the server's ``{"error": {...}}`` envelope - a proxy's
    HTML page, an empty 502 - still has to produce something actionable, so the
    status becomes the message in that case.
    """
    text = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else body
    try:
        parsed = json.loads(text) if text.strip() else None
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, dict):
        envelope = parsed.get("error")
        if isinstance(envelope, dict) and isinstance(envelope.get("message"), str):
            kind = envelope.get("kind")
            return WebhookyError(
                envelope["message"],
                status=status,
                kind=kind if isinstance(kind, str) else "",
                details=envelope.get("details"),
            )

    snippet = text.strip()
    if len(snippet) > _MAX_SNIPPET:
        snippet = snippet[:_MAX_SNIPPET] + "..."
    if not snippet:
        return WebhookyError(f"request failed with status {status}", status=status)
    return WebhookyError(
        f"request failed with status {status}: {snippet}", status=status
    )
