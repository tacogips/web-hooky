"""The administrative surface: ``/_admin/api``.

An admin API key grants every admin capability, including reading destination
fetch UUIDs, so treat a configured client as a full-privilege handle.
"""

from __future__ import annotations

from typing import Any, Mapping

import httpx

from . import _ops as ops
from ._transport import run_async, run_sync
from .config import ClientConfig, build_config, split_credential
from .errors import WebhookyError
from .models import (
    Addon,
    AdminIdentity,
    AdminKey,
    AdminUser,
    ApiUser,
    CreatedAdminKey,
    CreatedApiUser,
    Destination,
    Record,
    Relay,
    RelayDeliveryPage,
)


def _admin_config(
    base_url: str,
    credential: str | None,
    key_id: str | None,
    secret: str | None,
    timeout_seconds: float | None,
    headers: dict[str, str] | None,
    user_agent: str | None,
) -> ClientConfig:
    """Resolve the admin credential.

    All three of ``credential``, the ``key_id``/``secret`` pair, and no
    credential at all are valid: a deployment fronted by an identity-provider
    proxy authenticates through ``headers`` instead.
    """
    resolved = (credential or "").strip()
    if not resolved and key_id and secret:
        resolved = f"{key_id}:{secret}"
    authorization = ""
    if resolved:
        # Validates the shape; a malformed credential should fail here rather
        # than as a puzzling 401 later.
        split_credential(resolved)
        authorization = f"Bearer {resolved}"
    elif not headers:
        raise WebhookyError(
            "admin credentials are required: pass credential=\"<keyId>:<secret>\", "
            "or headers={...} for an identity-provider deployment"
        )
    return build_config(
        base_url=base_url,
        authorization=authorization,
        timeout_seconds=timeout_seconds,
        headers=headers,
        user_agent=user_agent,
    )


