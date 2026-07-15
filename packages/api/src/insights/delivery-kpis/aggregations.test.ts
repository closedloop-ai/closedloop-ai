import { describe, expect, it } from "vitest";
import { count, mean, median, ratio, round, sum } from "./aggregations.ts";

describe("aggregations", () => {
  it("median differs from mean on skewed input", () => {
    const values = [1, 2, 3, 100];
    expect(median(values)).toBe(2.5);
    expect(mean(values)).toBe(26.5);
  });

  it("median/mean/sum return null on empty (unavailable, not 0)", () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
    expect(sum([])).toBeNull();
  });

  it("count returns 0 on empty (a real zero, not unavailable)", () => {
    expect(count([])).toBe(0);
    expect(count([1, 2, 3])).toBe(3);
  });

  it("sum totals the values", () => {
    expect(sum([10, 20, 30])).toBe(60);
  });

  it("ratio returns num/den scaled, null on zero denominator", () => {
    expect(ratio(3, 4)).toBe(0.75);
    expect(ratio(3, 4, 100)).toBe(75);
    expect(ratio(1, 0)).toBeNull();
  });

  it("round respects decimals and passes null through", () => {
    expect(round(1.234_56, 2)).toBe(1.23);
    expect(round(1.5, 0)).toBe(2);
    expect(round(null, 2)).toBeNull();
  });
});
