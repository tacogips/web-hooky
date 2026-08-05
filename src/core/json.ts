/**
 * JSON value model and safe narrowing helpers.
 *
 * Webhook payloads and addon schemas are dynamic data, so they are typed as
 * `JsonValue` and narrowed explicitly instead of being cast to `any`.
 */
import { err, ok, type Result } from "./result";

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** True when the value is a plain JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

/** True when the value is a JSON array. */
export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

/**
 * Parses JSON text into a `JsonValue`.
 *
 * `JSON.parse` is typed as `any`; the result is structurally a `JsonValue` by
 * definition of the JSON grammar, so the cast happens once, here.
 */
export function parseJsonText(text: string): Result<JsonValue, string> {
  try {
    return ok(JSON.parse(text) as JsonValue);
  } catch (error) {
    return err(
      error instanceof Error ? error.message : "Invalid JSON document",
    );
  }
}

/** Reads a string property from a JSON object, or null when absent/mistyped. */
export function readString(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** Reads a number property from a JSON object, or null when absent/mistyped. */
export function readNumber(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads a boolean property from a JSON object, or null when absent/mistyped. */
export function readBoolean(source: JsonObject, key: string): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

/** Reads an object property from a JSON object, or null when absent/mistyped. */
export function readObject(source: JsonObject, key: string): JsonObject | null {
  const value = source[key];
  return isJsonObject(value) ? value : null;
}

/** Reads an array property from a JSON object, or null when absent/mistyped. */
export function readArray(source: JsonObject, key: string): JsonArray | null {
  const value = source[key];
  return isJsonArray(value) ? value : null;
}

/** Deep structural equality for JSON values (used by `enum` / `const`). */
export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (isJsonArray(left) && isJsonArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => {
      const other = right[index];
      return other === undefined ? false : jsonEquals(item, other);
    });
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key, index) => {
      if (rightKeys[index] !== key) {
        return false;
      }
      const leftValue = left[key];
      const rightValue = right[key];
      if (leftValue === undefined || rightValue === undefined) {
        return false;
      }
      return jsonEquals(leftValue, rightValue);
    });
  }
  return false;
}
