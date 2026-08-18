import { describe, expect, it } from "vitest";
import { clamp, clamp01, clampPercent, median, round } from "./math";

describe("clamp", () => {
  it("clamps a value above max down to max", () => {
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it("clamps a value below min up to min", () => {
    expect(clamp(-0.5, 0, 1)).toBe(0);
  });

  it("returns the value unchanged when within range", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it("returns the boundary at the inclusive edges", () => {
    expect(clamp(0, 0, 1)).toBe(0);
    expect(clamp(1, 0, 1)).toBe(1);
  });

  it("handles negative ranges", () => {
    expect(clamp(-5, -3, 3)).toBe(-3);
    expect(clamp(5, -3, 3)).toBe(3);
  });

  it("pins to max for an inverted range (min > max)", () => {
    expect(clamp(5, 10, 0)).toBe(0);
  });

  it("propagates NaN input to NaN", () => {
    expect(clamp(Number.NaN, 0, 10)).toBeNaN();
  });
});

describe("clamp01", () => {
  it("passes through values in the unit interval", () => {
    expect(clamp01(0.5)).toBe(0.5);
  });

  it("clamps below 0 to 0 and above 1 to 1", () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
  });
});

describe("clampPercent", () => {
  it("passes through values in [0, 100]", () => {
    expect(clampPercent(42.5)).toBe(42.5);
  });

  it("clamps below 0 to 0 and above 100 to 100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("coerces non-finite input (%s) to 0", (_label, value) => {
    expect(clampPercent(value)).toBe(0);
  });
});

describe("median", () => {
  it("returns null for an empty array", () => {
    expect(median([])).toBeNull();
  });

  it("returns the single value for a one-element array", () => {
    expect(median([7])).toBe(7);
  });

  it("returns the middle value for odd-length input", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for even-length input", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("sorts numerically, not lexicographically", () => {
    expect(median([10, 2, 33, 4])).toBe(7);
  });

  it("handles duplicates and negatives", () => {
    expect(median([-5, -5, 0, 5])).toBe(-2.5);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("round", () => {
  it("rounds to one decimal (KLOC precision)", () => {
    expect(round(12.34, 1)).toBe(12.3);
    expect(round(12.35, 1)).toBe(12.4);
  });

  it("rounds to two decimals (cents precision)", () => {
    expect(round(5016.609_999_98, 2)).toBe(5016.61);
  });

  it("rounds to whole numbers with zero decimals", () => {
    expect(round(208.4, 0)).toBe(208);
    expect(round(208.5, 0)).toBe(209);
  });

  it("returns the value unchanged when already at precision", () => {
    expect(round(7, 1)).toBe(7);
  });

  it("handles negatives", () => {
    expect(round(-2.55, 1)).toBe(-2.5);
  });
});
