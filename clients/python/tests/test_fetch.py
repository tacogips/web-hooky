"""Fetch client: URL and query construction, auth, decoding, error envelope."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from conftest import BASE_URL, Stub
from webhooky import AsyncFetchClient, FetchClient, WebhookyError
from webhooky.config import normalize_base_url


def make_client(stub: Stub) -> FetchClient:
    return FetchClient(
        base_url=BASE_URL,
        api_key="key-1",
        api_secret="sec-1",
        http_client=stub.client(),
    )


@pytest.mark.parametrize(
    ("raw", "http", "ws"),
    [
        ("http://localhost:8787", "http://localhost:8787", "ws://localhost:8787"),
        ("https://hooks.example.com/", "https://hooks.example.com", "wss://hooks.example.com"),
        ("wss://hooks.example.com//", "https://hooks.example.com", "wss://hooks.example.com"),
        ("http://host:1/prefix/", "http://host:1/prefix", "ws://host:1/prefix"),
    ],
)
def test_base_url_normalization(raw: str, http: str, ws: str) -> None:
    urls = normalize_base_url(raw)
    assert (urls.http, urls.ws) == (http, ws)


@pytest.mark.parametrize("raw", ["", "   ", "ftp://example.com", "no-scheme-or-host"])
def test_base_url_rejects_bad_input(raw: str) -> None:
    with pytest.raises(WebhookyError):
        normalize_base_url(raw)


def test_missing_credentials_are_rejected() -> None:
    with pytest.raises(WebhookyError):
        FetchClient(base_url=BASE_URL, api_key="", api_secret="s")


def test_records_sends_bearer_and_no_default_query(stub: Stub) -> None:
    stub.body = {"records": [{"t": 10, "fetched": False, "payload": {"a": 1}}]}
    with make_client(stub) as client:
        records = client.records("fetch-uuid")

    assert stub.seen.path == "/_get/fetch-uuid"
    # A default query must send nothing: the server's own defaults apply.
    assert stub.seen.query == ""
    assert stub.seen.headers["authorization"] == "Bearer key-1:sec-1"
    assert stub.seen.headers["user-agent"].startswith("webhooky-python/")
    assert len(records) == 1
    assert records[0].t == 10
    assert records[0].fetched is False
    assert records[0].payload == {"a": 1}


def test_records_query_parameters(stub: Stub) -> None:
    stub.body = {"records": []}
    with make_client(stub) as client:
        client.records(
            "uuid",
            only_unfetched=True,
            mark_fetched=False,
            from_=datetime(1970, 1, 1, 0, 1, 40, tzinfo=timezone.utc),
            to=200,
            limit=25,
        )

    for expected in (
        "only_unfetched=true",
        "mark_fetched=false",
        "from=100",
        "to=200",
        "limit=25",
    ):
        assert expected in stub.seen.query


def test_records_accepts_iso_time_bounds_verbatim(stub: Stub) -> None:
    # The server parses ISO-8601 itself, so a string bound is passed through
    # rather than being reinterpreted by the client.
    stub.body = {"records": []}
    with make_client(stub) as client:
        client.records("uuid", from_="2026-01-01T00:00:00Z")
    assert "from=2026-01-01T00%3A00%3A00Z" in stub.seen.query


def test_empty_result_is_an_empty_list(stub: Stub) -> None:
    stub.body = {"records": []}
    with make_client(stub) as client:
        assert client.records("uuid") == []


def test_error_envelope_is_decoded(stub: Stub) -> None:
    stub.status = 403
    stub.body = {
        "error": {
            "kind": "forbidden",
            "message": "API user is not authorized for this destination",
        }
    }
    with make_client(stub) as client:
        with pytest.raises(WebhookyError) as caught:
            client.records("uuid")

    error = caught.value
    assert error.status == 403
    assert error.kind == "forbidden"
    assert error.is_forbidden
    assert "not authorized" in error.message


def test_non_envelope_error_body_still_reports(stub: Stub) -> None:
    # A proxy answering with HTML must not produce an empty, useless error.
    stub.status = 502
    stub.body = "<html>bad gateway</html>"
    with make_client(stub) as client:
        with pytest.raises(WebhookyError) as caught:
            client.records("uuid")

    assert caught.value.status == 502
    assert caught.value.kind == ""
    assert "502" in caught.value.message


def test_extra_headers_are_sent_but_never_override_auth(stub: Stub) -> None:
    stub.body = {"records": []}
    client = FetchClient(
        base_url=BASE_URL,
        api_key="key-1",
        api_secret="sec-1",
        headers={
            "cf-access-authenticated-user-email": "ops@example.com",
            "authorization": "Bearer attacker:owned",
        },
        user_agent="custom-agent/9",
        http_client=stub.client(),
    )
    with client:
        client.records("uuid")

    assert stub.seen.headers["cf-access-authenticated-user-email"] == "ops@example.com"
    assert stub.seen.headers["user-agent"] == "custom-agent/9"
    # The credentials the caller passed explicitly must win over a header that
    # happens to share the name.
    assert stub.seen.headers["authorization"] == "Bearer key-1:sec-1"


async def test_async_client_matches_sync(stub: Stub) -> None:
    stub.body = {"records": [{"t": 7, "fetched": True, "payload": None}]}
    async with AsyncFetchClient(
        base_url=BASE_URL,
        api_key="key-1",
        api_secret="sec-1",
        http_client=stub.async_client(),
    ) as client:
        records = await client.records("uuid", only_unfetched=True)

    assert stub.seen.path == "/_get/uuid"
    assert stub.seen.query == "only_unfetched=true"
    assert records[0].t == 7
    assert records[0].fetched is True
