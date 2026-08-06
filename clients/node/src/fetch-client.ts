/**
 * Reading and streaming a destination's records.
 */
import {
  type FetchClientConfig,
  resolveFetchConfig,
  type ResolvedConfig,
} from "./config.js";
import { pathSegment, requestJson, unwrapList } from "./http.js";
import { streamRecords, type StreamOptions } from "./stream.js";
import type { RecordQuery, WebhookRecord } from "./types.js";

function timeParam(value: number | string | Date): string {
  if (value instanceof Date) {
    return String(Math.floor(value.getTime() / 1000));
  }
  // A string is passed through: the server parses ISO-8601 itself, and
  // reinterpreting it here would only introduce a second parser to disagree.
  return typeof value === "string" ? value : String(Math.floor(value));
}

/**
 * Builds the `_get` query string.
 *
 * Only parameters that differ from the server's own defaults are emitted, so a
 * plain call produces a bare URL.
 */
export function buildRecordQuery(query: RecordQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.onlyUnfetched === true) {
    params["only_unfetched"] = "true";
  }
  if (query.markFetched === false) {
    params["mark_fetched"] = "false";
  }
  if (query.from !== undefined) {
    params["from"] = timeParam(query.from);
  }
  if (query.to !== undefined) {
    params["to"] = timeParam(query.to);
  }
  if (query.limit !== undefined && query.limit > 0) {
    params["limit"] = String(Math.floor(query.limit));
  }
  return params;
}

/**
 * Reads and streams records for a fetch API user.
 *
 * Credentials are passed to the constructor, not read from the environment, so
 * one process can hold several clients with different identities.
 *
 * ```ts
 * const client = new WebhookyFetchClient({ baseUrl, apiKey, apiSecret });
 * const records = await client.records(fetchUuid, { onlyUnfetched: true });
 * for await (const record of client.stream(fetchUuid)) {
 *   console.log(record.payload);
 * }
 * ```
 */
export class WebhookyFetchClient {
  private readonly resolved: ResolvedConfig;

  constructor(config: FetchClientConfig) {
    this.resolved = resolveFetchConfig(config);
  }

  /** The validated configuration, for diagnostics and the stream URL. */
  get config(): ResolvedConfig {
    return this.resolved;
  }

  /**
   * Reads stored records, newest first.
   *
   * Unless `markFetched` is turned off the server marks what it returns as
   * fetched; each record's `fetched` field reflects the value from before that
   * marking.
   */
  records(
    fetchUuid: string,
    query: RecordQuery = {},
  ): Promise<readonly WebhookRecord[]> {
    return requestJson(
      this.resolved,
      {
        method: "GET",
        path: `/_get/${pathSegment(fetchUuid)}`,
        query: buildRecordQuery(query),
      },
      unwrapList<WebhookRecord>("records"),
    );
  }

  /**
   * Streams records over WebSocket.
   *
   * The iterator ends when the server closes the socket, when `maxRecords` is
   * reached, or when the caller breaks out of the loop - which closes the
   * socket.
   */
  stream(
    fetchUuid: string,
    options: StreamOptions = {},
  ): AsyncIterableIterator<WebhookRecord> {
    return streamRecords(this.resolved, fetchUuid, options);
  }
}
