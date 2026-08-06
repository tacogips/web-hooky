"""Typed models for the values the server returns.

Each model decodes from the server's JSON with :meth:`from_json` and keeps the
raw mapping in ``raw``, so a field added by a newer server is still reachable
without upgrading the client.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

JsonObject = Mapping[str, Any]


def _string(data: JsonObject, key: str, default: str = "") -> str:
    value = data.get(key)
    return value if isinstance(value, str) else default


def _optional_string(data: JsonObject, key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None


def _integer(data: JsonObject, key: str, default: int = 0) -> int:
    value = data.get(key)
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _optional_integer(data: JsonObject, key: str) -> int | None:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _boolean(data: JsonObject, key: str, default: bool = False) -> bool:
    value = data.get(key)
    return value if isinstance(value, bool) else default


@dataclass(frozen=True)
class Record:
    """One stored webhook payload, as the fetch surfaces return it."""

    t: int
    """Receipt time in unix seconds."""
    fetched: bool
    """The flag's value *before* the reading call marked it, so a consumer can
    tell which records it is seeing for the first time."""
    payload: Any
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "Record":
        return cls(
            t=_integer(data, "t"),
            fetched=_boolean(data, "fetched"),
            payload=data.get("payload"),
            raw=data,
        )


@dataclass(frozen=True)
class Destination:
    """The admin projection of a configured webhook endpoint.

    ``fetch_uuid`` is returned by the admin API only: it is the secret half of
    the read and stream URLs.
    """

    id: str
    name: str
    vendor_addon: str
    destination_addon: str | None
    inbound_uuid: str
    inbound_path: str
    fetch_uuid: str
    fetch_path: str
    stream_path: str
    vendor_config: Any
    destination_config: Any
    retention_seconds: int | None
    enabled: bool
    created_at: int
    created_by: str | None
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "Destination":
        return cls(
            id=_string(data, "id"),
            name=_string(data, "name"),
            vendor_addon=_string(data, "vendorAddon"),
            destination_addon=_optional_string(data, "destinationAddon"),
            inbound_uuid=_string(data, "inboundUuid"),
            inbound_path=_string(data, "inboundPath"),
            fetch_uuid=_string(data, "fetchUuid"),
            fetch_path=_string(data, "fetchPath"),
            stream_path=_string(data, "streamPath"),
            vendor_config=data.get("vendorConfig"),
            destination_config=data.get("destinationConfig"),
            retention_seconds=_optional_integer(data, "retentionSeconds"),
            enabled=_boolean(data, "enabled"),
            created_at=_integer(data, "createdAt"),
            created_by=_optional_string(data, "createdBy"),
            raw=data,
        )


@dataclass(frozen=True)
class ApiUser:
    """A fetch-capable API key and the destinations it may read."""

    id: str
    label: str
    enabled: bool
    created_at: int
    grants: Sequence[str]
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "ApiUser":
        grants = data.get("grants")
        return cls(
            id=_string(data, "id"),
            label=_string(data, "label"),
            enabled=_boolean(data, "enabled"),
            created_at=_integer(data, "createdAt"),
            grants=tuple(g for g in grants if isinstance(g, str))
            if isinstance(grants, list)
            else (),
            raw=data,
        )


@dataclass(frozen=True)
class CreatedApiUser(ApiUser):
    """An API user plus the secret the server returns exactly once.

    A separate type from :class:`ApiUser` on purpose: a listing can never be
    mistaken for something that carries a secret.
    """

    secret: str = ""
    credential: str = ""

    @classmethod
    def from_json(cls, data: JsonObject) -> "CreatedApiUser":
        base = ApiUser.from_json(data)
        return cls(
            id=base.id,
            label=base.label,
            enabled=base.enabled,
            created_at=base.created_at,
            grants=base.grants,
            raw=data,
            secret=_string(data, "secret"),
            credential=_string(data, "credential"),
        )


@dataclass(frozen=True)
class RelayDeliveryStats:
    """Delivery counts per status for one relay."""

    pending: int
    delivered: int
    failed: int

    @classmethod
    def from_json(cls, data: JsonObject) -> "RelayDeliveryStats":
        return cls(
            pending=_integer(data, "pending"),
            delivered=_integer(data, "delivered"),
            failed=_integer(data, "failed"),
        )


@dataclass(frozen=True)
class Relay:
    """A forwarding target attached to a destination.

    The signing secret is never returned; ``has_secret`` reports only whether
    one is configured.
    """

    id: str
    destination_id: str
    name: str
    target_url: str
    has_secret: bool
    enabled: bool
    max_attempts: int
    backoff_seconds: int
    timeout_seconds: int
    created_at: int
    created_by: str | None
    delivery_stats: RelayDeliveryStats | None
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "Relay":
        stats = data.get("deliveryStats")
        return cls(
            id=_string(data, "id"),
            destination_id=_string(data, "destinationId"),
            name=_string(data, "name"),
            target_url=_string(data, "targetUrl"),
            has_secret=_boolean(data, "hasSecret"),
            enabled=_boolean(data, "enabled"),
            max_attempts=_integer(data, "maxAttempts"),
            backoff_seconds=_integer(data, "backoffSeconds"),
            timeout_seconds=_integer(data, "timeoutSeconds"),
            created_at=_integer(data, "createdAt"),
            created_by=_optional_string(data, "createdBy"),
            delivery_stats=RelayDeliveryStats.from_json(stats)
            if isinstance(stats, dict)
            else None,
            raw=data,
        )


@dataclass(frozen=True)
class RelayDelivery:
    """One queued delivery of one record to one relay."""

    id: str
    relay_id: str
    record_id: str
    t: int
    status: str
    attempts: int
    next_attempt_at: int
    last_status_code: int | None
    last_error: str | None
    created_at: int
    updated_at: int
    delivered_at: int | None
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "RelayDelivery":
        return cls(
            id=_string(data, "id"),
            relay_id=_string(data, "relayId"),
            record_id=_string(data, "recordId"),
            t=_integer(data, "t"),
            status=_string(data, "status"),
            attempts=_integer(data, "attempts"),
            next_attempt_at=_integer(data, "nextAttemptAt"),
            last_status_code=_optional_integer(data, "lastStatusCode"),
            last_error=_optional_string(data, "lastError"),
            created_at=_integer(data, "createdAt"),
            updated_at=_integer(data, "updatedAt"),
            delivered_at=_optional_integer(data, "deliveredAt"),
            raw=data,
        )


@dataclass(frozen=True)
class RelayDeliveryPage:
    """A page of deliveries plus the relay's totals."""

    deliveries: Sequence[RelayDelivery]
    stats: RelayDeliveryStats

    @classmethod
    def from_json(cls, data: JsonObject) -> "RelayDeliveryPage":
        raw_deliveries = data.get("deliveries")
        stats = data.get("stats")
        return cls(
            deliveries=tuple(
                RelayDelivery.from_json(item)
                for item in (raw_deliveries if isinstance(raw_deliveries, list) else [])
                if isinstance(item, dict)
            ),
            stats=RelayDeliveryStats.from_json(stats if isinstance(stats, dict) else {}),
        )


