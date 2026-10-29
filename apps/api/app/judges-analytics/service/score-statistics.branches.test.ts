/**
 * Branch-coverage pins for the power-sum reconstruction helpers in
 * app/judges-analytics/service/score-statistics.ts (ISS-11280). These are
 * a DISTINCT set of functions from the array-based siblings (computeSkewness,
 * computeExcessKurtosis, computeBimodalityCoefficient) that
 * apps/api/__tests__/unit/judge-radar.test.ts already covers — same shape,
 * separate implementation, separate line numbers — so nothing here
 * duplicates that file.
 *
 * Three guards in this file are NOT covered here because they are
 * unreachable through the only exported entry point (bimodalityFromMoments):
 *  - Its own `denominator <= 0` check, and computeBimodalityCoefficient's
 *    identical array-based copy, are mathematically unreachable: the
 *    well-known kurtosis/skewness inequality (excess kurtosis >=
 *    skewness^2 - 2, so excess kurtosis >= -2 for any real sample) means
 *    `excessKurtosis + 3*(n-1)^2/((n-2)*(n-3))` is strictly positive for
 *    every n >= 4 the guard above it admits — the correction term alone is
 *    >= 11.5 at n=4 and decreases toward 3 as n grows, while excess kurtosis
 *    is bounded below at -2. No real numeric input can drive it to zero or
 *    below.
 *  - The private skewnessFromMoments/excessKurtosisFromMoments each re-check
 *    `n < 3|4 || stdDev === 0`, but their only caller (bimodalityFromMoments)
 *    already returns early unless `n >= 4` and `stdDev !== 0`, so by the time
 *    either helper runs, both halves of its own guard are already false.
 */
import { describe, expect, it } from "vitest";
import {
  bimodalityFromMoments,
  certaintyFractionFromMoments,
  EMPTY_POWER_MOMENTS,
  meanFromMoments,
  stdDevFromPowerSums,
} from "./score-statistics";

describe("stdDevFromPowerSums — zero-count guard", () => {
  it("returns 0 without dividing by count when count is 0", () => {
    expect(stdDevFromPowerSums(0, 0, 0)).toBe(0);
  });
});

describe("meanFromMoments — zero-count guard", () => {
  it("returns 0 for empty power moments rather than sum/0", () => {
    expect(meanFromMoments(EMPTY_POWER_MOMENTS)).toBe(0);
  });

  it("returns sum/count for a non-empty accumulator", () => {
    expect(meanFromMoments({ ...EMPTY_POWER_MOMENTS, count: 4, sum: 2 })).toBe(
      0.5
    );
  });
});

describe("certaintyFractionFromMoments — zero-count guard", () => {
  it("returns 0 for empty power moments rather than extremeCount/0", () => {
    expect(certaintyFractionFromMoments(EMPTY_POWER_MOMENTS)).toBe(0);
  });

  it("returns extremeCount/count for a non-empty accumulator", () => {
    expect(
      certaintyFractionFromMoments({
        ...EMPTY_POWER_MOMENTS,
        count: 5,
        extremeCount: 2,
      })
    ).toBe(0.4);
  });
});

describe("bimodalityFromMoments — n<4 and zero-stdDev guards", () => {
  it("returns 0 for fewer than 4 scores without computing moments", () => {
    expect(
      bimodalityFromMoments({ ...EMPTY_POWER_MOMENTS, count: 3, sum: 1.5 })
    ).toBe(0);
  });

  it("returns 0 when 4+ identical scores yield a zero stdDev", () => {
    // Four scores of 0.5: sum=2, sumSq=1 -> variance = 1/4 - 0.25 = 0.
    expect(
      bimodalityFromMoments({
        ...EMPTY_POWER_MOMENTS,
        count: 4,
        sum: 2,
        sumSq: 1,
        sum3: 0.5,
        sum4: 0.25,
      })
    ).toBe(0);
  });
});