class AdminClient:
    """Synchronous access to every ``/_admin/api`` endpoint."""

    def __init__(
        self,
        *,
        base_url: str,
        credential: str | None = None,
        key_id: str | None = None,
        secret: str | None = None,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
        user_agent: str | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._config = _admin_config(
            base_url, credential, key_id, secret, timeout_seconds, headers, user_agent
        )
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=self._config.timeout_seconds)

    @property
    def config(self) -> ClientConfig:
        return self._config

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "AdminClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _run(self, operation: ops.Operation[Any]) -> Any:
        return run_sync(self._http, self._config, operation)

    # -- identity ------------------------------------------------------------

    def me(self) -> AdminIdentity:
        """The identity the server resolved for these credentials."""
        return self._run(ops.me())

    # -- destinations --------------------------------------------------------

    def list_destinations(self) -> list[Destination]:
        return self._run(ops.list_destinations())

    def get_destination(self, destination_id: str) -> Destination:
        return self._run(ops.get_destination(destination_id))

    def create_destination(
        self,
        *,
        name: str,
        vendor_addon: str,
        destination_addon: str | None = None,
        vendor_config: Mapping[str, Any] | None = None,
        destination_config: Mapping[str, Any] | None = None,
        retention_seconds: int | None = None,
    ) -> Destination:
        """Register a destination.

        The result carries ``inbound_uuid`` to hand to the vendor and
        ``fetch_uuid`` for consumers.
        """
        return self._run(
            ops.create_destination(
                name=name,
                vendor_addon=vendor_addon,
                destination_addon=destination_addon,
                vendor_config=vendor_config,
                destination_config=destination_config,
                retention_seconds=retention_seconds,
            )
        )

    def update_destination(
        self, destination_id: str, patch: Mapping[str, Any]
    ) -> Destination:
        """Apply a partial update using server-side field names.

        Keys absent from ``patch`` are left alone; an explicit ``None`` clears
        the field.
        """
        return self._run(ops.update_destination(destination_id, patch))

    def delete_destination(self, destination_id: str) -> None:
        """Remove a destination and every record stored for it."""
        self._run(ops.delete_destination(destination_id))

    def rotate_fetch_uuid(self, destination_id: str) -> Destination:
        """Issue a new fetch UUID, invalidating the old read and stream URLs."""
        return self._run(ops.rotate_fetch_uuid(destination_id))

    def list_destination_records(
        self, destination_id: str, limit: int | None = None
    ) -> list[Record]:
        """Read records for administration; never marks anything as fetched."""
        return self._run(ops.list_destination_records(destination_id, limit))

    # -- relays --------------------------------------------------------------

    def list_relays(self, destination_id: str | None = None) -> list[Relay]:
        return self._run(ops.list_relays(destination_id))

    def get_relay(self, relay_id: str) -> Relay:
        return self._run(ops.get_relay(relay_id))

    def create_relay(
        self,
        *,
        destination_id: str,
        name: str,
        target_url: str,
        secret: str | None = None,
        enabled: bool | None = None,
        max_attempts: int | None = None,
        backoff_seconds: int | None = None,
        timeout_seconds: int | None = None,
    ) -> Relay:
        return self._run(
            ops.create_relay(
                destination_id=destination_id,
                name=name,
                target_url=target_url,
                secret=secret,
                enabled=enabled,
                max_attempts=max_attempts,
                backoff_seconds=backoff_seconds,
                timeout_seconds=timeout_seconds,
            )
        )

    def update_relay(self, relay_id: str, patch: Mapping[str, Any]) -> Relay:
        return self._run(ops.update_relay(relay_id, patch))

    def delete_relay(self, relay_id: str) -> None:
        self._run(ops.delete_relay(relay_id))

    def list_relay_deliveries(
        self, relay_id: str, limit: int | None = None
    ) -> RelayDeliveryPage:
        return self._run(ops.list_relay_deliveries(relay_id, limit))

    def retry_relay(self, relay_id: str) -> int:
        """Requeue this relay's failed deliveries; returns how many."""
        return self._run(ops.retry_relay(relay_id))

    # -- fetch API users -----------------------------------------------------

    def list_api_users(self) -> list[ApiUser]:
        return self._run(ops.list_api_users())

    def get_api_user(self, user_id: str) -> ApiUser:
        return self._run(ops.get_api_user(user_id))

    def create_api_user(self, label: str) -> CreatedApiUser:
        """Mint a key/secret pair. The secret is returned here and nowhere else."""
        return self._run(ops.create_api_user(label))

    def rotate_api_user_secret(self, user_id: str) -> CreatedApiUser:
        return self._run(ops.rotate_api_user_secret(user_id))

    def set_api_user_enabled(self, user_id: str, enabled: bool) -> ApiUser:
        return self._run(ops.set_api_user_enabled(user_id, enabled))

    def delete_api_user(self, user_id: str) -> None:
        self._run(ops.delete_api_user(user_id))

    def grant_destination(self, user_id: str, destination_id: str) -> ApiUser:
        """Authorize a fetch API user to read a destination."""
        return self._run(ops.grant_destination(user_id, destination_id))

    def revoke_destination(self, user_id: str, destination_id: str) -> ApiUser:
        """Withdraw a grant, closing the streams it authorized."""
        return self._run(ops.revoke_destination(user_id, destination_id))

    # -- addons --------------------------------------------------------------

    def list_addons(self) -> list[Addon]:
        return self._run(ops.list_addons())

    def get_addon(self, name: str) -> Addon:
        return self._run(ops.get_addon(name))

    def upload_addon(self, file_name: str, archive: bytes) -> Addon:
        return self._run(ops.upload_addon(file_name, archive))

    def delete_addon(self, name: str) -> None:
        self._run(ops.delete_addon(name))

    # -- admin keys and admin users ------------------------------------------

    def list_admin_keys(self) -> list[AdminKey]:
        return self._run(ops.list_admin_keys())

    def create_admin_key(self, label: str) -> CreatedAdminKey:
        """Mint an admin API key; the secret is returned exactly once."""
        return self._run(ops.create_admin_key(label))

    def delete_admin_key(self, key_id: str) -> None:
        self._run(ops.delete_admin_key(key_id))

    def list_admin_users(self) -> list[AdminUser]:
        return self._run(ops.list_admin_users())

    def create_admin_user(self, subject: str) -> AdminUser:
        return self._run(ops.create_admin_user(subject))

    def delete_admin_user(self, subject: str) -> None:
        self._run(ops.delete_admin_user(subject))


