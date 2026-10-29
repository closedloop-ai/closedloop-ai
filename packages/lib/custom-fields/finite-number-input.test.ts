import { describe, expect, it } from "vitest";
import { parseFiniteNumberInput } from "./finite-number-input";

describe("parseFiniteNumberInput", () => {
  it.each([
    ["1.5", 1.5],
    ["0", 0],
    ["-3", -3],
    [42.5, 42.5],
    [" 7 ", 7],
  ] as [string | number, number][])("parses %p to %p", (input, expected) => {
    expect(parseFiniteNumberInput(input)).toBe(expected);
  });

  it.each([
    [""],
    ["  "],
    ["1e400"],
    ["-1e400"],
    ["Infinity"],
    ["-Infinity"],
    ["NaN"],
    ["abc"],
    [Number.POSITIVE_INFINITY],
    [Number.NaN],
  ] as [string | number][])("rejects %p", (input) => {
    expect(parseFiniteNumberInput(input)).toBeNull();
  });
});
