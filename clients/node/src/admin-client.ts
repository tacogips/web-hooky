/**
 * The administrative surface: `/_admin/api`.
 *
 * An admin API key grants every admin capability, including reading destination
 * fetch UUIDs, so treat a configured client as a full-privilege handle.
 */
import {
  type AdminClientConfig,
  resolveAdminConfig,
  type ResolvedConfig,
} from "./config.js";
import {
  asObject,
  asVoid,
  pathSegment,
  pruneUndefined,
  requestJson,
  unwrapList,
} from "./http.js";
import type {
  Addon,
  AdminIdentity,
  AdminKey,
  AdminUser,
  ApiUser,
  CreateDestinationInput,
  CreateRelayInput,
  CreatedAdminKey,
  CreatedApiUser,
  Destination,
  Relay,
  RelayDeliveryPage,
  UpdateDestinationInput,
  UpdateRelayInput,
  WebhookRecord,
} from "./types.js";

const ADMIN_BASE = "/_admin/api";

/** Builds the multipart body for an addon package upload. */
function multipartAddon(
  fileName: string,
  archive: Uint8Array,
): { readonly body: Uint8Array; readonly contentType: string } {
  const boundary = "webhookyaddonupload";
  const escaped = fileName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="package"; filename="${escaped}"\r\n` +
      "content-type: application/zip\r\n\r\n",
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(head.length + archive.length + tail.length);
  body.set(head, 0);
  body.set(archive, head.length);
  body.set(tail, head.length + archive.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Typed access to every `/_admin/api` endpoint.
 *
 * ```ts
 * const admin = new WebhookyAdminClient({ baseUrl, credential: "id:secret" });
 * const destination = await admin.createDestination({
 *   name: "wrike prod",
 *   vendorAddon: "wrike",
 *   vendorConfig: { secret: "wrike-webhook-secret" },
 * });
 * ```
 */
export class WebhookyAdminClient {
  private readonly resolved: ResolvedConfig;

  constructor(config: AdminClientConfig) {
    this.resolved = resolveAdminConfig(config);
  }

  get config(): ResolvedConfig {
    return this.resolved;
  }

  /** The identity the server resolved for these credentials. */
  me(): Promise<AdminIdentity> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/me` },
      asObject<AdminIdentity>,
    );
  }

  // -- destinations ----------------------------------------------------------

  listDestinations(): Promise<readonly Destination[]> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/destinations` },
      unwrapList<Destination>("destinations"),
    );
  }

  getDestination(id: string): Promise<Destination> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/destinations/${pathSegment(id)}` },
      asObject<Destination>,
    );
  }

  /**
   * Registers a destination.
   *
   * The result carries `inboundUuid` to hand to the vendor and `fetchUuid` for
   * consumers.
   */
  createDestination(input: CreateDestinationInput): Promise<Destination> {
    return requestJson(
      this.resolved,
      {
        method: "POST",
        path: `${ADMIN_BASE}/destinations`,
        body: pruneUndefined(input),
      },
      asObject<Destination>,
    );
  }

  /** Applies a partial update; omitted fields are left alone. */
  updateDestination(
    id: string,
    input: UpdateDestinationInput,
  ): Promise<Destination> {
    return requestJson(
      this.resolved,
      {
        method: "PATCH",
        path: `${ADMIN_BASE}/destinations/${pathSegment(id)}`,
        body: pruneUndefined(input),
      },
      asObject<Destination>,
    );
  }

  /** Removes a destination and every record stored for it. */
  deleteDestination(id: string): Promise<void> {
    return requestJson(
      this.resolved,
      {
        method: "DELETE",
        path: `${ADMIN_BASE}/destinations/${pathSegment(id)}`,
      },
      asVoid,
    );
  }

  /** Issues a new fetch UUID, invalidating the old read and stream URLs. */
  rotateFetchUuid(id: string): Promise<Destination> {
    return requestJson(
      this.resolved,
      {
        method: "POST",
        path: `${ADMIN_BASE}/destinations/${pathSegment(id)}/rotate-fetch-uuid`,
      },
      asObject<Destination>,
    );
  }

  /** Reads records for administration; never marks anything as fetched. */
  listDestinationRecords(
    destinationId: string,
    limit?: number,
  ): Promise<readonly WebhookRecord[]> {
    return requestJson(
      this.resolved,
      {
        method: "GET",
        path: `${ADMIN_BASE}/records/${pathSegment(destinationId)}`,
        query: limit !== undefined && limit > 0 ? { limit: String(limit) } : {},
      },
      unwrapList<WebhookRecord>("records"),
    );
  }

  // -- relays ----------------------------------------------------------------

  listRelays(destinationId?: string): Promise<readonly Relay[]> {
    return requestJson(
      this.resolved,
      {
        method: "GET",
        path: `${ADMIN_BASE}/relays`,
        query:
          destinationId !== undefined && destinationId.length > 0
            ? { destinationId }
            : {},
      },
      unwrapList<Relay>("relays"),
    );
  }

  getRelay(id: string): Promise<Relay> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/relays/${pathSegment(id)}` },
      asObject<Relay>,
    );
  }

  createRelay(input: CreateRelayInput): Promise<Relay> {
    return requestJson(
      this.resolved,
      {
        method: "POST",
        path: `${ADMIN_BASE}/relays`,
        body: pruneUndefined(input),
      },
      asObject<Relay>,
    );
  }

  /** A `secret` of `null` clears the signing secret; omitting it keeps it. */
  updateRelay(id: string, input: UpdateRelayInput): Promise<Relay> {
    return requestJson(
      this.resolved,
      {
        method: "PATCH",
        path: `${ADMIN_BASE}/relays/${pathSegment(id)}`,
        body: pruneUndefined(input),
      },
      asObject<Relay>,
    );
  }

  deleteRelay(id: string): Promise<void> {
    return requestJson(
      this.resolved,
      { method: "DELETE", path: `${ADMIN_BASE}/relays/${pathSegment(id)}` },
      asVoid,
    );
  }

  listRelayDeliveries(id: string, limit?: number): Promise<RelayDeliveryPage> {
    return requestJson(
      this.resolved,
      {
        method: "GET",
        path: `${ADMIN_BASE}/relays/${pathSegment(id)}/deliveries`,
        query: limit !== undefined && limit > 0 ? { limit: String(limit) } : {},
      },
      asObject<RelayDeliveryPage>,
    );
  }

  /** Requeues this relay's failed deliveries; resolves to how many. */
  async retryRelay(id: string): Promise<number> {
    const result = await requestJson(
      this.resolved,
      { method: "POST", path: `${ADMIN_BASE}/relays/${pathSegment(id)}/retry` },
      asObject<{ requeued?: number }>,
    );
    return typeof result.requeued === "number" ? result.requeued : 0;
  }

  // -- fetch API users -------------------------------------------------------

  listApiUsers(): Promise<readonly ApiUser[]> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/users` },
      unwrapList<ApiUser>("users"),
    );
  }

  getApiUser(id: string): Promise<ApiUser> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/users/${pathSegment(id)}` },
      asObject<ApiUser>,
    );
  }

  /** Mints a key/secret pair. The secret is returned here and nowhere else. */
  createApiUser(label: string): Promise<CreatedApiUser> {
    return requestJson(
      this.resolved,
      { method: "POST", path: `${ADMIN_BASE}/users`, body: { label } },
      asObject<CreatedApiUser>,
    );
  }

  rotateApiUserSecret(id: string): Promise<CreatedApiUser> {
    return requestJson(
      this.resolved,
      { method: "POST", path: `${ADMIN_BASE}/users/${pathSegment(id)}/rotate` },
      asObject<CreatedApiUser>,
    );
  }

  setApiUserEnabled(id: string, enabled: boolean): Promise<ApiUser> {
    return requestJson(
      this.resolved,
      {
        method: "PATCH",
        path: `${ADMIN_BASE}/users/${pathSegment(id)}`,
        body: { enabled },
      },
      asObject<ApiUser>,
    );
  }

  deleteApiUser(id: string): Promise<void> {
    return requestJson(
      this.resolved,
      { method: "DELETE", path: `${ADMIN_BASE}/users/${pathSegment(id)}` },
      asVoid,
    );
  }

  /** Authorizes a fetch API user to read a destination. */
  grantDestination(userId: string, destinationId: string): Promise<ApiUser> {
    return requestJson(
      this.resolved,
      {
        method: "PUT",
        path:
          `${ADMIN_BASE}/users/${pathSegment(userId)}` +
          `/grants/${pathSegment(destinationId)}`,
      },
      asObject<ApiUser>,
    );
  }

  /** Withdraws a grant, closing the streams it authorized. */
  revokeDestination(userId: string, destinationId: string): Promise<ApiUser> {
    return requestJson(
      this.resolved,
      {
        method: "DELETE",
        path:
          `${ADMIN_BASE}/users/${pathSegment(userId)}` +
          `/grants/${pathSegment(destinationId)}`,
      },
      asObject<ApiUser>,
    );
  }

  // -- addons ----------------------------------------------------------------

  listAddons(): Promise<readonly Addon[]> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/addons` },
      unwrapList<Addon>("addons"),
    );
  }

  getAddon(name: string): Promise<Addon> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/addons/${pathSegment(name)}` },
      asObject<Addon>,
    );
  }

  /**
   * Installs an addon package (a zip archive with `addon.json` at its root).
   *
   * Uploaded addon code is imported into the server process and is therefore
   * fully trusted. Deployments without a writable filesystem answer 501.
   */
  uploadAddon(fileName: string, archive: Uint8Array): Promise<Addon> {
    const { body, contentType } = multipartAddon(fileName, archive);
    // Multipart cannot use the JSON content type that satisfies the server's
    // CSRF rule, so this request carries a matching Origin instead.
    return requestJson(
      this.resolved,
      {
        method: "POST",
        path: `${ADMIN_BASE}/addons`,
        rawBody: body,
        contentType,
        sendOrigin: true,
      },
      asObject<Addon>,
    );
  }

  deleteAddon(name: string): Promise<void> {
    return requestJson(
      this.resolved,
      { method: "DELETE", path: `${ADMIN_BASE}/addons/${pathSegment(name)}` },
      asVoid,
    );
  }

  // -- admin keys and admin users --------------------------------------------

  listAdminKeys(): Promise<readonly AdminKey[]> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/admin-keys` },
      unwrapList<AdminKey>("keys"),
    );
  }

  /** Mints an admin API key; the secret is returned exactly once. */
  createAdminKey(label: string): Promise<CreatedAdminKey> {
    return requestJson(
      this.resolved,
      { method: "POST", path: `${ADMIN_BASE}/admin-keys`, body: { label } },
      asObject<CreatedAdminKey>,
    );
  }

  deleteAdminKey(id: string): Promise<void> {
    return requestJson(
      this.resolved,
      { method: "DELETE", path: `${ADMIN_BASE}/admin-keys/${pathSegment(id)}` },
      asVoid,
    );
  }

  listAdminUsers(): Promise<readonly AdminUser[]> {
    return requestJson(
      this.resolved,
      { method: "GET", path: `${ADMIN_BASE}/admin-users` },
      unwrapList<AdminUser>("adminUsers"),
    );
  }

  createAdminUser(subject: string): Promise<AdminUser> {
    return requestJson(
      this.resolved,
      { method: "POST", path: `${ADMIN_BASE}/admin-users`, body: { subject } },
      asObject<AdminUser>,
    );
  }

  deleteAdminUser(subject: string): Promise<void> {
    return requestJson(
      this.resolved,
      {
        method: "DELETE",
        path: `${ADMIN_BASE}/admin-users/${pathSegment(subject)}`,
      },
      asVoid,
    );
  }
}
