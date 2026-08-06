/**
 * The error every failed web-hooky call throws.
 */

/** Error kinds the server emits, mirroring `src/core/errors.ts`. */
export enum WebhookyErrorKind {
  BadRequest = "bad_request",
  Unauthorized = "unauthorized",
  Forbidden = "forbidden",
  NotFound = "not_found",
  MethodNotAllowed = "method_not_allowed",
  Conflict = "conflict",
  PayloadTooLarge = "payload_too_large",
  UnprocessableEntity = "unprocessable_entity",
  NotImplemented = "not_implemented",
  Internal = "internal",
}

export interface WebhookyErrorOptions {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status?: number;
  /** Server error kind, or an empty string when the body carried none. */
  readonly kind?: string;
  /** Machine-readable detail the server attached. */
  readonly details?: unknown;
  readonly cause?: unknown;
}

/**
 * A failed call against a web-hooky server.
 *
 * A `status` of `0` with an empty `kind` means the request never reached the
 * server, which is how a caller tells a transport failure from a refusal.
 */
export class WebhookyError extends Error {
  readonly status: number;
  readonly kind: string;
  readonly details: unknown;

  constructor(message: string, options: WebhookyErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WebhookyError";
    this.status = options.status ?? 0;
    this.kind = options.kind ?? "";
    this.details = options.details;
  }

  get isNotFound(): boolean {
    return this.kind === WebhookyErrorKind.NotFound;
  }

  get isUnauthorized(): boolean {
    return this.kind === WebhookyErrorKind.Unauthorized;
  }

  get isForbidden(): boolean {
    return this.kind === WebhookyErrorKind.Forbidden;
  }

  /** Renders the failure the way the CLI reports it on stderr. */
  toJSON(): { readonly error: Record<string, unknown> } {
    return {
      error: { status: this.status, kind: this.kind, message: this.message },
    };
  }
}

/** How much of a failure body is kept in a message. */
const MAX_SNIPPET = 200;

function readEnvelope(
  parsed: unknown,
): { kind: string; message: string; details: unknown } | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const envelope = (parsed as { error?: unknown }).error;
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const { kind, message, details } = envelope as {
    kind?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  return {
    kind: typeof kind === "string" ? kind : "",
    message,
    details,
  };
}

/**
 * Builds an error from a non-2xx response body.
 *
 * A body that is not the server's `{"error":{...}}` envelope - a proxy's HTML
 * page, an empty 502 - still has to produce something actionable, so the status
 * becomes the message in that case.
 */
export function errorFromResponse(status: number, body: string): WebhookyError {
  let parsed: unknown;
  try {
    parsed = body.trim().length === 0 ? undefined : JSON.parse(body);
  } catch {
    parsed = undefined;
  }

  const envelope = readEnvelope(parsed);
  if (envelope !== null) {
    return new WebhookyError(envelope.message, {
      status,
      kind: envelope.kind,
      details: envelope.details,
    });
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return new WebhookyError(`request failed with status ${status}`, {
      status,
    });
  }
  const snippet =
    trimmed.length > MAX_SNIPPET
      ? `${trimmed.slice(0, MAX_SNIPPET)}...`
      : trimmed;
  return new WebhookyError(`request failed with status ${status}: ${snippet}`, {
    status,
  });
}

/** Reads a message from an unknown thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
