"""Request descriptions shared by the sync and async clients.

An operation is a pure value: the request to make plus the function that turns
the response into a model. Both client flavours execute the same operations, so
the sync and async surfaces cannot drift apart in what they send or how they
decode - only in how they await.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Generic, Mapping, TypeVar
from urllib.parse import quote

from .models import (
    Addon,
    AdminIdentity,
    AdminKey,
    AdminUser,
    ApiUser,
    CreatedAdminKey,
    CreatedApiUser,
    Destination,
    JsonObject,
    Record,
    Relay,
    RelayDeliveryPage,
)

T = TypeVar("T")

ADMIN_BASE = "/_admin/api"

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class RequestSpec:
    """One HTTP request to a web-hooky server."""

    method: str
    path: str
    params: Mapping[str, str] = field(default_factory=dict)
    json_body: Any = None
    content: bytes | None = None
    content_type: str | None = None
    send_origin: bool = False
    """Adds an Origin header matching the server.

    The server's CSRF rule accepts an identity-provider write either with a
    matching Origin or with ``content-type: application/json``. A multipart
    upload cannot use the latter, so it uses the former.
    """

    @property
    def is_state_changing(self) -> bool:
        return self.method.upper() not in _SAFE_METHODS

    def resolved_content_type(self) -> str | None:
        """The content type to send, defaulting writes to JSON.

        Bodyless writes (rotate, grant, delete) still declare JSON so the
        identity-provider path clears the server's CSRF check.
        """
        if self.content_type is not None:
            return self.content_type
        if self.json_body is not None:
            return "application/json"
        if self.is_state_changing:
            return "application/json"
        return None


@dataclass(frozen=True)
class Operation(Generic[T]):
    """A request plus the decoder for its response."""

    spec: RequestSpec
    decode: Callable[[Any], T]


def _segment(value: str) -> str:
    """Percent-encode a value used as a single URL path segment."""
    return quote(str(value), safe="")


def _identity(value: Any) -> Any:
    return value


def _none(_: Any) -> None:
    return None


def _object(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _list_of(key: str, build: Callable[[JsonObject], T]) -> Callable[[Any], list[T]]:
    """Decode ``{"<key>": [...]}`` into a plain list.

    The envelope carries no information a typed client needs, so it is unwrapped
    here rather than in every caller.
    """

    def decode(value: Any) -> list[T]:
        if not isinstance(value, dict):
            return []
        items = value.get(key)
        if not isinstance(items, list):
            return []
        return [build(item) for item in items if isinstance(item, dict)]

    return decode


def _one(build: Callable[[JsonObject], T]) -> Callable[[Any], T]:
    def decode(value: Any) -> T:
        return build(_object(value))

    return decode


def _prune(body: Mapping[str, Any]) -> dict[str, Any]:
    """Drop keys whose value is ``None``.

    The server distinguishes an absent field (keep the current value) from an
    explicit null (clear it), so an unset argument must not reach the wire.
    """
    return {key: value for key, value in body.items() if value is not None}


def _time_param(value: int | float | str | datetime | None) -> str | None:
    """Render a time bound the way the server's ``from``/``to`` accept it."""
    if value is None:
        return None
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return str(int(moment.timestamp()))
    if isinstance(value, str):
        return value
    return str(int(value))


# -- fetch surface -----------------------------------------------------------


def records(
    fetch_uuid: str,
    *,
    only_unfetched: bool = False,
    mark_fetched: bool = True,
    from_: int | float | str | datetime | None = None,
    to: int | float | str | datetime | None = None,
    limit: int | None = None,
) -> Operation[list[Record]]:
    """``GET /_get/{fetchUuid}``.

    Only parameters that differ from the server's own defaults are sent, so a
    plain call produces a bare URL.
    """
    params: dict[str, str] = {}
    if only_unfetched:
        params["only_unfetched"] = "true"
    if not mark_fetched:
        params["mark_fetched"] = "false"
    from_param = _time_param(from_)
    if from_param is not None:
        params["from"] = from_param
    to_param = _time_param(to)
    if to_param is not None:
        params["to"] = to_param
    if limit is not None and limit > 0:
        params["limit"] = str(int(limit))

    return Operation(
        spec=RequestSpec("GET", f"/_get/{_segment(fetch_uuid)}", params=params),
        decode=_list_of("records", Record.from_json),
    )


# -- admin: identity ---------------------------------------------------------


def me() -> Operation[AdminIdentity]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/me"),
        decode=_one(AdminIdentity.from_json),
    )


# -- admin: destinations -----------------------------------------------------


def list_destinations() -> Operation[list[Destination]]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/destinations"),
        decode=_list_of("destinations", Destination.from_json),
    )


def get_destination(destination_id: str) -> Operation[Destination]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/destinations/{_segment(destination_id)}"),
        decode=_one(Destination.from_json),
    )


