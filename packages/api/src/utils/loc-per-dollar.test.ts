import { describe, expect, it } from "vitest";
import {
  LOC_PER_DOLLAR_LABEL,
  legacyKlocPerDollarFromLoc,
  locPerDollarFromLegacyKlocPerDollar,
  locPerDollarFromLines,
  resolveLocPerDollar,
} from "./loc-per-dollar.ts";

describe("locPerDollarFromLines (ISS-4667)", () => {
  it("divides lines by cost with NO divide-by-1000", () => {
    expect(locPerDollarFromLines(1000, 2)).toBeCloseTo(500, 10);
    expect(locPerDollarFromLines(5000, 2.5)).toBeCloseTo(2000, 10);
  });

  it("keeps the reported session non-zero (4,004 lines / $4,574.72)", () => {
    const value = locPerDollarFromLines(4004, 4574.72);
    expect(value).not.toBeNull();
    expect(value).toBeCloseTo(0.875, 3);
    expect(value).toBeGreaterThan(0);
  });

  it("returns null when there is no cost to divide by", () => {
    expect(locPerDollarFromLines(1000, 0)).toBeNull();
    expect(locPerDollarFromLines(1000, -1)).toBeNull();
  });

  it("returns null when no lines were delivered", () => {
    expect(locPerDollarFromLines(0, 5)).toBeNull();
    expect(locPerDollarFromLines(-10, 5)).toBeNull();
  });

  it("returns null for non-finite inputs instead of NaN/Infinity", () => {
    expect(locPerDollarFromLines(Number.NaN, 5)).toBeNull();
    expect(locPerDollarFromLines(1000, Number.NaN)).toBeNull();
    expect(locPerDollarFromLines(1000, Number.POSITIVE_INFINITY)).toBeNull();
    expect(locPerDollarFromLines(Number.POSITIVE_INFINITY, 5)).toBeNull();
  });

  it("is never inverted — more lines for the same cost scores higher", () => {
    const cheap = locPerDollarFromLines(2000, 10);
    const expensive = locPerDollarFromLines(1000, 10);
    expect(cheap).not.toBeNull();
    expect(expensive).not.toBeNull();
    expect(cheap as number).toBeGreaterThan(expensive as number);
  });
});

describe("locPerDollarFromLegacyKlocPerDollar (ISS-4667 version skew)", () => {
  it("scales a legacy thousand-lines-per-dollar value into LOC/$", () => {
    expect(locPerDollarFromLegacyKlocPerDollar(0.000_875)).toBeCloseTo(
      0.875,
      10
    );
    expect(locPerDollarFromLegacyKlocPerDollar(2)).toBeCloseTo(2000, 10);
  });

  it("keeps an old producer's unavailable as null, never a fabricated number, and rejects nonpositive legacy input", () => {
    // A nonpositive legacy value is not a real efficiency score — it must not be
    // scaled into a fabricated positive number (ISS-4667 malformed-input guard).
    for (const bad of [null, undefined, Number.NaN, 0, -0.5]) {
      expect(locPerDollarFromLegacyKlocPerDollar(bad)).toBeNull();
    }
  });
});

describe("resolveLocPerDollar (ISS-4667 version skew)", () => {
  it("prefers the canonical value when the producer sends it", () => {
    expect(resolveLocPerDollar(0.88, 999)).toBeCloseTo(0.88, 10);
  });

  it("preserves an explicit canonical null as the producer's unavailable", () => {
    expect(resolveLocPerDollar(null, 2)).toBeNull();
  });

  it("falls back to the legacy value when the canonical field is omitted", () => {
    expect(resolveLocPerDollar(undefined, 0.000_875)).toBeCloseTo(0.875, 10);
  });

  it("returns null when the payload carries neither value", () => {
    expect(resolveLocPerDollar(undefined, undefined)).toBeNull();
  });

  it("normalizes a malformed nonpositive/non-finite canonical to null without falling through to legacy", () => {
    // A present-but-negative canonical is authoritative-present (not omitted),
    // so it must NOT revive a stale legacy value; it degrades to unavailable.
    expect(resolveLocPerDollar(-1, 999)).toBeNull();
    expect(resolveLocPerDollar(0, 999)).toBeNull();
    expect(resolveLocPerDollar(Number.NaN, 999)).toBeNull();
    expect(resolveLocPerDollar(Number.POSITIVE_INFINITY, 999)).toBeNull();
  });
});

describe("legacyKlocPerDollarFromLoc (ISS-4667 emit-side version skew)", () => {
  it("scales a canonical LOC per dollar back down into the legacy thousand-line alias", () => {
    expect(legacyKlocPerDollarFromLoc(0.875)).toBeCloseTo(0.000_875, 10);
    expect(legacyKlocPerDollarFromLoc(2000)).toBeCloseTo(2, 10);
  });

  it("round-trips with locPerDollarFromLegacyKlocPerDollar", () => {
    const loc = 0.875;
    const legacy = legacyKlocPerDollarFromLoc(loc);
    expect(legacy).not.toBeNull();
    expect(locPerDollarFromLegacyKlocPerDollar(legacy)).toBeCloseTo(loc, 10);
  });

  it("keeps an unavailable canonical as null, never a fabricated legacy number", () => {
    for (const bad of [
      null,
      undefined,
      Number.NaN,
      0,
      -0.5,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(legacyKlocPerDollarFromLoc(bad)).toBeNull();
    }
  });
});

describe("LOC_PER_DOLLAR_LABEL", () => {
  it("is the canonical lines-per-dollar label", () => {
    expect(LOC_PER_DOLLAR_LABEL).toBe("LOC / $");
  });
});
