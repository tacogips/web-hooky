"""Stream frame decoding, handshake URL/headers, and CLI environment handling."""

from __future__ import annotations

import json

import pytest

from conftest import BASE_URL, Stub
from webhooky import WebhookyError
from webhooky._env import UsageError, resolve_headers, resolve_timeout
from webhooky._output import to_json
from webhooky.cli import main
from webhooky.config import bearer_from_pair, build_config
from webhooky.stream import (
    backoff_for,
    decode_frame,
    handshake_headers,
    stream_url,
)


def make_config(**overrides):
    return build_config(
        base_url=overrides.pop("base_url", BASE_URL),
        authorization=overrides.pop("authorization", bearer_from_pair("key-1", "sec-1")),
        timeout_seconds=None,
        headers=overrides.pop("headers", None),
        user_agent=None,
    )


def test_stream_url_defaults_to_header_credentials() -> None:
    config = make_config()
    url = stream_url(config, "fetch-uuid", query_credentials=False)
    # The header form keeps credentials out of proxy access logs, so it is the
    # default and the URL must stay clean.
    assert url == "wss://hooks.example.test/_ws/fetch-uuid"
    assert handshake_headers(config, query_credentials=False)["authorization"] == (
        "Bearer key-1:sec-1"
    )


def test_stream_url_query_fallback() -> None:
    config = make_config()
    url = stream_url(config, "fetch-uuid", query_credentials=True)
    assert "api_key=key-1" in url and "api_secret=sec-1" in url
    assert "authorization" not in handshake_headers(config, query_credentials=True)


def test_decode_frame_types() -> None:
    assert decode_frame('{"type":"ready"}') == ("ready", None)

    frame_type, record = decode_frame(
        json.dumps({"type": "record", "record": {"t": 3, "fetched": False, "payload": 1}})
    )
    assert frame_type == "record"
    assert record is not None and record.t == 3 and record.payload == 1

    # A server that grows a new frame kind must not break an older client.
    assert decode_frame('{"type":"future-kind"}') == ("future-kind", None)


def test_decode_frame_rejects_malformed_input() -> None:
    with pytest.raises(WebhookyError):
        decode_frame("not json")
    with pytest.raises(WebhookyError):
        decode_frame('{"type":"record"}')


def test_backoff_is_capped() -> None:
    assert backoff_for(1, 0.5, 30.0) == 0.5
    assert backoff_for(3, 0.5, 30.0) == 2.0
    # A long-lived stream must not grow an absurd delay.
    assert backoff_for(500, 0.5, 30.0) == 30.0


def test_resolve_headers_merges_env_and_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBHOOKY_HEADERS", "a=1,b=2")
    # A value may itself contain "=" (a base64 proxy secret), so only the first
    # separator is significant, and a flag wins over the environment.
    assert resolve_headers(["b=3", "c=x=y"]) == {"a": "1", "b": "3", "c": "x=y"}


def test_resolve_headers_rejects_malformed_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBHOOKY_HEADERS", raising=False)
    with pytest.raises(UsageError):
        resolve_headers(["no-separator"])


def test_resolve_timeout_prefers_flag_then_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBHOOKY_TIMEOUT_SECONDS", "12")
    assert resolve_timeout(None) == 12.0
    assert resolve_timeout(3.5) == 3.5
    monkeypatch.setenv("WEBHOOKY_TIMEOUT_SECONDS", "nonsense")
    with pytest.raises(UsageError):
        resolve_timeout(None)


def test_to_json_emits_the_servers_own_shape() -> None:
    from webhooky.models import Record

    record = Record.from_json({"t": 1, "fetched": False, "payload": {"x": 1}})
    assert to_json(record) == {"t": 1, "fetched": False, "payload": {"x": 1}}


def test_cli_reports_missing_credentials_as_a_usage_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name in (
        "WEBHOOKY_API_KEY",
        "WEBHOOKY_API_SECRET",
        "WEBHOOKY_CREDENTIAL",
        "WEBHOOKY_HEADERS",
    ):
        monkeypatch.delenv(name, raising=False)

    exit_code = main(["records", "get", "--fetch-uuid", "u"])
    assert exit_code == 2
    assert "missing fetch credentials" in capsys.readouterr().err


def test_cli_reports_a_server_error_as_json_on_stderr(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], stub: Stub
) -> None:
    monkeypatch.setenv("WEBHOOKY_API_KEY", "k")
    monkeypatch.setenv("WEBHOOKY_API_SECRET", "s")
    monkeypatch.setenv("WEBHOOKY_URL", BASE_URL)
    stub.status = 404
    stub.body = {"error": {"kind": "not_found", "message": "Unknown fetch endpoint"}}

    import webhooky._clients as clients
    from webhooky.fetch import FetchClient

    def patched(args):
        return FetchClient(
            base_url=BASE_URL,
            api_key="k",
            api_secret="s",
            http_client=stub.client(),
        )

    monkeypatch.setattr(clients, "fetch_client", patched)
    monkeypatch.setattr("webhooky.cli.fetch_client", patched)

    exit_code = main(["records", "get", "--fetch-uuid", "u"])
    assert exit_code == 1
    payload = json.loads(capsys.readouterr().err)
    assert payload["error"]["status"] == 404
    assert payload["error"]["kind"] == "not_found"


def test_cli_version_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--version"]) == 0
    assert "webhooky-python-cli/" in capsys.readouterr().out
