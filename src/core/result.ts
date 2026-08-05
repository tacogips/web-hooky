/**
 * Result type used across web-hooky for expected failures.
 *
 * Exceptions are reserved for genuinely exceptional situations; every
 * anticipated failure (validation, authentication, storage lookup) is modelled
 * as a `Result`.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wraps a successful value. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps a failure value. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Extracts a human readable message from an unknown thrown value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}
