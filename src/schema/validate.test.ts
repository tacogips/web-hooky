import { describe, expect, test } from "bun:test";
import { type JsonValue, parseJsonText } from "../core/json";
import type { JsonSchema } from "./types";
import {
  formatSchemaIssues,
  parseJsonSchema,
  validateJsonSchema,
} from "./validate";

function accepts(schema: JsonSchema, value: JsonValue): boolean {
  return validateJsonSchema(schema, value).ok;
}

/**
 * Builds a value from JSON text so that keys such as `__proto__` become own
 * properties, exactly as they do for an incoming webhook body.
 */
function fromJson(text: string): JsonValue {
  const parsed = parseJsonText(text);
  if (parsed.ok === false) {
    throw new Error(`invalid JSON in test fixture: ${parsed.error}`);
  }
  return parsed.value;
}

function schemaFromJson(text: string): JsonSchema {
  const parsed = parseJsonSchema(fromJson(text));
  if (parsed.ok === false) {
    throw new Error(`invalid schema in test fixture: ${parsed.error}`);
  }
  return parsed.value;
}

const PROTOTYPE_KEYS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
] as const;

describe("parseJsonSchema", () => {
  test("accepts boolean schemas", () => {
    expect(parseJsonSchema(true).ok).toBe(true);
    expect(parseJsonSchema(false).ok).toBe(true);
  });

  test("rejects non-object schemas", () => {
    const parsed = parseJsonSchema(42);
    expect(parsed.ok).toBe(false);
  });

  test("rejects unsupported keywords at the root", () => {
    const parsed = parseJsonSchema({ $ref: "#/definitions/thing" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.error).toContain("$ref");
    }
  });

  test("rejects unsupported keywords nested inside properties", () => {
    const parsed = parseJsonSchema({
      type: "object",
      properties: { nested: { $ref: "#/definitions/thing" } },
    });
    expect(parsed.ok).toBe(false);
  });

  test("rejects unsupported keywords nested inside tuple items", () => {
    const parsed = parseJsonSchema({
      type: "array",
      items: [{ type: "string" }, { $ref: "#/definitions/thing" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.error).toContain("$ref");
    }
  });

  test("rejects keywords this validator does not enforce", () => {
    const unenforced = [
      "contains",
      "propertyNames",
      "additionalItems",
      "dependencies",
      "dependentRequired",
      "unevaluatedProperties",
      "unevaluatedItems",
    ] as const;
    for (const keyword of unenforced) {
      const parsed = parseJsonSchema({
        type: "object",
        [keyword]: { type: "string" },
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok === false) {
        expect(parsed.error).toContain(keyword);
      }
    }
  });

  test("rejects unenforced keywords nested inside a schema", () => {
    const parsed = parseJsonSchema({
      type: "object",
      properties: { tags: { type: "array", contains: { type: "string" } } },
    });
    expect(parsed.ok).toBe(false);
  });

  test("accepts a schema whose property is named like an unsupported keyword", () => {
    const parsed = parseJsonSchema({
      type: "object",
      properties: { contains: { type: "string" }, if: { type: "boolean" } },
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("validateJsonSchema types", () => {
  test("checks single and union types", () => {
    expect(accepts({ type: "string" }, "hello")).toBe(true);
    expect(accepts({ type: "string" }, 5)).toBe(false);
    expect(accepts({ type: ["string", "null"] }, null)).toBe(true);
    expect(accepts({ type: "integer" }, 4.2)).toBe(false);
    expect(accepts({ type: "integer" }, 4)).toBe(true);
    expect(accepts({ type: "array" }, [])).toBe(true);
    expect(accepts({ type: "object" }, [])).toBe(false);
  });

  test("boolean schemas accept or reject everything", () => {
    expect(accepts(true, { anything: 1 })).toBe(true);
    expect(accepts(false, null)).toBe(false);
  });
});

describe("validateJsonSchema objects", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 2 },
      count: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  };

  test("accepts a conforming object", () => {
    expect(accepts(schema, { id: "ab", count: 3 })).toBe(true);
  });

  test("reports missing required properties", () => {
    const result = validateJsonSchema(schema, { count: 1 });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(formatSchemaIssues(result.error)).toContain("id");
    }
  });

  test("rejects additional properties when disallowed", () => {
    expect(accepts(schema, { id: "ab", extra: true })).toBe(false);
  });

  test("rejects additional properties named after Object.prototype members", () => {
    for (const key of PROTOTYPE_KEYS) {
      const payload = fromJson(`{"id":"ab","${key}":{"injected":true}}`);
      expect([key, accepts(schema, payload)]).toEqual([key, false]);
    }
  });

  test("validates prototype-named keys against additionalProperties schema", () => {
    const permissive: JsonSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: { type: "number" },
    };
    for (const key of PROTOTYPE_KEYS) {
      const good = fromJson(`{"id":"ab","${key}":1}`);
      const bad = fromJson(`{"id":"ab","${key}":"nope"}`);
      expect([key, accepts(permissive, good)]).toEqual([key, true]);
      expect([key, accepts(permissive, bad)]).toEqual([key, false]);
    }
  });

  test("still validates a property genuinely declared as constructor", () => {
    const declared = schemaFromJson(
      '{"type":"object","properties":{"constructor":{"type":"string"}},"additionalProperties":false}',
    );
    expect(accepts(declared, fromJson('{"constructor":"ok"}'))).toBe(true);
    expect(accepts(declared, fromJson('{"constructor":1}'))).toBe(false);
  });

  test("validates nested property paths", () => {
    const nested: JsonSchema = {
      type: "object",
      properties: { inner: { type: "object", required: ["x"] } },
    };
    const result = validateJsonSchema(nested, { inner: {} });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error[0]?.path).toBe("/inner");
    }
  });

  test("honours patternProperties", () => {
    const patterned: JsonSchema = {
      type: "object",
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
    };
    expect(accepts(patterned, { "x-a": "ok" })).toBe(true);
    expect(accepts(patterned, { "x-a": 1 })).toBe(false);
    expect(accepts(patterned, { other: "no" })).toBe(false);
  });

  test("honours minProperties and maxProperties", () => {
    expect(accepts({ minProperties: 2 }, { a: 1 })).toBe(false);
    expect(accepts({ maxProperties: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("validateJsonSchema arrays", () => {
  test("validates item schemas and bounds", () => {
    const schema: JsonSchema = {
      type: "array",
      items: { type: "number" },
      minItems: 1,
      maxItems: 2,
    };
    expect(accepts(schema, [1])).toBe(true);
    expect(accepts(schema, [])).toBe(false);
    expect(accepts(schema, [1, 2, 3])).toBe(false);
    expect(accepts(schema, ["a"])).toBe(false);
  });

  test("validates tuple items", () => {
    const schema: JsonSchema = {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    };
    expect(accepts(schema, ["a", 1])).toBe(true);
    expect(accepts(schema, [1, 1])).toBe(false);
  });

  test("detects duplicate items", () => {
    const schema: JsonSchema = { type: "array", uniqueItems: true };
    expect(accepts(schema, [{ a: 1 }, { a: 1 }])).toBe(false);
    expect(accepts(schema, [{ a: 1 }, { a: 2 }])).toBe(true);
  });
});

describe("validateJsonSchema strings and numbers", () => {
  test("applies string constraints", () => {
    expect(accepts({ type: "string", maxLength: 2 }, "abc")).toBe(false);
    expect(accepts({ type: "string", pattern: "^a" }, "abc")).toBe(true);
    expect(accepts({ type: "string", pattern: "^b" }, "abc")).toBe(false);
    expect(accepts({ type: "string", format: "uuid" }, "not-a-uuid")).toBe(
      false,
    );
    expect(
      accepts(
        { type: "string", format: "uuid" },
        "123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(true);
  });

  test("applies numeric constraints", () => {
    expect(accepts({ minimum: 5 }, 4)).toBe(false);
    expect(accepts({ exclusiveMinimum: 5 }, 5)).toBe(false);
    expect(accepts({ maximum: 5 }, 6)).toBe(false);
    expect(accepts({ exclusiveMaximum: 5 }, 5)).toBe(false);
    expect(accepts({ multipleOf: 3 }, 9)).toBe(true);
    expect(accepts({ multipleOf: 3 }, 10)).toBe(false);
  });
});

describe("validateJsonSchema combinators", () => {
  test("anyOf accepts when one branch matches", () => {
    const schema: JsonSchema = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };
    expect(accepts(schema, "a")).toBe(true);
    expect(accepts(schema, true)).toBe(false);
  });

  test("oneOf requires exactly one match", () => {
    const schema: JsonSchema = {
      oneOf: [{ type: "number" }, { type: "integer" }],
    };
    expect(accepts(schema, 1)).toBe(false);
    expect(accepts(schema, 1.5)).toBe(true);
  });

  test("allOf requires every branch", () => {
    const schema: JsonSchema = {
      allOf: [{ type: "string" }, { minLength: 3 }],
    };
    expect(accepts(schema, "abc")).toBe(true);
    expect(accepts(schema, "ab")).toBe(false);
  });

  test("not inverts a schema", () => {
    expect(accepts({ not: { type: "string" } }, 1)).toBe(true);
    expect(accepts({ not: { type: "string" } }, "a")).toBe(false);
  });

  test("enum and const compare structurally", () => {
    expect(accepts({ enum: [{ a: 1 }, 2] }, { a: 1 })).toBe(true);
    expect(accepts({ enum: [{ a: 1 }] }, { a: 2 })).toBe(false);
    expect(accepts({ const: "wrike" }, "wrike")).toBe(true);
    expect(accepts({ const: "wrike" }, "github")).toBe(false);
  });
});
