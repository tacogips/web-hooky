/**
 * Client library for a web-hooky server.
 *
 * Three surfaces are covered: reading stored records, streaming them over
 * WebSocket, and administration. Nothing in the library reads `process.env` -
 * credentials, base URL, timeouts and extra headers are constructor
 * parameters - so an embedding application decides where they come from. The
 * bundled `webhooky` CLI is the only part that consults `WEBHOOKY_*`.
 *
 * ```ts
 * import { WebhookyFetchClient } from "@web-hooky/client";
 *
 * const client = new WebhookyFetchClient({
 *   baseUrl: "https://hooks.example.com",
 *   apiKey: "...",
 *   apiSecret: "...",
 * });
 * const records = await client.records(fetchUuid, { onlyUnfetched: true });
 * ```
 */
export { WebhookyAdminClient } from "./admin-client.js";
export {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_USER_AGENT,
  normalizeBaseUrl,
  splitCredential,
  VERSION,
  type AdminClientConfig,
  type BaseUrls,
  type FetchClientConfig,
  type ResolvedConfig,
} from "./config.js";
export { WebhookyError, WebhookyErrorKind } from "./errors.js";
export { buildRecordQuery, WebhookyFetchClient } from "./fetch-client.js";
export {
  backoffFor,
  buildStreamUrl,
  decodeFrame,
  POLICY_VIOLATION,
  StreamClosedByServerError,
  type StreamFrame,
  type StreamOptions,
} from "./stream.js";
export type {
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
  JsonObject,
  JsonValue,
  RecordQuery,
  Relay,
  RelayDelivery,
  RelayDeliveryPage,
  RelayDeliveryStats,
  UpdateDestinationInput,
  UpdateRelayInput,
  WebhookRecord,
} from "./types.js";
export { RelayDeliveryStatus } from "./types.js";
