import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  cloudRow,
  costFactsFor,
  orgMergedAdmissionForRows,
} from "@/__tests__/support/branches/branch-canonical-metric-projection.test-helpers";
import {
  projectCloudCanonicalMetrics,
  selectedCyclePushAt,
} from "./branch-canonical-metric-projection";

describe("cloud canonical Branch metric projection (branch pins)", () => {
  it("carries a supplied Pensero numerator through onto the projected bundle", () => {
    const row = cloudRow("pensero", "2026-08-01T00:00:00.000Z", 1);
    const penseroPoints = {
      points: 5,
      hasFailedAcquisitionDay: false,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    };

    const now = new Date("2026-08-03T00:00:00.000Z");

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      now,
      orgMergedAdmissionForRows(row),
      penseroPoints,
      undefined,
      costFactsFor({}, now, { spendUsd: 10, included: 1, unusable: 0 })
    );

    // ISS-9930 (operator ruling 2026-09-17): always Partial, never Complete,
    // even with full cost coverage.
    expect(metrics).toHaveProperty(
      "penseroPointsPerDollar.current.state",
      BranchMetricAvailability.Partial
    );
  });

  it("omits the Pensero-per-dollar metric entirely when no numerator is supplied", () => {
    const row = cloudRow("no-pensero", "2026-08-01T00:00:00.000Z", 1);

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      new Date("2026-08-03T00:00:00.000Z"),
      orgMergedAdmissionForRows(row)
    );

    expect(metrics).not.toHaveProperty("penseroPointsPerDollar");
  });
});

describe("selectedCyclePushAt (branch pins)", () => {
  it("treats a missing lifecycle-events map as no lifecycle evidence at all", () => {
    const result = selectedCyclePushAt(
      { associatedPullRequests: undefined },
      {
        sessionIds: [],
        sessions: [],
        sessionOwnerById: new Map(),
        sessionBillingModeById: new Map(),
        sessionDisplayInputsById: new Map(),
        sessionOwnerProfileById: new Map(),
        lifecycleEventsBySession: undefined,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        hasPricedCost: false,
      } as never,
      null
    );

    expect(result).toBeNull();
  });
});
