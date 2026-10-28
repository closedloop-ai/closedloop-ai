import { largestRemainderAllocate } from "@repo/app/shared/lib/largest-remainder";
import { describe, expect, it } from "vitest";

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const isWholeNonNegative = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

/**
 * The allocator itself, not either wrapper. Each wrapper narrows what reaches it
 * — `reconcileDisplayedCostCents` rejects a non-finite or negative part outright,
 * `largestRemainderPercents` derives its own target — so the edge behavior
 * documented here (the round-robin wrap, the deficit reclaim, the tie-break, the
 * clamp) was only ever exercised through whatever those two happened to pass
 * down, and never pinned directly (ISS-7640).
 */
describe("largestRemainderAllocate", () => {
  it("floors every part and hands the leftover units to the largest remainders", () => {
    // The whole reason this exists: rounding each part alone gives 33/33/33.
    expect(largestRemainderAllocate([33.3, 33.3, 33.4], 100)).toEqual([
      33, 33, 34,
    ]);
  });

  it("returns whole non-negative units, one per part, summing to exactly the target", () => {
    for (let rows = 1; rows <= 12; rows += 1) {
      const raw = Array.from(
        { length: rows },
        (_, index) => (index + 1) * 1.7 + 0.35
      );
      const target = Math.round(sum(raw));

      const units = largestRemainderAllocate(raw, target);

      expect(units).toHaveLength(rows);
      expect(units.every(isWholeNonNegative)).toBe(true);
      expect(sum(units)).toBe(target);
    }
  });

  it("breaks a SURPLUS remainder tie toward the larger raw value", () => {
    // Both parts carry a .5 remainder with one unit to hand out. The rule is
    // fixed rather than left to sort stability so a Cost column and the Cost %
    // column beside it cannot resolve the same row differently.
    expect(largestRemainderAllocate([1.5, 2.5], 4)).toEqual([1, 3]);
    expect(largestRemainderAllocate([2.5, 1.5], 4)).toEqual([3, 1]);
  });

  it("breaks a DEFICIT remainder tie by taking from the smaller raw value", () => {
    // The reclaim walks that same order reversed, so the tie that hands a
    // surplus unit to the larger raw value takes the shortfall off the smaller
    // one. One ordering, opposite end — pinned separately because a suite that
    // only asserts the surplus direction stays green if the reverse is dropped.
    expect(largestRemainderAllocate([1.5, 2.5], 2)).toEqual([0, 2]);
    expect(largestRemainderAllocate([2.5, 1.5], 2)).toEqual([2, 0]);
  });

  it("wraps the surplus round-robin when the leftover exceeds the row count", () => {
    // One pass hands out at most one unit per row, so a target taken from a
    // rollup computed elsewhere would leave the column short of it. Seven units
    // over two rows is four passes' worth, not one.
    expect(largestRemainderAllocate([0, 0], 7)).toEqual([4, 3]);
    expect(sum(largestRemainderAllocate([0.5, 0.25, 0.25], 10))).toBe(10);
  });

  it("reclaims a deficit from the smallest remainders without taking a row below zero", () => {
    const units = largestRemainderAllocate([5, 5], 3);

    expect(sum(units)).toBe(3);
    expect(units.every(isWholeNonNegative)).toBe(true);
    // Whole rows are emptied smallest-remainder-first rather than every row
    // shaved evenly — the documented trade-off for a bounded reclaim.
    expect(units).toEqual([3, 0]);
  });

  it("stops at zero when the rows cannot absorb the whole deficit", () => {
    // The demand is clamped to the rows' capacity up front. Without that clamp
    // the second case never satisfies `remaining > 0` and sweeps forever: every
    // row is already at zero, so each pass takes nothing and the loop is
    // unbounded rather than bounded by the row count.
    expect(largestRemainderAllocate([1, 1], -50)).toEqual([0, 0]);
    expect(largestRemainderAllocate([0, 0], -1)).toEqual([0, 0]);
  });

  it("clamps a non-finite or non-positive part to zero rather than propagating it", () => {
    // The allocator is the shared floor. Whether bad data is reportable at all
    // is decided ABOVE it — `reconcileDisplayedCostCents` refuses outright
    // rather than accepting this clamp (#4324).
    expect(largestRemainderAllocate([Number.NaN, -3, 2], 2)).toEqual([0, 0, 2]);
    expect(largestRemainderAllocate([Number.POSITIVE_INFINITY, 4], 4)).toEqual([
      0, 4,
    ]);
  });

  it("rounds a fractional target before allocating against it", () => {
    // `targetUnits` is the integer the column adds up to, so a caller handing
    // over a raw float must not produce a column summing to a non-integer.
    expect(sum(largestRemainderAllocate([1.2, 1.2], 3.6))).toBe(4);
    expect(sum(largestRemainderAllocate([1.2, 1.2], 3.4))).toBe(3);
  });

  it("returns nothing for no parts, whatever the target", () => {
    // The early return is load-bearing in both directions: with no rows there is
    // no remainder order to distribute over and the surplus wrap would take
    // `given % 0`.
    expect(largestRemainderAllocate([], 0)).toEqual([]);
    expect(largestRemainderAllocate([], 25)).toEqual([]);
    expect(largestRemainderAllocate([], -25)).toEqual([]);
  });
});
