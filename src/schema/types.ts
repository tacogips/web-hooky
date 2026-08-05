/**
 * JSON Schema (draft-07 subset) type model.
 *
 * The subset is documented in `design-docs/specs/notes.md`. Keywords that would
 * require reference resolution (`$ref`, `definitions`) are intentionally absent
 * and are rejected at parse time.
 */
import type { JsonObject, JsonValue } from "../core/json";

export enum JsonSchemaType {
  Null = "null",
  Boolean = "boolean",
  Object = "object",
  Array = "array",
  Number = "number",
  Integer = "integer",
  String = "string",
}

/** Object form of a schema; keyword lookup is dynamic by design. */
export type JsonSchemaObject = JsonObject;

/** A schema is either a boolean (accept-all / reject-all) or an object. */
export type JsonSchema = boolean | JsonSchemaObject;

export interface SchemaIssue {
  /** JSON pointer style path of the offending value, e.g. `/items/0/name`. */
  readonly path: string;
  readonly message: string;
}

/** Value plus the schema it was validated against. */
export interface SchemaValidationSuccess {
  readonly value: JsonValue;
}