@dataclass(frozen=True)
class Addon:
    """A registered vendor or destination addon."""

    name: str
    version: str
    kind: str
    description: str
    source: str
    has_authenticate: bool
    has_transform: bool
    accepts_schema: Any
    returns_schema: Any
    config_schema: Any
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "Addon":
        return cls(
            name=_string(data, "name"),
            version=_string(data, "version"),
            kind=_string(data, "kind"),
            description=_string(data, "description"),
            source=_string(data, "source"),
            has_authenticate=_boolean(data, "hasAuthenticate"),
            has_transform=_boolean(data, "hasTransform"),
            accepts_schema=data.get("acceptsSchema"),
            returns_schema=data.get("returnsSchema"),
            config_schema=data.get("configSchema"),
            raw=data,
        )


@dataclass(frozen=True)
class AdminKey:
    """An admin-privileged API key."""

    id: str
    label: str
    enabled: bool
    created_at: int
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "AdminKey":
        return cls(
            id=_string(data, "id"),
            label=_string(data, "label"),
            enabled=_boolean(data, "enabled"),
            created_at=_integer(data, "createdAt"),
            raw=data,
        )


@dataclass(frozen=True)
class CreatedAdminKey(AdminKey):
    """An admin key plus the secret the server returns exactly once."""

    secret: str = ""
    credential: str = ""

    @classmethod
    def from_json(cls, data: JsonObject) -> "CreatedAdminKey":
        base = AdminKey.from_json(data)
        return cls(
            id=base.id,
            label=base.label,
            enabled=base.enabled,
            created_at=base.created_at,
            raw=data,
            secret=_string(data, "secret"),
            credential=_string(data, "credential"),
        )


@dataclass(frozen=True)
class AdminUser:
    """An identity-provider subject allowed into the admin surface."""

    subject: str
    role: str
    created_at: int
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "AdminUser":
        return cls(
            subject=_string(data, "subject"),
            role=_string(data, "role"),
            created_at=_integer(data, "createdAt"),
            raw=data,
        )


@dataclass(frozen=True)
class AdminIdentity:
    """The identity the server resolved for the caller's credentials."""

    subject: str
    via_api_key: bool
    key_id: str | None
    admin_auth_provider: str
    raw: JsonObject = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, data: JsonObject) -> "AdminIdentity":
        return cls(
            subject=_string(data, "subject"),
            via_api_key=_boolean(data, "viaApiKey"),
            key_id=_optional_string(data, "keyId"),
            admin_auth_provider=_string(data, "adminAuthProvider"),
            raw=data,
        )
