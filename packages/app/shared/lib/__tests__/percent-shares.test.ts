import { describe, expect, it } from "vitest";
import { largestRemainderPercents } from "../percent-shares";

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe("largestRemainderPercents", () => {
  // The case this helper exists for, and the one per-row `Math.round` gets
  // wrong: three equal shares round to 33 each and total 99, so a column headed
  // with the thing it divides ("Cost %") visibly fails to add up to it.
  it("totals exactly 100 for three equal shares", () => {
    const percents = largestRemainderPercents([1, 1, 1], 3);
    expect(sum(percents)).toBe(100);
    expect(percents).toEqual([34, 33, 33]);
  });

  // The other rounding direction: independently rounding .5-ish shares can also
  // overshoot to 101.
  it("totals exactly 100 for six equal shares", () => {
    const percents = largestRemainderPercents([1, 1, 1, 1, 1, 1], 6);
    expect(sum(percents)).toBe(100);
  });

  it("leaves already-exact shares untouched", () => {
    expect(largestRemainderPercents([3, 1], 4)).toEqual([75, 25]);
  });

  // A zero-valued row keeps its place in the output so callers can zip the
  // result back onto their rows by index.
  it("keeps one entry per value, including zero-valued rows", () => {
    const percents = largestRemainderPercents([2, 0, 1], 3);
    expect(percents).toHaveLength(3);
    expect(percents[1]).toBe(0);
    expect(sum(percents)).toBe(100);
  });

  // A non-positive denominator has no honest share to report. Callers that must
  // distinguish "unknown denominator" from a true zero guard before calling —
  // the Activity breakdown renders an em dash rather than these zeros.
  it("returns zeros when the total is not positive", () => {
    expect(largestRemainderPercents([0, 0], 0)).toEqual([0, 0]);
    expect(largestRemainderPercents([1, 2], -5)).toEqual([0, 0]);
  });

  it("returns nothing for no values", () => {
    expect(largestRemainderPercents([], 10)).toEqual([]);
  });
});
