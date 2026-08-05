/**
 * Interpreted JSON Schema (draft-07 subset) validator.
 *
 * No code generation is used, so the validator runs on runtimes that forbid
 * `new Function` (Cloudflare Workers) and can safely evaluate schemas uploaded
 * by administrators. See `design-docs/specs/notes.md` for the supported subset.
 */
import {
  isJsonArray,
  isJsonObject,
  type JsonArray,
  type JsonObject,
  jsonEquals,
  type JsonValue,
} from "../core/json";
import { err, ok, type Result } from "../core/result";
import { type JsonSchema, JsonSchemaType, type SchemaIssue } from "./types";

const UNSUPPORTED_KEYWORDS = [
  "$ref",
  "$dynamicRef",
  "definitions",
  "$defs",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "contains",
  "propertyNames",
  "additionalItems",
  "dependencies",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

const FORMAT_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["uuid", /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["uri", /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/],
  [
    "date-time",
    /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  ],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
]);

/**
 * Validates that a JSON value is a usable schema for this validator.
 *
 * Unsupported keywords are rejected loudly instead of being silently ignored,
 * so an addon author never believes a constraint is enforced when it is not.
 */
export function parseJsonSchema(value: JsonValue): Result<JsonSchema, string> {
  if (typeof value === "boolean") {
    return ok(value);
  }
  if (isJsonObject(value) === false) {
    return err("Schema must be an object or a boolean");
  }
  const unsupported = findUnsupportedKeyword(value);
  if (unsupported !== null) {
    return err(`Unsupported JSON Schema keyword: ${unsupported}`);
  }
  return ok(value);
}

