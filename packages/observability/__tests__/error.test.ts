import { describe, expect, it } from "vitest";
import { parseError } from "../error";

describe("parseError", () => {
  it.each([
    ["Error instances", new Error("boom"), "boom"],
    ["string message objects", { message: "failed" }, "failed"],
    ["numeric message objects", { message: 42 }, "42"],
    ["objects without messages", { code: "E_FAIL" }, "[object Object]"],
    ["null", null, "null"],
    ["string primitives", "plain failure", "plain failure"],
    ["numeric primitives", 17, "17"],
  ])("normalizes %s", (_label, input, expected) => {
    expect(parseError(input)).toBe(expected);
  });
});
