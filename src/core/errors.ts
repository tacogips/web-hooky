/**
 * Application error model shared by every layer.
 */
import type { JsonValue } from "./json";

export enum AppErrorKind {
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

export interface AppError {
  readonly kind: AppErrorKind;
  readonly message: string;
  readonly details?: JsonValue;
}

/** Builds an `AppError`, attaching optional machine readable details. */
export function appError(
  kind: AppErrorKind,
  message: string,
  details?: JsonValue,
): AppError {
  return details === undefined ? { kind, message } : { kind, message, details };
}

/** Maps an error kind onto its HTTP status code. */
export function statusForErrorKind(kind: AppErrorKind): number {
  switch (kind) {
    case AppErrorKind.BadRequest:
      return 400;
    case AppErrorKind.Unauthorized:
      return 401;
    case AppErrorKind.Forbidden:
      return 403;
    case AppErrorKind.NotFound:
      return 404;
    case AppErrorKind.MethodNotAllowed:
      return 405;
    case AppErrorKind.Conflict:
      return 409;
    case AppErrorKind.PayloadTooLarge:
      return 413;
    case AppErrorKind.UnprocessableEntity:
      return 422;
    case AppErrorKind.NotImplemented:
      return 501;
    case AppErrorKind.Internal:
      return 500;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled error kind: ${String(exhaustive)}`);
    }
  }
}

/** Convenience constructors for the kinds used most often. */
export const errors = {
  badRequest: (message: string, details?: JsonValue): AppError =>
    appError(AppErrorKind.BadRequest, message, details),
  unauthorized: (message: string): AppError =>
    appError(AppErrorKind.Unauthorized, message),
  forbidden: (message: string): AppError =>
    appError(AppErrorKind.Forbidden, message),
  notFound: (message: string): AppError =>
    appError(AppErrorKind.NotFound, message),
  methodNotAllowed: (message: string): AppError =>
    appError(AppErrorKind.MethodNotAllowed, message),
  conflict: (message: string): AppError =>
    appError(AppErrorKind.Conflict, message),
  payloadTooLarge: (message: string): AppError =>
    appError(AppErrorKind.PayloadTooLarge, message),
  unprocessable: (message: string, details?: JsonValue): AppError =>
    appError(AppErrorKind.UnprocessableEntity, message, details),
  /** The deployment target cannot provide this capability at all. */
  notImplemented: (message: string): AppError =>
    appError(AppErrorKind.NotImplemented, message),
  internal: (message: string): AppError =>
    appError(AppErrorKind.Internal, message),
} as const;
