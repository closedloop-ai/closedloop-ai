import { describe, expect, it } from "vitest";
import { klocFromLines } from "./kloc";

describe("klocFromLines (FEA-4250)", () => {
  it("returns thousands of lines for a positive count", () => {
    expect(klocFromLines(2353)).toBeCloseTo(2.353, 10);
    expect(klocFromLines(1000)).toBeCloseTo(1, 10);
  });

  it("returns null for zero / negative / non-finite counts (never a false 0)", () => {
    expect(klocFromLines(0)).toBeNull();
    expect(klocFromLines(-5)).toBeNull();
    expect(klocFromLines(Number.NaN)).toBeNull();
    expect(klocFromLines(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
