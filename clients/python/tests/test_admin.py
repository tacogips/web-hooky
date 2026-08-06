"""Admin client: routes, CSRF-satisfying headers, envelope unwrapping."""

from __future__ import annotations

import pytest

from conftest import BASE_URL, Stub
from webhooky import AdminClient, WebhookyError


def make_admin(stub: Stub) -> AdminClient:
    return AdminClient(
        base_url=BASE_URL,
        credential="admin-1:admin-secret",
        http_client=stub.client(),
    )


def test_credential_must_be_a_pair() -> None:
    with pytest.raises(WebhookyError):
        AdminClient(base_url=BASE_URL, credential="no-colon")


def test_credential_may_be_absent_with_idp_headers() -> None:
    # A deployment fronted by an identity-provider proxy authenticates through
    # headers, so no credential is legitimate there.
    client = AdminClient(
        base_url=BASE_URL,
        headers={"cf-access-authenticated-user-email": "ops@example.com"},
    )
    assert client.config.authorization == ""
    client.close()


def test_no_credentials_at_all_is_rejected() -> None:
    with pytest.raises(WebhookyError):
        AdminClient(base_url=BASE_URL)


def test_key_id_and_secret_pair_is_accepted(stub: Stub) -> None:
    stub.body = {"subject": "admin-key:k1", "viaApiKey": True}
    client = AdminClient(
        base_url=BASE_URL, key_id="k1", secret="s1", http_client=stub.client()
    )
    with client:
        identity = client.me()
    assert stub.seen.headers["authorization"] == "Bearer k1:s1"
    assert identity.via_api_key is True


def test_list_endpoints_unwrap_the_envelope(stub: Stub) -> None:
    stub.body = {"destinations": [{"id": "d1", "name": "prod", "fetchUuid": "f1"}]}
    with make_admin(stub) as admin:
        destinations = admin.list_destinations()

    assert stub.seen.path == "/_admin/api/destinations"
    assert stub.seen.headers["authorization"] == "Bearer admin-1:admin-secret"
    assert len(destinations) == 1
    assert destinations[0].id == "d1"
    assert destinations[0].fetch_uuid == "f1"


def test_create_destination_omits_unset_optionals(stub: Stub) -> None:
    stub.status = 201
    stub.body = {"id": "d1", "name": "prod"}
    with make_admin(stub) as admin:
        admin.create_destination(
            name="prod", vendor_addon="wrike", vendor_config={"secret": "s"}
        )

    body = stub.seen.json_body
    assert body == {"name": "prod", "vendorAddon": "wrike", "vendorConfig": {"secret": "s"}}
    # An omitted optional must not appear at all, so the server keeps its
    # default rather than receiving an explicit null.
    assert "destinationAddon" not in body
    assert stub.seen.headers["content-type"] == "application/json"


@pytest.mark.parametrize(
    "call",
    [
        lambda admin: admin.rotate_fetch_uuid("d1"),
        lambda admin: admin.grant_destination("u1", "d1"),
        lambda admin: admin.delete_destination("d1"),
        lambda admin: admin.retry_relay("r1"),
    ],
)
def test_bodyless_writes_declare_json_for_csrf(stub: Stub, call) -> None:
    # The server's CSRF rule accepts an identity-provider write only with a
    # matching Origin or content-type: application/json. These calls have no
    # body, so the header is the only way through.
    stub.body = {}
    with make_admin(stub) as admin:
        call(admin)
    assert stub.seen.headers["content-type"] == "application/json"


def test_path_segments_are_escaped(stub: Stub) -> None:
    # An admin subject is an email or an IdP subject and can contain characters
    # that would otherwise change the route.
    stub.status = 204
    with make_admin(stub) as admin:
        admin.delete_admin_user("ops user@example.com")
    assert stub.seen.path == "/_admin/api/admin-users/ops user@example.com"


def test_upload_addon_uses_multipart_and_origin(stub: Stub) -> None:
    stub.status = 201
    stub.body = {"name": "acme", "version": "1.0.0", "kind": "vendor"}
    with make_admin(stub) as admin:
        addon = admin.upload_addon("acme.zip", b"PK\x03\x04stub")

    assert addon.name == "acme"
    assert stub.seen.headers["content-type"].startswith("multipart/form-data")
    # Multipart cannot use the JSON content type, so the Origin header is what
    # clears the server's CSRF rule on the identity-provider path.
    assert stub.seen.headers["origin"] == BASE_URL
    body = stub.seen.body
    assert b'name="package"' in body
    assert b'filename="acme.zip"' in body
    assert b"PK" in body


def test_list_relays_filters_by_destination(stub: Stub) -> None:
    stub.body = {"relays": []}
    with make_admin(stub) as admin:
        admin.list_relays("dest-9")
    assert stub.seen.query == "destinationId=dest-9"

    with make_admin(stub) as admin:
        admin.list_relays()
    assert stub.seen.query == ""


def test_created_secrets_are_decoded(stub: Stub) -> None:
    stub.status = 201
    stub.body = {
        "id": "k1",
        "label": "ci",
        "enabled": True,
        "createdAt": 5,
        "grants": [],
        "secret": "s3cr3t",
        "credential": "k1:s3cr3t",
    }
    with make_admin(stub) as admin:
        created = admin.create_api_user("ci")

    assert created.id == "k1"
    assert created.label == "ci"
    assert created.secret == "s3cr3t"
    assert created.credential == "k1:s3cr3t"


def test_no_content_response_is_not_a_decode_error(stub: Stub) -> None:
    stub.status = 204
    with make_admin(stub) as admin:
        assert admin.delete_relay("r1") is None


def test_relay_deliveries_page_decodes_stats(stub: Stub) -> None:
    stub.body = {
        "deliveries": [
            {
                "id": "dl1",
                "relayId": "r1",
                "recordId": "rec1",
                "t": 3,
                "status": "failed",
                "attempts": 5,
                "nextAttemptAt": 9,
                "lastStatusCode": 500,
                "lastError": "boom",
                "createdAt": 1,
                "updatedAt": 2,
                "deliveredAt": None,
            }
        ],
        "stats": {"pending": 1, "delivered": 2, "failed": 3},
    }
    with make_admin(stub) as admin:
        page = admin.list_relay_deliveries("r1", limit=10)

    assert stub.seen.query == "limit=10"
    assert page.stats.failed == 3
    assert page.deliveries[0].last_status_code == 500
    assert page.deliveries[0].delivered_at is None


def test_retry_returns_the_requeued_count(stub: Stub) -> None:
    stub.body = {"requeued": 4}
    with make_admin(stub) as admin:
        assert admin.retry_relay("r1") == 4
