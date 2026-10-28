import { describe, expect, it } from "vitest";
import { compareNullableNumber } from "./sort-comparators";

describe("compareNullableNumber", () => {
  it("orders measured values numerically in both directions", () => {
    expect(compareNullableNumber(9, 100, "asc")).toBeLessThan(0);
    expect(compareNullableNumber(9, 100, "desc")).toBeGreaterThan(0);
    expect(compareNullableNumber(0, 0, "asc")).toBe(0);
  });

  it("keeps null after measured values in both directions", () => {
    for (const direction of ["asc", "desc"] as const) {
      expect(compareNullableNumber(0, null, direction)).toBeLessThan(0);
      expect(compareNullableNumber(null, 0, direction)).toBeGreaterThan(0);
      expect(compareNullableNumber(null, null, direction)).toBe(0);
    }
  });
});
