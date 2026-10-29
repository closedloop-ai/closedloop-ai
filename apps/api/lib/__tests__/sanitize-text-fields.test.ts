import { NUL_CHARACTER as NUL } from "@repo/api/src/types/postgres-text";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  sanitizedTextFields,
  sanitizeJsonTree,
  sanitizeTextFields,
  sanitizeTextValue,
} from "@/lib/sanitize-text-fields";

describe("sanitizedTextFields", () => {
  it("keeps only the fields the policy marks true, in policy order", () => {
    expect(sanitizedTextFields({ a: true, b: false, c: true })).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("sanitizeTextFields", () => {
  const schema = sanitizeTextFields(
    z.object({ name: z.string().min(1), token: z.string() }),
    ["name"]
  );

  it("strips NUL from a listed field before the wrapped schema runs", () => {
    expect(schema.parse({ name: `a${NUL}b`, token: "t" })).toEqual({
      name: "ab",
      token: "t",
    });
  });

  it("leaves an unlisted field untouched", () => {
    expect(schema.parse({ name: "n", token: `t${NUL}` }).token).toBe(`t${NUL}`);
  });

  it("re-applies the wrapped length rule to the sanitized value", () => {
    expect(schema.safeParse({ name: NUL, token: "t" }).success).toBe(false);
  });

  it("leaves a non-string listed field for the wrapped schema to report", () => {
    expect(schema.safeParse({ name: 1, token: "t" }).success).toBe(false);
  });

  it("passes a non-object body through to the wrapped schema", () => {
    expect(schema.safeParse("not an object").success).toBe(false);
  });
});

describe("sanitizeTextValue", () => {
  const schema = sanitizeTextValue(z.union([z.string().max(3), z.number()]));

  it("strips NUL from a string value before its own rule runs", () => {
    // Four characters raw, three once sanitized: the max applies after.
    expect(schema.parse(`ab${NUL}c`)).toBe("abc");
  });

  it("leaves a non-string value alone", () => {
    expect(schema.parse(7)).toBe(7);
  });
});

describe("sanitizeJsonTree", () => {
  const schema = sanitizeJsonTree(z.record(z.string(), z.unknown()));

  it("strips NUL from nested strings and keys", () => {
    expect(schema.parse({ [`k${NUL}`]: [{ v: `x${NUL}` }] })).toEqual({
      k: [{ v: "x" }],
    });
  });

  it("refuses two keys that collapse to one", () => {
    expect(schema.safeParse({ [`a${NUL}`]: 1, a: 2 }).success).toBe(false);
  });

  it("passes a tree deeper than the sanitizer bound through unchanged", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 250; level++) {
      deep = { next: deep };
    }

    expect(schema.parse(deep)).toEqual(deep);
  });
});
