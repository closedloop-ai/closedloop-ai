import { findIssue } from "@repo/api/src/types/zod-issue.test-helpers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  repeatedQueryArray,
  repeatedQueryArrayOrEmpty,
} from "./repeated-query-array";

const MAX = 3;
const schema = z.object({ facet: repeatedQueryArray(z.string(), MAX) });
const withDefault = z.object({
  facet: repeatedQueryArrayOrEmpty(z.string(), MAX),
});

describe("repeatedQueryArray (ISS-9073)", () => {
  it("wraps a single value in an array", () => {
    expect(schema.parse({ facet: "a" }).facet).toEqual(["a"]);
  });

  it("de-duplicates on the raw value before the cap, so repeats past the cap still parse", () => {
    const facet = Array.from({ length: MAX + 5 }, () => "a");

    expect(schema.parse({ facet }).facet).toEqual(["a"]);
  });

  it("rejects more distinct values than the cap, naming the param", () => {
    const result = schema.safeParse({ facet: ["a", "b", "c", "d"] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(findIssue(result.error.issues, ["facet"])?.code).toBe("too_big");
    }
  });

  it("parses an absent param to undefined, or to [] in the empty-default spelling", () => {
    expect(schema.parse({}).facet).toBeUndefined();
    expect(withDefault.parse({}).facet).toEqual([]);
  });
});
