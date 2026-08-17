import { describe, expect, it } from "vitest";
import {
  cacheTokens,
  countedTokens,
  type TokenTotals,
  tokenDistributionBuckets,
} from "@/app/insights/token-derivations";

// The chart's stated population, summed the way the CHART sums it — from the
// slices it actually draws. Computed in the test rather than imported from a
// production helper (review thread): the earlier `allTokens` export had no
// production caller, so every assertion below was proving a property of code
// that never shipped. Deriving it from `tokenDistributionBuckets` means these
// tests now bind the shipped derivation.
function chartPopulation(totals: TokenTotals): number {
  return tokenDistributionBuckets(totals).reduce(
    (sum, bucket) => sum + bucket.value,
    0
  );
}

// Deliberately asymmetric: cache dwarfs input+output, which is what production
// looks like (a 606M Tokens card above a far wider cache-inclusive population)
// and is exactly the shape that makes a silent basis mismatch invisible when
// every fixture number is the same order of magnitude.
const TOTALS: TokenTotals = {
  inputTokens: 431_000_000,
  outputTokens: 175_000_000,
  cacheReadTokens: 40_000_000_000,
  cacheWriteTokens: 1_500_000_000,
};

describe("token derivations (ISS-5004)", () => {
  it("counts input + output for the Tokens KPI and excludes cache", () => {
    // The desktop golden oracle pins `input + output == kpi:tokens` exactly, so
    // this is the side that must NOT move to make the two agree.
    expect(countedTokens(TOTALS)).toBe(606_000_000);
    expect(countedTokens(TOTALS)).toBeLessThan(chartPopulation(TOTALS));
  });

  it("sums cache read + write for the Cache saved KPI", () => {
    expect(cacheTokens(TOTALS)).toBe(41_500_000_000);
  });

  it("lets the chart's parts define its whole, so slices always sum to it", () => {
    // The reconciliation invariant. Independently-derived parts and totals are
    // how a chart and the number above it drift apart, so the population is
    // summed from the same four fields the slices carry — not computed
    // alongside them.
    expect(chartPopulation(TOTALS)).toBe(
      countedTokens(TOTALS) + cacheTokens(TOTALS)
    );
  });

  it("states the gap between the chart and the Tokens card rather than hiding it", () => {
    // The chart legitimately decomposes a WIDER population than the card above
    // it. That is allowed; being silent about it was the defect. Pinning the
    // exact relationship means a future change to either derivation has to
    // confront this test instead of quietly re-opening the gap.
    expect(chartPopulation(TOTALS)).toBe(
      countedTokens(TOTALS) + cacheTokens(TOTALS)
    );
    expect(chartPopulation(TOTALS) - countedTokens(TOTALS)).toBe(
      cacheTokens(TOTALS)
    );
  });

  it("keeps the four token classes and their labels stable", () => {
    // The slice labels are what tell a reader the chart includes cache at all,
    // so they are part of the contract, not incidental.
    expect(tokenDistributionBuckets(TOTALS)).toEqual([
      { key: "input", label: "Input", value: 431_000_000 },
      { key: "output", label: "Output", value: 175_000_000 },
      { key: "cache-read", label: "Cache read", value: 40_000_000_000 },
      { key: "cache-write", label: "Cache write", value: 1_500_000_000 },
    ]);
  });

  it("holds the invariants at an all-zero population", () => {
    const empty: TokenTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(countedTokens(empty)).toBe(0);
    expect(chartPopulation(empty)).toBe(0);
    expect(chartPopulation(empty)).toBe(
      countedTokens(empty) + cacheTokens(empty)
    );
  });

  it("holds the invariants when only cache was recorded", () => {
    // A cache-only window is where the two populations diverge hardest: the
    // Tokens card reads a true 0 while the chart is fully populated. Both are
    // correct, and the sum invariant must survive it.
    const cacheOnly: TokenTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    };
    expect(countedTokens(cacheOnly)).toBe(0);
    expect(chartPopulation(cacheOnly)).toBe(1000);
    expect(chartPopulation(cacheOnly)).toBe(
      countedTokens(cacheOnly) + cacheTokens(cacheOnly)
    );
  });
});
