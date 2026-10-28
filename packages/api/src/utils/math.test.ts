import { describe, expect, it } from "vitest";
import {
  clamp,
  clamp01,
  clampNonNegativeCount,
  clampPercent,
  computeMean,
  hasAtMostDecimalPlaces,
  median,
  repairOffset,
  resolveCappedTotalPages,
  resolveMaxPageIndex,
  resolveTotalPages,
  round,
} from "./math";

describe("computeMean", () => {
  it("returns 0 for an empty array", () => {
    expect(computeMean([])).toBe(0);
  });

  it("returns the average of the values", () => {
    expect(computeMean([1, 2, 3])).toBe(2);
  });

  it("handles a single value", () => {
    expect(computeMean([7])).toBe(7);
  });
});

describe("hasAtMostDecimalPlaces", () => {
  it("accepts a value with exactly the allowed decimal places", () => {
    expect(hasAtMostDecimalPlaces(1.23, 2)).toBe(true);
  });

  it("accepts a value with fewer decimal places than the max", () => {
    expect(hasAtMostDecimalPlaces(1.2, 2)).toBe(true);
    expect(hasAtMostDecimalPlaces(1, 2)).toBe(true);
  });

  it("rejects a value with more decimal places than the max", () => {
    expect(hasAtMostDecimalPlaces(1.234, 2)).toBe(false);
  });

  it("rejects non-finite input", () => {
    expect(hasAtMostDecimalPlaces(Number.NaN, 2)).toBe(false);
    expect(hasAtMostDecimalPlaces(Number.POSITIVE_INFINITY, 2)).toBe(false);
  });

  it("rejects a negative maxDecimalPlaces", () => {
    expect(hasAtMostDecimalPlaces(1.2, -1)).toBe(false);
  });

  it("tolerates floating-point imprecision within epsilon", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754, but it represents a value
    // with 1 decimal place once scaled and rounded.
    expect(hasAtMostDecimalPlaces(0.1 + 0.2, 1)).toBe(true);
  });
});

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

