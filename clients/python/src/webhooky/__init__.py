"""Client library and CLI for a web-hooky server.

Three surfaces are covered: reading stored records, streaming them over
WebSocket, and administration. Nothing in the library reads the process
environment - credentials, base URL, timeouts and extra headers are passed
explicitly - so an embedding application decides where they come from. The
bundled ``webhooky`` CLI is the only part that consults ``WEBHOOKY_*``.

    from webhooky import FetchClient

    with FetchClient(
        base_url="https://hooks.example.com",
        api_key="...",
        api_secret="...",
    ) as client:
        for record in client.records(fetch_uuid, only_unfetched=True):
            print(record.t, record.payload)
"""

from .admin import AdminClient, AsyncAdminClient
from .config import (
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_USER_AGENT,
    VERSION,
    BaseUrls,
    ClientConfig,
    normalize_base_url,
)
from .errors import (
    KIND_BAD_REQUEST,
    KIND_CONFLICT,
    KIND_FORBIDDEN,
    KIND_INTERNAL,
    KIND_METHOD_NOT_ALLOWED,
    KIND_NOT_FOUND,
    KIND_NOT_IMPLEMENTED,
    KIND_PAYLOAD_TOO_LARGE,
    KIND_UNAUTHORIZED,
    KIND_UNPROCESSABLE_ENTITY,
    WebhookyError,
)
from .fetch import AsyncFetchClient, FetchClient
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
    RelayDelivery,
    RelayDeliveryPage,
    RelayDeliveryStats,
)
from .stream import StreamClosedByServer, StreamOptions

__version__ = VERSION

__all__ = [
    "AdminClient",
    "AdminIdentity",
    "AdminKey",
    "AdminUser",
    "Addon",
    "ApiUser",
    "AsyncAdminClient",
    "AsyncFetchClient",
    "BaseUrls",
    "ClientConfig",
    "CreatedAdminKey",
    "CreatedApiUser",
    "DEFAULT_TIMEOUT_SECONDS",
    "DEFAULT_USER_AGENT",
    "Destination",
    "FetchClient",
    "KIND_BAD_REQUEST",
    "KIND_CONFLICT",
    "KIND_FORBIDDEN",
    "KIND_INTERNAL",
    "KIND_METHOD_NOT_ALLOWED",
    "KIND_NOT_FOUND",
    "KIND_NOT_IMPLEMENTED",
    "KIND_PAYLOAD_TOO_LARGE",
    "KIND_UNAUTHORIZED",
    "KIND_UNPROCESSABLE_ENTITY",
    "Record",
    "Relay",
    "RelayDelivery",
    "RelayDeliveryPage",
    "RelayDeliveryStats",
    "StreamClosedByServer",
    "StreamOptions",
    "VERSION",
    "WebhookyError",
    "__version__",
    "normalize_base_url",
]
