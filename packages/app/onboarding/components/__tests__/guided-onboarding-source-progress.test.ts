import { describe, expect, it } from "vitest";
import {
  getSourceProgressPercent,
  type OnboardingSourceDetection,
} from "../guided-onboarding-data";

/**
 * ISS-10582. This is the PER-SOURCE half of the same quotient the discovery
 * fold declines. The analysis step turns a `100` here into a green check on the
 * row (`guided-onboarding-analysis-step.tsx`), so a ratio formed from two
 * populations that do not cover each other does not merely read high — it
 * claims the row finished.
 */
describe("getSourceProgressPercent", () => {
  it("states the ratio when the analyzed count sits inside its found count", () => {
    expect(getSourceProgressPercent(detected(500, 940))).toBe(53);
  });

  it("states 100 only when the two counts actually meet", () => {
    expect(getSourceProgressPercent(detected(940, 940))).toBe(100);
  });

  it("withholds the ratio when the analyzed count overshoots its found count", () => {
    // The store has outlived its transcripts: 2,443 rows against 940 live
    // files, measured on a real install. Clamping would put a green check on a
    // row whose 940 found transcripts nobody proved were analyzed.
    expect(getSourceProgressPercent(detected(2443, 940))).toBeNull();
  });

  it("withholds the ratio one session past the denominator, not only far past it", () => {
    expect(getSourceProgressPercent(detected(941, 940))).toBeNull();
  });

  it("withholds the ratio for an unread analyzed count and an empty population", () => {
    expect(
      getSourceProgressPercent({
        analyzed: null,
        found: 940,
        status: "detected",
      })
    ).toBeNull();
    expect(getSourceProgressPercent(detected(0, 0))).toBeNull();
  });

  it("withholds the ratio for a source that was never detected", () => {
    expect(getSourceProgressPercent({ status: "not-detected" })).toBeNull();
  });
});

function detected(analyzed: number, found: number): OnboardingSourceDetection {
  return { analyzed, found, status: "detected" };
}
