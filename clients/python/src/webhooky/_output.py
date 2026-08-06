"""JSON rendering and argument decoding shared by the CLI command groups."""

from __future__ import annotations

import dataclasses
import json
from typing import Any

from ._env import UsageError


def to_json(value: Any) -> Any:
    """Render a model as the server's own JSON shape.

    Every model keeps the raw mapping it decoded from, so the CLI emits exactly
    what the server said rather than a Python-flavoured re-rendering.
    """
    if isinstance(value, list):
        return [to_json(item) for item in value]
    if isinstance(value, tuple):
        return [to_json(item) for item in value]
    raw = getattr(value, "raw", None)
    if isinstance(raw, dict) and raw:
        return raw
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: to_json(getattr(value, field.name))
            for field in dataclasses.fields(value)
            if field.name != "raw"
        }
    return value


def emit(value: Any, *, pretty: bool) -> None:
    """Write one JSON document to stdout."""
    print(json.dumps(to_json(value), indent=2 if pretty else None))


def json_arg(raw: str | None, field: str) -> dict[str, Any] | None:
    """Parse an inline JSON object or ``@path/to/file.json``.

    Shells make large inline JSON painful to quote, and addon configuration is
    exactly the kind of thing that already lives in a file.
    """
    if raw is None:
        return None
    text = raw.strip()
    if text.startswith("@"):
        path = text[1:]
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read().strip()
        except OSError as exc:
            raise UsageError(f"failed to read {path}: {exc}") from exc
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise UsageError(f"--{field} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise UsageError(f"--{field} must be a JSON object")
    return parsed
