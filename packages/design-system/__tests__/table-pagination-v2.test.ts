import { resolvePaginationBounds } from "@closedloop-ai/design-system/components/ui/table-pagination-v2";
import { describe, expect, it } from "vitest";

/**
 * whitlockk review on PR #4984: the v2 paginator's "safe" values were not safe.
 * `Math.max(1, totalPages)` propagates `NaN`, keeps fractions, and lets
 * `Infinity` through — and the Previous/Next callbacks emitted the RAW `page`,
 * so an out-of-range page rendered clamped but handed the caller another
 * out-of-range page.
 *
 * These cover the three input classes named in that review — underflow,
 * overflow, and non-finite — against the boundary resolver every one of those
 * readers now derives from. `safePage` is asserted alongside `canPrev`/`canNext`
 * because it IS what the callbacks emit: asserting only the disabled states
 * would still pass with the raw-`page` emission bug in place.
 */

describe("resolvePaginationBounds", () => {
  it("passes a well-formed page through untouched", () => {
    expect(resolvePaginationBounds(2, 5)).toEqual({
      safePage: 2,
      safeTotalPages: 5,
      canPrev: true,
      canNext: true,
    });
  });

  it("clamps an underflowing page up to the first page", () => {
    expect(resolvePaginationBounds(-7, 5)).toEqual({
      safePage: 0,
      safeTotalPages: 5,
      canPrev: false,
      canNext: true,
    });
  });

  it("clamps an overflowing page down to the last page", () => {
    expect(resolvePaginationBounds(99, 5)).toEqual({
      safePage: 4,
      safeTotalPages: 5,
      canPrev: true,
      canNext: false,
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("falls back to the first page for a %s page", (_label, page) => {
    expect(resolvePaginationBounds(page, 5).safePage).toBe(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("falls back to a single page for a %s total", (_label, totalPages) => {
    // The Infinity case is the one that mattered most: an infinite total made
    // the page-window loop unable to terminate, because `Infinity + 1` is still
    // `Infinity` so the counter could never pass the bound.
    expect(resolvePaginationBounds(0, totalPages)).toEqual({
      safePage: 0,
      safeTotalPages: 1,
      canPrev: false,
      canNext: false,
    });
  });

  it("truncates a fractional page rather than rounding past the last page", () => {
    expect(resolvePaginationBounds(4.9, 5).safePage).toBe(4);
    expect(resolvePaginationBounds(0.9, 5).safePage).toBe(0);
  });

  it("truncates a fractional total instead of admitting a partial page", () => {
    expect(resolvePaginationBounds(0, 5.9).safeTotalPages).toBe(5);
  });

  it("treats a zero or negative total as one page", () => {
    expect(resolvePaginationBounds(3, 0)).toEqual({
      safePage: 0,
      safeTotalPages: 1,
      canPrev: false,
      canNext: false,
    });
    expect(resolvePaginationBounds(3, -4).safeTotalPages).toBe(1);
  });
});
