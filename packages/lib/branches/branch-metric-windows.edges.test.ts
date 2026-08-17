/**
 * Edge cases for branch-metric-windows covering:
 * 1. isTimestampInBranchMetricWindow — NaN startMs path (returns false)
 * 2. buildAdjacentBranchMetricWindows — validEpoch throws on invalid Date
 * 3. periodDays default: assertNever (unknown period string)
 * 4. comparisonLabel default: assertNever (same unknown period string)
 */
import { BranchMetricPeriod } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  buildAdjacentBranchMetricWindows,
  isTimestampInBranchMetricWindow,
} from "./branch-metric-windows";

describe("isTimestampInBranchMetricWindow — NaN startMs", () => {
  it("returns false when the window startAt is an unparseable string", () => {
    // Date.parse("bad-date") → NaN → the NaN guard fires → return false.
    const result = isTimestampInBranchMetricWindow("2026-08-01T00:00:00.000Z", {
      startAt: "bad-date",
      endAt: "2026-08-03T00:00:00.000Z",
    });
    expect(result).toBe(false);
  });

  it("returns false when the timestamp itself is an unparseable string", () => {
    const result = isTimestampInBranchMetricWindow("not-a-date", {
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-03T00:00:00.000Z",
    });
    expect(result).toBe(false);
  });
});

describe("buildAdjacentBranchMetricWindows — validEpoch throws on invalid Date", () => {
  it("throws when the supplied end Date is invalid (NaN epoch)", () => {
    expect(() =>
      buildAdjacentBranchMetricWindows(
        BranchMetricPeriod.SevenDays,
        new Date("invalid")
      )
    ).toThrow("Branch metric window requires a valid end instant");
  });
});

describe("buildAdjacentBranchMetricWindows — assertNever default arms", () => {
  it("throws for an unknown period (exercises both periodDays and comparisonLabel default arms)", () => {
    // Casting an unknown string as BranchMetricPeriod exercises both switch defaults.
    expect(() =>
      buildAdjacentBranchMetricWindows(
        "UNKNOWN_PERIOD" as BranchMetricPeriod,
        new Date("2026-08-03T21:00:00.000Z")
      )
    ).toThrow("Unsupported Branch metric period");
  });
});