describe("clampNonNegativeCount", () => {
  it("truncates a fractional count toward zero", () => {
    expect(clampNonNegativeCount(3.7)).toBe(3);
    expect(clampNonNegativeCount(0.5)).toBe(0);
  });

  it("passes a whole count through", () => {
    expect(clampNonNegativeCount(0)).toBe(0);
    expect(clampNonNegativeCount(42)).toBe(42);
  });

  it("floors a negative count at zero rather than rendering it", () => {
    expect(clampNonNegativeCount(-1)).toBe(0);
    expect(clampNonNegativeCount(-0.5)).toBe(0);
  });

  /**
   * The three copies this replaced each mapped every non-finite input to `0`
   * rather than letting `NaN` or `Infinity` reach a render or a monitor. Pinned
   * on all three shapes because a broken producer picks which one it emits.
   */
  it("maps every non-finite input to zero", () => {
    expect(clampNonNegativeCount(Number.NaN)).toBe(0);
    expect(clampNonNegativeCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampNonNegativeCount(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("resolveTotalPages", () => {
  it("floors an empty result at a single page so a footer never reads 'of 0'", () => {
    expect(resolveTotalPages(0, 25)).toBe(1);
  });

  it("counts a partial final page", () => {
    expect(resolveTotalPages(1, 25)).toBe(1);
    expect(resolveTotalPages(25, 25)).toBe(1);
    expect(resolveTotalPages(26, 25)).toBe(2);
    expect(resolveTotalPages(250, 100)).toBe(3);
  });

  /**
   * The eight call sites this replaced were each `Math.max(1, Math.ceil(...))`
   * with no lower clamp on `total`; a negative count reached `Math.ceil` and the
   * floor absorbed it. Pinned so the shared helper cannot quietly start
   * disagreeing with the expression it consolidated.
   */
  it("absorbs a negative total through the floor, as every call site did", () => {
    expect(resolveTotalPages(-5, 25)).toBe(1);
    expect(resolveTotalPages(-500, 10)).toBe(1);
  });

  /**
   * Deliberately NOT clamped here — folding a page-size guard into the helper
   * would change what the surfaces that already guard their own page size do.
   * This pins the contract that makes those caller-side clamps load-bearing.
   */
  it("does not invent a page-size guard the callers own", () => {
    expect(resolveTotalPages(10, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("resolveMaxPageIndex", () => {
  it("is the last page whose offset does not exceed the ceiling", () => {
    expect(resolveMaxPageIndex(10_000, 25)).toBe(400);
    expect(resolveMaxPageIndex(10_000, 100)).toBe(100);
  });

  it("floors a ceiling that is not a whole number of pages", () => {
    // 10_000 / 30 = 333.33 — page 333 sits at offset 9,990 and is servable;
    // page 334 would be 10,020 and is not.
    expect(resolveMaxPageIndex(10_000, 30)).toBe(333);
  });

  it("is the first page when the ceiling cannot fit a second one", () => {
    expect(resolveMaxPageIndex(10, 25)).toBe(0);
  });
});

describe("resolveCappedTotalPages", () => {
  it("advertises every page the rows imply when no ceiling is given", () => {
    expect(resolveCappedTotalPages(30_000, 25)).toBe(1200);
    expect(resolveCappedTotalPages(30_000, 25)).toBe(
      resolveTotalPages(30_000, 25)
    );
  });

  it("caps the count at the last page the ceiling can serve", () => {
    expect(resolveCappedTotalPages(30_000, 25, 10_000)).toBe(401);
  });

  it("keeps the raw count when it already sits below the ceiling", () => {
    expect(resolveCappedTotalPages(500, 25, 10_000)).toBe(20);
  });

  it("keeps the floor of one, so an empty result still has a page", () => {
    expect(resolveCappedTotalPages(0, 25, 10_000)).toBe(1);
  });

  it("never advertises a page whose offset would exceed the ceiling", () => {
    const pageSize = 25;
    const maxOffset = 10_000;
    const lastPageOffset =
      (resolveCappedTotalPages(30_000, pageSize, maxOffset) - 1) * pageSize;
    expect(lastPageOffset).toBeLessThanOrEqual(maxOffset);
    // ...and it is the LAST such page, so an off-by-one that under-advertises
    // is caught here rather than silently hiding a servable page.
    expect(lastPageOffset + pageSize).toBeGreaterThan(maxOffset);
  });

  it("treats a zero ceiling as first-page-only, not as absent", () => {
    expect(resolveCappedTotalPages(30_000, 25, 0)).toBe(1);
  });
});

describe("repairOffset", () => {
  it("leaves an offset that lands inside the population alone", () => {
    expect(repairOffset(20, 55, 10)).toBe(20);
  });

  it("pulls an overshooting offset back to the start of the last page", () => {
    expect(repairOffset(120, 25, 10)).toBe(20);
  });

  it("repairs an empty population to the first page rather than a negative", () => {
    expect(repairOffset(120, 0, 10)).toBe(0);
  });

  it("keeps the last page whole when the total lands exactly on a boundary", () => {
    // 30 rows at 10/page is three FULL pages, so the last one starts at 20 — not
    // at 30, which would be a page past the end holding nothing.
    expect(repairOffset(500, 30, 10)).toBe(20);
  });

  it("aligns every repaired offset to a page start", () => {
    // The property the Branches response validator asserts, and the reason this
    // floors rather than rounds: a repaired offset names a PAGE, so a consumer
    // can divide it by the limit and get the page index back.
    for (const limit of [10, 25, 100, 250]) {
      for (const total of [1, 7, 99, 100, 101, 1000, 4999]) {
        const repaired = repairOffset(1_000_000, total, limit);
        expect(repaired % limit).toBe(0);
        expect(repaired).toBeLessThan(total);
      }
    }
  });
});
