/**
 * `apps/api/AGENTS.md` mandates these schemas as the only sanctioned JSON
 * boundary parser, so the assertions below pin the boundary itself: what a
 * caller is allowed to hand across it, and the issue path a rejection carries.
 * Error messages are hardcoded rather than imported so a message regression
 * cannot silently rewrite its own oracle.
 */

import { describe, expect, it } from "vitest";
import {
  jsonObjectSchema,
  jsonValueSchema,
  parseJsonObject,
  stringRecordSchema,
} from "./json-schema";

const NESTED_JSON = {
  string: "value",
  number: 1,
  float: 1.5,
  negative: -1,
  boolean: false,
  nothing: null,
  list: [1, "two", null, true, { deep: [] }],
  nested: { inner: { deeper: "leaf" } },
};

describe("jsonValueSchema", () => {
  it.each([
    ["string", "value"],
    ["number", 42],
    ["boolean", true],
    ["null", null],
    ["array", [1, "two", null]],
    ["object", { a: 1 }],
    ["empty array", []],
    ["empty object", {}],
  ])("accepts a bare %s", (_label, value) => {
    expect(jsonValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("nope")],
  ])("rejects %s at the root path", (_label, value) => {
    const result = jsonValueSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.code)).toEqual([
        "invalid_union",
      ]);
      expect(result.error.issues[0].path).toEqual([]);
    }
  });
});

describe("jsonObjectSchema", () => {
  it("accepts a deeply nested JSON object", () => {
    const result = jsonObjectSchema.safeParse(NESTED_JSON);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(NESTED_JSON);
    }
  });

  it("accepts an empty object", () => {
    expect(jsonObjectSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ["an array", [1, 2], "Invalid input: expected record, received array"],
    ["a string", "value", "Invalid input: expected record, received string"],
    ["null", null, "Invalid input: expected record, received null"],
    ["a number", 3, "Invalid input: expected record, received number"],
    ["a boolean", true, "Invalid input: expected record, received boolean"],
  ])("rejects %s at the top level", (_label, value, message) => {
    const result = jsonObjectSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual([]);
      expect(result.error.issues[0].message).toBe(message);
    }
  });

  it.each([
    ["a Date", new Date("2026-01-01T00:00:00.000Z")],
    ["undefined", undefined],
    ["a function", () => 1],
    ["NaN", Number.NaN],
  ])(
    "rejects %s as a property value, anchored on that key",
    (_label, value) => {
      const result = jsonObjectSchema.safeParse({ offender: value });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].code).toBe("invalid_union");
        expect(result.error.issues[0].path).toEqual(["offender"]);
      }
    }
  );

  it("anchors a rejection on the nested key that carried the bad value", () => {
    const result = jsonObjectSchema.safeParse({
      outer: { inner: [1, () => 1] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["outer"]);
    }
  });
});

describe("parseJsonObject", () => {
  it("returns the parsed object for valid input", () => {
    expect(parseJsonObject(NESTED_JSON)).toEqual(NESTED_JSON);
  });

  it.each([
    ["an array", [1, 2]],
    ["a string", "value"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 3],
    ["an object holding a Date", { at: new Date("2026-01-01T00:00:00.000Z") }],
    ["an object holding undefined", { missing: undefined }],
  ])("returns null for %s", (_label, value) => {
    expect(parseJsonObject(value)).toBeNull();
  });

  it("returns a validated copy, not the caller's own object", () => {
    const input = { a: { b: 1 } };
    const parsed = parseJsonObject(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });
});

describe("stringRecordSchema", () => {
  it("accepts a record whose every value is a string", () => {
    const result = stringRecordSchema.safeParse({ a: "1", b: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ a: "1", b: "" });
    }
  });

  it("rejects a non-string value on the key that carried it", () => {
    const result = stringRecordSchema.safeParse({ a: "b", c: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual(["c"]);
      expect(result.error.issues[0].message).toBe(
        "Invalid input: expected string, received number"
      );
    }
  });

  it("rejects an array at the top level", () => {
    const result = stringRecordSchema.safeParse(["a"]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual([]);
      expect(result.error.issues[0].message).toBe(
        "Invalid input: expected record, received array"
      );
    }
  });
});