def create_destination(
    *,
    name: str,
    vendor_addon: str,
    destination_addon: str | None = None,
    vendor_config: Mapping[str, Any] | None = None,
    destination_config: Mapping[str, Any] | None = None,
    retention_seconds: int | None = None,
) -> Operation[Destination]:
    body = _prune(
        {
            "name": name,
            "vendorAddon": vendor_addon,
            "destinationAddon": destination_addon,
            "vendorConfig": dict(vendor_config) if vendor_config is not None else None,
            "destinationConfig": dict(destination_config)
            if destination_config is not None
            else None,
            "retentionSeconds": retention_seconds,
        }
    )
    return Operation(
        spec=RequestSpec("POST", f"{ADMIN_BASE}/destinations", json_body=body),
        decode=_one(Destination.from_json),
    )


def update_destination(
    destination_id: str, patch: Mapping[str, Any]
) -> Operation[Destination]:
    """``PATCH /_admin/api/destinations/{id}`` with server-side field names.

    The patch mapping is sent as given: the server treats an absent key as
    "leave it alone" and an explicit ``None`` as "clear it", and only the caller
    knows which was meant.
    """
    return Operation(
        spec=RequestSpec(
            "PATCH",
            f"{ADMIN_BASE}/destinations/{_segment(destination_id)}",
            json_body=dict(patch),
        ),
        decode=_one(Destination.from_json),
    )


def delete_destination(destination_id: str) -> Operation[None]:
    return Operation(
        spec=RequestSpec(
            "DELETE", f"{ADMIN_BASE}/destinations/{_segment(destination_id)}"
        ),
        decode=_none,
    )


def rotate_fetch_uuid(destination_id: str) -> Operation[Destination]:
    return Operation(
        spec=RequestSpec(
            "POST",
            f"{ADMIN_BASE}/destinations/{_segment(destination_id)}/rotate-fetch-uuid",
        ),
        decode=_one(Destination.from_json),
    )


def list_destination_records(
    destination_id: str, limit: int | None = None
) -> Operation[list[Record]]:
    """Administrative record inspection: never marks anything as fetched."""
    params = {"limit": str(int(limit))} if limit else {}
    return Operation(
        spec=RequestSpec(
            "GET", f"{ADMIN_BASE}/records/{_segment(destination_id)}", params=params
        ),
        decode=_list_of("records", Record.from_json),
    )


# -- admin: relays -----------------------------------------------------------


def list_relays(destination_id: str | None = None) -> Operation[list[Relay]]:
    params = {"destinationId": destination_id} if destination_id else {}
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/relays", params=params),
        decode=_list_of("relays", Relay.from_json),
    )


def get_relay(relay_id: str) -> Operation[Relay]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/relays/{_segment(relay_id)}"),
        decode=_one(Relay.from_json),
    )


def create_relay(
    *,
    destination_id: str,
    name: str,
    target_url: str,
    secret: str | None = None,
    enabled: bool | None = None,
    max_attempts: int | None = None,
    backoff_seconds: int | None = None,
    timeout_seconds: int | None = None,
) -> Operation[Relay]:
    body = _prune(
        {
            "destinationId": destination_id,
            "name": name,
            "targetUrl": target_url,
            "secret": secret,
            "enabled": enabled,
            "maxAttempts": max_attempts,
            "backoffSeconds": backoff_seconds,
            "timeoutSeconds": timeout_seconds,
        }
    )
    return Operation(
        spec=RequestSpec("POST", f"{ADMIN_BASE}/relays", json_body=body),
        decode=_one(Relay.from_json),
    )


def update_relay(relay_id: str, patch: Mapping[str, Any]) -> Operation[Relay]:
    return Operation(
        spec=RequestSpec(
            "PATCH", f"{ADMIN_BASE}/relays/{_segment(relay_id)}", json_body=dict(patch)
        ),
        decode=_one(Relay.from_json),
    )


def delete_relay(relay_id: str) -> Operation[None]:
    return Operation(
        spec=RequestSpec("DELETE", f"{ADMIN_BASE}/relays/{_segment(relay_id)}"),
        decode=_none,
    )


def list_relay_deliveries(
    relay_id: str, limit: int | None = None
) -> Operation[RelayDeliveryPage]:
    params = {"limit": str(int(limit))} if limit else {}
    return Operation(
        spec=RequestSpec(
            "GET", f"{ADMIN_BASE}/relays/{_segment(relay_id)}/deliveries", params=params
        ),
        decode=_one(RelayDeliveryPage.from_json),
    )


def retry_relay(relay_id: str) -> Operation[int]:
    """Requeue this relay's failed deliveries; returns how many were requeued."""

    def decode(value: Any) -> int:
        requeued = _object(value).get("requeued")
        return int(requeued) if isinstance(requeued, (int, float)) else 0

    return Operation(
        spec=RequestSpec("POST", f"{ADMIN_BASE}/relays/{_segment(relay_id)}/retry"),
        decode=decode,
    )


# -- admin: fetch API users --------------------------------------------------


