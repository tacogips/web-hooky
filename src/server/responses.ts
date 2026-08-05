/**
 * HTTP response helpers and the shared error envelope.
 */
import {
  appError,
  AppErrorKind,
  type AppError,
  statusForErrorKind,
} from "../core/errors";
import { newUuid } from "../core/ids";
import type { JsonValue } from "../core/json";

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** Serialises a JSON body with the standard headers. */
export function jsonResponse(
  body: JsonValue,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** Renders an `AppError` as `{ error: { kind, message, details? } }`. */
export function errorResponse(error: AppError): Response {
  const payload: Record<string, JsonValue> = {
    kind: error.kind,
    message: error.message,
  };
  if (error.details !== undefined) {
    payload["details"] = error.details;
  }
  return jsonResponse({ error: payload }, statusForErrorKind(error.kind));
}

/**
 * Renders an error for a surface anyone can reach: `/{vendor}/{uuid}`, `/_get`
 * and `/_ws`.
 *
 * Client errors keep their message because the sender needs it - a 422 tells a
 * vendor exactly which part of its payload the schema rejected. Internal
 * failures carry implementation detail (stack messages, file paths, upstream
 * errors), so they are logged under a reference and answered generically; the
 * caller can quote the reference when reporting the failure.
 */
export function publicErrorResponse(
  error: AppError,
  cause?: unknown,
): Response {
  if (error.kind !== AppErrorKind.Internal) {
    return errorResponse(error);
  }
  const reference = newUuid();
  const detail = `[web-hooky] internal error ${reference}: ${error.message}`;
  if (cause === undefined) {
    console.error(detail);
  } else {
    console.error(detail, cause);
  }
  return errorResponse(
    appError(
      AppErrorKind.Internal,
      `Internal server error (reference ${reference})`,
    ),
  );
}

/** Empty 204 response. */
export function noContentResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

/** Lower-cases every request header into a plain object for addon contexts. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}
