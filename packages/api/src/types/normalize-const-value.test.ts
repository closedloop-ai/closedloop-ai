import { describe, expect, it } from "vitest";
import { normalizeConstValue } from "./normalize-const-value.ts";

const Flag = {
  Yes: "yes",
  No: "no",
  Unknown: "unknown",
} as const;

describe("normalizeConstValue", () => {
  it("preserves every recognised member", () => {
    for (const member of Object.values(Flag)) {
      expect(normalizeConstValue(member, Flag)).toBe(member);
    }
  });

  it("folds a spelling this build does not know to Unknown", () => {
    // The version-skew case: a peer sends a member added after this build.
    expect(normalizeConstValue("maybe", Flag)).toBe(Flag.Unknown);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
    ["an array", []],
    ["a boolean", true],
  ])(
    "folds %s to Unknown rather than trusting the type signature",
    (_label, value) => {
      // Reachable despite the types: this normalises values parsed from JSON at a
      // boundary with no schema, where the annotation constrains nothing.
      expect(normalizeConstValue(value, Flag)).toBe(Flag.Unknown);
    }
  );

  it("folds a prototype-key string to Unknown", () => {
    // Matching is over Object.values, not a key lookup, so "__proto__" is just a
    // string that matches nothing. A key-indexed implementation would resolve it
    // to Object.prototype, which is neither undefined nor a member and would
    // survive a `?? fallback`.
    expect(normalizeConstValue("__proto__", Flag)).toBe(Flag.Unknown);
    expect(normalizeConstValue("constructor", Flag)).toBe(Flag.Unknown);
  });
});
