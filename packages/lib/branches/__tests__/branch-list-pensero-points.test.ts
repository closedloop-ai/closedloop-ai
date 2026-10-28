import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import type { BranchListMetricInput } from "../branch-list-metrics";
import { canonicalPenseroPointsPerDollarResult } from "../branch-list-pensero-points";

/**
 * ISS-11117 — the Branches listing's points ratio, over the cohort's own cost
 * scalar.
 */
const POINTS = {
  points: 25,
  hasFailedAcquisitionDay: false,
  hasAmbiguousPoints: false,
  hasUnreadablePointValues: false,
};

describe("ISS-11117 canonical Pensero points per dollar", () => {
  it("divides the SAME cohort cost scalar the LOC ratio divides", () => {
    const result = canonicalPenseroPointsPerDollarResult(
      input({ penseroPoints: POINTS, canonicalEstimatedCostUsd: 10 })
    );

    expect(result).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2.5,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
  });

  it("publishes a MEASURED zero rather than withholding", () => {
    const result = canonicalPenseroPointsPerDollarResult(
      input({
        penseroPoints: { ...POINTS, points: 0 },
        canonicalEstimatedCostUsd: 10,
      })
    );

    expect(result?.state).toBe(BranchMetricAvailability.Partial);
    expect(result?.value).toBe(0);
  });

  it("names this cohort's OWN ambiguity when its rows were refused", () => {
    const result = canonicalPenseroPointsPerDollarResult(
      input({
        penseroPoints: { ...POINTS, hasAmbiguousPoints: true },
        canonicalEstimatedCostUsd: 10,
      })
    );

    // The number survives the disclosure. Withholding it is the failure this
    // whole feature's ISS-9930 ruling removed.
    expect(result).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2.5,
      disclosure: BranchMetricDisclosure.PenseroAttributionAmbiguous,
    });
  });

  it("returns NOTHING when the producer sent no numerator", () => {
    // `undefined`, not an Unavailable result: that absence is what a consumer
    // reads as "render LOC/$ unchanged". An Unavailable would claim a Pensero
    // metric exists and broke.
    expect(canonicalPenseroPointsPerDollarResult(input({}))).toBeUndefined();
  });

  it("is Unavailable, not absent, when the cohort could not be qualified", () => {
    const result = canonicalPenseroPointsPerDollarResult(
      input({
        penseroPoints: POINTS,
        canonicalEstimatedCostUsd: 10,
        cohortCoverageComplete: false,
      })
    );

    expect(result).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("is NotApplicable over a measured zero cohort cost", () => {
    // The cohort's Sessions genuinely cost nothing, so a ratio does not apply —
    // a different fact from "we were never told the cost".
    expect(
      canonicalPenseroPointsPerDollarResult(
        input({ penseroPoints: POINTS, canonicalEstimatedCostUsd: 0 })
      )?.state
    ).toBe(BranchMetricAvailability.NotApplicable);
  });

  it("is Unavailable when no cost basis was sent at all", () => {
    expect(
      canonicalPenseroPointsPerDollarResult(input({ penseroPoints: POINTS }))
        ?.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });
});

function input(fields: Partial<BranchListMetricInput>): BranchListMetricInput {
  return {
    cohortSize: 3,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: [],
    locContributions: [],
    locCompleteBranchIds: [],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: [],
    ...fields,
  };
}