def list_api_users() -> Operation[list[ApiUser]]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/users"),
        decode=_list_of("users", ApiUser.from_json),
    )


def get_api_user(user_id: str) -> Operation[ApiUser]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/users/{_segment(user_id)}"),
        decode=_one(ApiUser.from_json),
    )


def create_api_user(label: str) -> Operation[CreatedApiUser]:
    """Mint a key/secret pair. The secret is returned here and nowhere else."""
    return Operation(
        spec=RequestSpec("POST", f"{ADMIN_BASE}/users", json_body={"label": label}),
        decode=_one(CreatedApiUser.from_json),
    )


def rotate_api_user_secret(user_id: str) -> Operation[CreatedApiUser]:
    return Operation(
        spec=RequestSpec("POST", f"{ADMIN_BASE}/users/{_segment(user_id)}/rotate"),
        decode=_one(CreatedApiUser.from_json),
    )


def set_api_user_enabled(user_id: str, enabled: bool) -> Operation[ApiUser]:
    return Operation(
        spec=RequestSpec(
            "PATCH",
            f"{ADMIN_BASE}/users/{_segment(user_id)}",
            json_body={"enabled": enabled},
        ),
        decode=_one(ApiUser.from_json),
    )


def delete_api_user(user_id: str) -> Operation[None]:
    return Operation(
        spec=RequestSpec("DELETE", f"{ADMIN_BASE}/users/{_segment(user_id)}"),
        decode=_none,
    )


def grant_destination(user_id: str, destination_id: str) -> Operation[ApiUser]:
    return Operation(
        spec=RequestSpec(
            "PUT",
            f"{ADMIN_BASE}/users/{_segment(user_id)}/grants/{_segment(destination_id)}",
        ),
        decode=_one(ApiUser.from_json),
    )


def revoke_destination(user_id: str, destination_id: str) -> Operation[ApiUser]:
    return Operation(
        spec=RequestSpec(
            "DELETE",
            f"{ADMIN_BASE}/users/{_segment(user_id)}/grants/{_segment(destination_id)}",
        ),
        decode=_one(ApiUser.from_json),
    )


# -- admin: addons -----------------------------------------------------------


def list_addons() -> Operation[list[Addon]]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/addons"),
        decode=_list_of("addons", Addon.from_json),
    )


def get_addon(name: str) -> Operation[Addon]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/addons/{_segment(name)}"),
        decode=_one(Addon.from_json),
    )


def upload_addon(file_name: str, archive: bytes) -> Operation[Addon]:
    """Install an addon package (a zip archive with ``addon.json`` at its root).

    Uploaded addon code is imported into the server process and is therefore
    fully trusted. Deployments without a writable filesystem answer 501.
    """
    boundary = "webhookyaddonupload"
    escaped = file_name.replace("\\", "\\\\").replace('"', '\\"')
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            (
                'content-disposition: form-data; name="package"; '
                f'filename="{escaped}"\r\n'
            ).encode(),
            b"content-type: application/zip\r\n\r\n",
            archive,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    return Operation(
        spec=RequestSpec(
            "POST",
            f"{ADMIN_BASE}/addons",
            content=body,
            content_type=f"multipart/form-data; boundary={boundary}",
            send_origin=True,
        ),
        decode=_one(Addon.from_json),
    )


def delete_addon(name: str) -> Operation[None]:
    return Operation(
        spec=RequestSpec("DELETE", f"{ADMIN_BASE}/addons/{_segment(name)}"),
        decode=_none,
    )


# -- admin: admin keys and admin users ---------------------------------------


def list_admin_keys() -> Operation[list[AdminKey]]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/admin-keys"),
        decode=_list_of("keys", AdminKey.from_json),
    )


def create_admin_key(label: str) -> Operation[CreatedAdminKey]:
    return Operation(
        spec=RequestSpec(
            "POST", f"{ADMIN_BASE}/admin-keys", json_body={"label": label}
        ),
        decode=_one(CreatedAdminKey.from_json),
    )


def delete_admin_key(key_id: str) -> Operation[None]:
    return Operation(
        spec=RequestSpec("DELETE", f"{ADMIN_BASE}/admin-keys/{_segment(key_id)}"),
        decode=_none,
    )


def list_admin_users() -> Operation[list[AdminUser]]:
    return Operation(
        spec=RequestSpec("GET", f"{ADMIN_BASE}/admin-users"),
        decode=_list_of("adminUsers", AdminUser.from_json),
    )


def create_admin_user(subject: str) -> Operation[AdminUser]:
    return Operation(
        spec=RequestSpec(
            "POST", f"{ADMIN_BASE}/admin-users", json_body={"subject": subject}
        ),
        decode=_one(AdminUser.from_json),
    )


def delete_admin_user(subject: str) -> Operation[None]:
    return Operation(
        spec=RequestSpec("DELETE", f"{ADMIN_BASE}/admin-users/{_segment(subject)}"),
        decode=_none,
    )