class AsyncAdminClient:
    """The asynchronous twin of :class:`AdminClient`."""

    def __init__(
        self,
        *,
        base_url: str,
        credential: str | None = None,
        key_id: str | None = None,
        secret: str | None = None,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
        user_agent: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = _admin_config(
            base_url, credential, key_id, secret, timeout_seconds, headers, user_agent
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

    async def __aenter__(self) -> "AsyncAdminClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def _run(self, operation: ops.Operation[Any]) -> Any:
        return await run_async(self._http, self._config, operation)

    async def me(self) -> AdminIdentity:
        return await self._run(ops.me())

    async def list_destinations(self) -> list[Destination]:
        return await self._run(ops.list_destinations())

    async def get_destination(self, destination_id: str) -> Destination:
        return await self._run(ops.get_destination(destination_id))

    async def create_destination(
        self,
        *,
        name: str,
        vendor_addon: str,
        destination_addon: str | None = None,
        vendor_config: Mapping[str, Any] | None = None,
        destination_config: Mapping[str, Any] | None = None,
        retention_seconds: int | None = None,
    ) -> Destination:
        return await self._run(
            ops.create_destination(
                name=name,
                vendor_addon=vendor_addon,
                destination_addon=destination_addon,
                vendor_config=vendor_config,
                destination_config=destination_config,
                retention_seconds=retention_seconds,
            )
        )

    async def update_destination(
        self, destination_id: str, patch: Mapping[str, Any]
    ) -> Destination:
        return await self._run(ops.update_destination(destination_id, patch))

    async def delete_destination(self, destination_id: str) -> None:
        await self._run(ops.delete_destination(destination_id))

    async def rotate_fetch_uuid(self, destination_id: str) -> Destination:
        return await self._run(ops.rotate_fetch_uuid(destination_id))

    async def list_destination_records(
        self, destination_id: str, limit: int | None = None
    ) -> list[Record]:
        return await self._run(ops.list_destination_records(destination_id, limit))

    async def list_relays(self, destination_id: str | None = None) -> list[Relay]:
        return await self._run(ops.list_relays(destination_id))

    async def get_relay(self, relay_id: str) -> Relay:
        return await self._run(ops.get_relay(relay_id))

    async def create_relay(
        self,
        *,
        destination_id: str,
        name: str,
        target_url: str,
        secret: str | None = None,
        enabled: bool | None = None,
        max_attempts: int | None = None,
        backoff_seconds: int | None = None,
        timeout_seconds: int | None = None,
    ) -> Relay:
        return await self._run(
            ops.create_relay(
                destination_id=destination_id,
                name=name,
                target_url=target_url,
                secret=secret,
                enabled=enabled,
                max_attempts=max_attempts,
                backoff_seconds=backoff_seconds,
                timeout_seconds=timeout_seconds,
            )
        )

    async def update_relay(self, relay_id: str, patch: Mapping[str, Any]) -> Relay:
        return await self._run(ops.update_relay(relay_id, patch))

    async def delete_relay(self, relay_id: str) -> None:
        await self._run(ops.delete_relay(relay_id))

    async def list_relay_deliveries(
        self, relay_id: str, limit: int | None = None
    ) -> RelayDeliveryPage:
        return await self._run(ops.list_relay_deliveries(relay_id, limit))

    async def retry_relay(self, relay_id: str) -> int:
        return await self._run(ops.retry_relay(relay_id))

    async def list_api_users(self) -> list[ApiUser]:
        return await self._run(ops.list_api_users())

    async def get_api_user(self, user_id: str) -> ApiUser:
        return await self._run(ops.get_api_user(user_id))

    async def create_api_user(self, label: str) -> CreatedApiUser:
        return await self._run(ops.create_api_user(label))

    async def rotate_api_user_secret(self, user_id: str) -> CreatedApiUser:
        return await self._run(ops.rotate_api_user_secret(user_id))

    async def set_api_user_enabled(self, user_id: str, enabled: bool) -> ApiUser:
        return await self._run(ops.set_api_user_enabled(user_id, enabled))

    async def delete_api_user(self, user_id: str) -> None:
        await self._run(ops.delete_api_user(user_id))

    async def grant_destination(self, user_id: str, destination_id: str) -> ApiUser:
        return await self._run(ops.grant_destination(user_id, destination_id))

    async def revoke_destination(self, user_id: str, destination_id: str) -> ApiUser:
        return await self._run(ops.revoke_destination(user_id, destination_id))

    async def list_addons(self) -> list[Addon]:
        return await self._run(ops.list_addons())

    async def get_addon(self, name: str) -> Addon:
        return await self._run(ops.get_addon(name))

    async def upload_addon(self, file_name: str, archive: bytes) -> Addon:
        return await self._run(ops.upload_addon(file_name, archive))

    async def delete_addon(self, name: str) -> None:
        await self._run(ops.delete_addon(name))

    async def list_admin_keys(self) -> list[AdminKey]:
        return await self._run(ops.list_admin_keys())

    async def create_admin_key(self, label: str) -> CreatedAdminKey:
        return await self._run(ops.create_admin_key(label))

    async def delete_admin_key(self, key_id: str) -> None:
        await self._run(ops.delete_admin_key(key_id))

    async def list_admin_users(self) -> list[AdminUser]:
        return await self._run(ops.list_admin_users())

    async def create_admin_user(self, subject: str) -> AdminUser:
        return await self._run(ops.create_admin_user(subject))

    async def delete_admin_user(self, subject: str) -> None:
        await self._run(ops.delete_admin_user(subject))