function findUnsupportedKeyword(schema: JsonObject): string | null {
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      return keyword;
    }
  }
  for (const nested of collectNestedSchemas(schema)) {
    if (isJsonObject(nested)) {
      const found = findUnsupportedKeyword(nested);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function collectNestedSchemas(schema: JsonObject): readonly JsonValue[] {
  const nested: JsonValue[] = [];
  for (const key of ["properties", "patternProperties"] as const) {
    const group = schema[key];
    if (isJsonObject(group)) {
      nested.push(...Object.values(group));
    }
  }
  const items = schema["items"];
  if (isJsonArray(items)) {
    // Tuple form: every element is a schema in its own right.
    nested.push(...items);
  } else if (items !== undefined) {
    nested.push(items);
  }
  for (const key of ["additionalProperties", "not"] as const) {
    const child = schema[key];
    if (child !== undefined) {
      nested.push(child);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const group = schema[key];
    if (isJsonArray(group)) {
      nested.push(...group);
    }
  }
  return nested;
}

/**
 * Validates a value against a schema.
 *
 * Returns the value unchanged on success (no coercion, no default filling) or
 * the complete list of issues on failure.
 */
export function validateJsonSchema(
  schema: JsonSchema,
  value: JsonValue,
): Result<JsonValue, readonly SchemaIssue[]> {
  const issues: SchemaIssue[] = [];
  validateNode(schema, value, "", issues);
  return issues.length === 0 ? ok(value) : err(issues);
}

/** Renders schema issues as a single human readable sentence. */
export function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`,
    )
    .join("; ");
}

function validateNode(
  schema: JsonSchema,
  value: JsonValue,
  path: string,
  issues: SchemaIssue[],
): void {
  if (schema === true) {
    return;
  }
  if (schema === false) {
    issues.push({ path, message: "Schema rejects all values" });
    return;
  }
  validateType(schema, value, path, issues);
  validateEnumAndConst(schema, value, path, issues);
  validateCombinators(schema, value, path, issues);
  if (typeof value === "string") {
    validateString(schema, value, path, issues);
  }
  if (typeof value === "number") {
    validateNumber(schema, value, path, issues);
  }
  if (isJsonArray(value)) {
    validateArray(schema, value, path, issues);
  }
  if (isJsonObject(value)) {
    validateObject(schema, value, path, issues);
  }
}

function validateType(
  schema: JsonObject,
  value: JsonValue,
  path: string,
  issues: SchemaIssue[],
): void {
  const declared = schema["type"];
  if (declared === undefined) {
    return;
  }
  const expected: readonly string[] = isJsonArray(declared)
    ? declared.filter((entry): entry is string => typeof entry === "string")
    : typeof declared === "string"
      ? [declared]
      : [];
  if (expected.length === 0) {
    return;
  }
  if (expected.some((entry) => matchesType(entry, value))) {
    return;
  }
  issues.push({
    path,
    message: `Expected type ${expected.join(" | ")} but received ${describeType(value)}`,
  });
}

function matchesType(expected: string, value: JsonValue): boolean {
  switch (expected) {
    case JsonSchemaType.Null:
      return value === null;
    case JsonSchemaType.Boolean:
      return typeof value === "boolean";
    case JsonSchemaType.String:
      return typeof value === "string";
    case JsonSchemaType.Number:
      return typeof value === "number" && Number.isFinite(value);
    case JsonSchemaType.Integer:
      return typeof value === "number" && Number.isInteger(value);
    case JsonSchemaType.Array:
      return isJsonArray(value);
    case JsonSchemaType.Object:
      return isJsonObject(value);
    default:
      return false;
  }
}

function describeType(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (isJsonArray(value)) {
    return "array";
  }
  if (isJsonObject(value)) {
    return "object";
  }
  return typeof value;
}

function validateEnumAndConst(
  schema: JsonObject,
  value: JsonValue,
  path: string,
  issues: SchemaIssue[],
): void {
  const allowed = schema["enum"];
  if (
    isJsonArray(allowed) &&
    allowed.some((entry) => jsonEquals(entry, value)) === false
  ) {
    issues.push({
      path,
      message: "Value is not one of the allowed enum values",
    });
  }
  const constant = schema["const"];
  if (constant !== undefined && jsonEquals(constant, value) === false) {
    issues.push({
      path,
      message: "Value does not equal the required constant",
    });
  }
}

function validateCombinators(
  schema: JsonObject,
  value: JsonValue,
  path: string,
  issues: SchemaIssue[],
): void {
  const allOf = schema["allOf"];
  if (isJsonArray(allOf)) {
    for (const branch of allOf) {
      validateNode(toSchema(branch), value, path, issues);
    }
  }

  const anyOf = schema["anyOf"];
  if (isJsonArray(anyOf) && anyOf.length > 0) {
    const matched = anyOf.some((branch) => countIssues(branch, value) === 0);
    if (matched === false) {
      issues.push({ path, message: "Value does not match any anyOf branch" });
    }
  }

  const oneOf = schema["oneOf"];
  if (isJsonArray(oneOf) && oneOf.length > 0) {
    const matches = oneOf.filter(
      (branch) => countIssues(branch, value) === 0,
    ).length;
    if (matches !== 1) {
      issues.push({
        path,
        message: `Value matched ${matches} oneOf branches, expected exactly 1`,
      });
    }
  }

  const not = schema["not"];
  if (not !== undefined && countIssues(not, value) === 0) {
    issues.push({ path, message: "Value matches a forbidden (not) schema" });
  }
}

function countIssues(branch: JsonValue, value: JsonValue): number {
  const branchIssues: SchemaIssue[] = [];
  validateNode(toSchema(branch), value, "", branchIssues);
  return branchIssues.length;
}

function toSchema(value: JsonValue): JsonSchema {
  if (typeof value === "boolean") {
    return value;
  }
  return isJsonObject(value) ? value : true;
}

function validateString(
  schema: JsonObject,
  value: string,
  path: string,
  issues: SchemaIssue[],
): void {
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && value.length < minLength) {
    issues.push({
      path,
      message: `String shorter than minLength ${minLength}`,
    });
  }
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number" && value.length > maxLength) {
    issues.push({ path, message: `String longer than maxLength ${maxLength}` });
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && safeRegexTest(pattern, value) === false) {
    issues.push({ path, message: `String does not match pattern ${pattern}` });
  }
  const format = schema["format"];
  if (typeof format === "string") {
    const formatPattern = FORMAT_PATTERNS.get(format);
    if (formatPattern !== undefined && formatPattern.test(value) === false) {
      issues.push({ path, message: `String is not a valid ${format}` });
    }
  }
}

function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // An invalid pattern cannot constrain anything; treat it as satisfied and
    // let manifest review catch the authoring mistake.
    return true;
  }
}

function validateNumber(
  schema: JsonObject,
  value: number,
  path: string,
  issues: SchemaIssue[],
): void {
  const minimum = schema["minimum"];
  if (typeof minimum === "number" && value < minimum) {
    issues.push({ path, message: `Number below minimum ${minimum}` });
  }
  const maximum = schema["maximum"];
  if (typeof maximum === "number" && value > maximum) {
    issues.push({ path, message: `Number above maximum ${maximum}` });
  }
  const exclusiveMinimum = schema["exclusiveMinimum"];
  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
    issues.push({
      path,
      message: `Number not above exclusiveMinimum ${exclusiveMinimum}`,
    });
  }
  const exclusiveMaximum = schema["exclusiveMaximum"];
  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
    issues.push({
      path,
      message: `Number not below exclusiveMaximum ${exclusiveMaximum}`,
    });
  }
  const multipleOf = schema["multipleOf"];
  if (typeof multipleOf === "number" && multipleOf > 0) {
    const quotient = value / multipleOf;
    if (Number.isInteger(quotient) === false) {
      issues.push({
        path,
        message: `Number is not a multiple of ${multipleOf}`,
      });
    }
  }
}

function validateArray(
  schema: JsonObject,
  value: JsonArray,
  path: string,
  issues: SchemaIssue[],
): void {
  const minItems = schema["minItems"];
  if (typeof minItems === "number" && value.length < minItems) {
    issues.push({ path, message: `Array shorter than minItems ${minItems}` });
  }
  const maxItems = schema["maxItems"];
  if (typeof maxItems === "number" && value.length > maxItems) {
    issues.push({ path, message: `Array longer than maxItems ${maxItems}` });
  }
  if (schema["uniqueItems"] === true && hasDuplicates(value)) {
    issues.push({ path, message: "Array items are not unique" });
  }
  const items = schema["items"];
  if (items === undefined) {
    return;
  }
  if (isJsonArray(items)) {
    value.forEach((entry, index) => {
      const tuple = items[index];
      if (tuple !== undefined) {
        validateNode(toSchema(tuple), entry, `${path}/${index}`, issues);
      }
    });
    return;
  }
  const itemSchema = toSchema(items);
  value.forEach((entry, index) => {
    validateNode(itemSchema, entry, `${path}/${index}`, issues);
  });
}

function hasDuplicates(value: JsonArray): boolean {
  for (let outer = 0; outer < value.length; outer += 1) {
    for (let inner = outer + 1; inner < value.length; inner += 1) {
      const left = value[outer];
      const right = value[inner];
      if (
        left !== undefined &&
        right !== undefined &&
        jsonEquals(left, right)
      ) {
        return true;
      }
    }
  }
  return false;
}

function validateObject(
  schema: JsonObject,
  value: JsonObject,
  path: string,
  issues: SchemaIssue[],
): void {
  const keys = Object.keys(value);

  const required = schema["required"];
  if (isJsonArray(required)) {
    for (const entry of required) {
      if (typeof entry === "string" && keys.includes(entry) === false) {
        issues.push({ path, message: `Missing required property "${entry}"` });
      }
    }
  }

  const minProperties = schema["minProperties"];
  if (typeof minProperties === "number" && keys.length < minProperties) {
    issues.push({ path, message: `Fewer than minProperties ${minProperties}` });
  }
  const maxProperties = schema["maxProperties"];
  if (typeof maxProperties === "number" && keys.length > maxProperties) {
    issues.push({ path, message: `More than maxProperties ${maxProperties}` });
  }

  const properties = schema["properties"];
  const patternProperties = schema["patternProperties"];
  const additionalProperties = schema["additionalProperties"];

  for (const key of keys) {
    const child = value[key];
    if (child === undefined) {
      continue;
    }
    const childPath = `${path}/${key}`;
    let matched = false;

    // Ownership gate: a payload key such as `constructor` or `toString` must
    // not count as a declared property just because `Object.prototype` has it,
    // otherwise it would skip the `additionalProperties` check entirely.
    if (isJsonObject(properties) && Object.hasOwn(properties, key)) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        matched = true;
        validateNode(toSchema(propertySchema), child, childPath, issues);
      }
    }

    if (isJsonObject(patternProperties)) {
      for (const [pattern, patternSchema] of Object.entries(
        patternProperties,
      )) {
        if (safeRegexTest(pattern, key)) {
          matched = true;
          validateNode(toSchema(patternSchema), child, childPath, issues);
        }
      }
    }

    if (matched === false && additionalProperties !== undefined) {
      if (additionalProperties === false) {
        issues.push({
          path: childPath,
          message: "Additional property not allowed",
        });
      } else {
        validateNode(toSchema(additionalProperties), child, childPath, issues);
      }
    }
  }
}
