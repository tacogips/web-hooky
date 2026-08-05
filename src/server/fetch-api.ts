/**
 * Fetch API: `GET /_get/{fetch_uuid}`.
 */
import { type AppError, errors } from "../core/errors";
import type { JsonValue } from "../core/json";
import { err, ok, type Result } from "../core/result";
import { parseTimeBound } from "../core/time";
import type { AppConfig } from "../config";
import { toPublicRecord, type RecordQuery } from "../storage/types";
import type { AppContext } from "./context";
import { authorizeFetchConsumer, findDestinationByFetchUuid } from "./lookups";
import { errorResponse, jsonResponse } from "./responses";

export interface FetchQuery {
  readonly onlyUnfetched: boolean;
  readonly from: number | null;
  readonly to: number | null;
  readonly limit: number;
  readonly markFetched: boolean;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBooleanParam(
  raw: string | null,
  fallback: boolean,
  name: string,
): Result<boolean, AppError> {
  if (raw === null || raw.length === 0) {
    return ok(fallback);
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return ok(true);
  }
  if (FALSE_VALUES.has(normalized)) {
    return ok(false);
  }
  return err(errors.badRequest(`Parameter "${name}" must be a boolean`));
}

function parseBound(
  raw: string | null,
  name: string,
): Result<number | null, AppError> {
  if (raw === null || raw.trim().length === 0) {
    return ok(null);
  }
  const parsed = parseTimeBound(raw);
  if (parsed === null) {
    return err(
      errors.badRequest(
        `Parameter "${name}" must be unix seconds or an ISO-8601 timestamp`,
      ),
    );
  }
  return ok(parsed);
}

/** Parses and validates the `_get` query string. */
export function parseFetchQuery(
  url: URL,
  config: AppConfig,
): Result<FetchQuery, AppError> {
  const onlyUnfetched = parseBooleanParam(
    url.searchParams.get("only_unfetched"),
    false,
    "only_unfetched",
  );
  if (onlyUnfetched.ok === false) {
    return err(onlyUnfetched.error);
  }

  const markFetched = parseBooleanParam(
    url.searchParams.get("mark_fetched"),
    true,
    "mark_fetched",
  );
  if (markFetched.ok === false) {
    return err(markFetched.error);
  }

  const from = parseBound(url.searchParams.get("from"), "from");
  if (from.ok === false) {
    return err(from.error);
  }
  const to = parseBound(url.searchParams.get("to"), "to");
  if (to.ok === false) {
    return err(to.error);
  }
  if (from.value !== null && to.value !== null && from.value > to.value) {
    return err(errors.badRequest('Parameter "from" must not be after "to"'));
  }

  const rawLimit = url.searchParams.get("limit");
  let limit = config.defaultFetchLimit;
  if (rawLimit !== null && rawLimit.trim().length > 0) {
    const parsed = Number.parseInt(rawLimit.trim(), 10);
    if (Number.isFinite(parsed) === false || parsed < 1) {
      return err(
        errors.badRequest('Parameter "limit" must be a positive integer'),
      );
    }
    limit = Math.min(parsed, config.maxFetchLimit);
  }

  return ok({
    onlyUnfetched: onlyUnfetched.value,
    from: from.value,
    to: to.value,
    limit,
    markFetched: markFetched.value,
  });
}

export async function handleFetchRecords(
  ctx: AppContext,
  request: Request,
  url: URL,
  fetchUuid: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  const destination = await findDestinationByFetchUuid(ctx, fetchUuid);
  if (destination === null) {
    return errorResponse(errors.notFound("Unknown fetch endpoint"));
  }
  // Disabling a destination stops every public surface, not just ingest.
  // Administrators can still read stored records through
  // `GET /_admin/api/records/{destinationId}`.
  if (destination.enabled === false) {
    return errorResponse(errors.forbidden("Destination is disabled"));
  }

  // `null` for the URL: query-string credentials are accepted only on the
  // WebSocket handshake, where headers cannot be set. Keeping secrets out of
  // `_get` URLs avoids leaking them into proxy and browser history logs.
  const authorized = await authorizeFetchConsumer(
    ctx,
    request,
    null,
    destination,
  );
  if (authorized.ok === false) {
    return errorResponse(authorized.error);
  }

  const query = parseFetchQuery(url, ctx.config);
  if (query.ok === false) {
    return errorResponse(query.error);
  }

  const recordQuery: RecordQuery = {
    destinationId: destination.id,
    onlyUnfetched: query.value.onlyUnfetched,
    from: query.value.from,
    to: query.value.to,
    limit: query.value.limit,
  };

  const records = query.value.markFetched
    ? await ctx.persistence.records.queryAndMark(recordQuery)
    : await ctx.persistence.records.query(recordQuery);

  // `fetched` reflects the state before this call marked the records, so a
  // client can tell which records it is seeing for the first time.
  const payload: JsonValue = {
    records: records.map((record) => {
      const publicRecord = toPublicRecord(record);
      return {
        t: publicRecord.t,
        fetched: publicRecord.fetched,
        payload: publicRecord.payload,
      };
    }),
  };
  return jsonResponse(payload);
}
