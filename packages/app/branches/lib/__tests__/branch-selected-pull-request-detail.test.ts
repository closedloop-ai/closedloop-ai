import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchMetricPullRequestOutcome,
  type BranchMetricSelectedCycle,
} from "@repo/api/src/types/branch-metrics";
import { selectBranchPullRequestDetail } from "@repo/api/src/types/branch-selected-pull-request-detail";
import { calculateBranchDetailMetrics } from "@repo/lib/branches/branch-detail-outcomes";
import { mergeBranchPullRequestDetail } from "@repo/lib/branches/branch-selected-pull-request-detail";
import { describe, expect, it } from "vitest";
import {
  canonicalBranchDetailResponseFixture,
  canonicalBranchProjectionFixture,
} from "../../test-fixtures/canonical-branch-projection";

const cycle: BranchMetricSelectedCycle = {
  cycleId: "selected-pr",
  openedAt: new Date(1000).toISOString(),
  terminalAt: new Date(4000).toISOString(),
  outcome: BranchMetricPullRequestOutcome.Merged,
  successfulPushes: [
    { cycleId: "selected-pr", occurredAt: new Date(1000).toISOString() },
  ],
};

describe("cached branch and selected PR metric coherence", () => {
  it.each([
    [6, 1000, 12, 2000],
    [12, 2000, 6, 1000],
  ])(
    "retains cached cost %s and duration %s when selection was read with cost %s and duration %s",
    (cachedCost, cachedDuration, selectedCost, selectedDuration) => {
      const branch = snapshot(cachedCost, cachedDuration);
      const selectionSnapshot = snapshot(selectedCost, selectedDuration);
      const selection = selectBranchPullRequestDetail(selectionSnapshot);
      const merged = mergeBranchPullRequestDetail(branch, selection);
      expect(merged.sessions).toBe(branch.sessions);
      expect(merged.phaseAttribution).toBe(branch.phaseAttribution);
      expect(merged.canonicalMetrics?.totalCostUsd).toEqual(
        branch.canonicalMetrics?.totalCostUsd
      );
      expect(merged.canonicalMetrics?.phaseCostUsd).toEqual(
        branch.canonicalMetrics?.phaseCostUsd
      );
      expect(merged.canonicalMetrics?.locPerDollar).toEqual(
        branch.canonicalMetrics?.locPerDollar
      );
      expect(merged.canonicalMetrics?.leadTimeMs.value).toBe(3000);
      expect(merged.canonicalMetrics?.idleTimeMs.value).toBe(
        3000 - cachedDuration
      );
      expect(merged.canonicalProjection?.detail?.metrics).toEqual(
        merged.canonicalMetrics
      );
      expect(merged.canonicalProjection?.list.cost).toBe(
        branch.canonicalProjection?.list.cost
      );
      expect(selection).not.toHaveProperty("canonicalMetrics");
      expect(selection).not.toHaveProperty("phaseAttribution");
    }
  );

  it("preserves an unobserved cycle instead of borrowing the previous PR outcome", () => {
    const branch = snapshot(6, 1000);
    const selected = selectBranchPullRequestDetail({
      ...branch,
      canonicalMetricCycle: null,
    });
    const merged = mergeBranchPullRequestDetail(branch, selected);
    expect(merged.canonicalMetrics?.leadTimeMs.value).toBeNull();
    expect(merged.canonicalMetrics?.totalCostUsd).toEqual(
      branch.canonicalMetrics?.totalCostUsd
    );
  });
});

function snapshot(cost: number, duration: number): BranchPageDetail {
  const fixture = canonicalBranchProjectionFixture.detail;
  if (!fixture?.phaseAttribution) {
    throw new Error("Canonical fixture requires phase evidence");
  }
  const phaseAttribution = {
    ...fixture.phaseAttribution,
    segments: fixture.phaseAttribution.segments.map((segment) => ({
      ...segment,
      endMs: segment.startMs + duration,
      estimatedCostUsd: cost,
    })),
    rollups: fixture.phaseAttribution.rollups.map((rollup) => ({
      ...rollup,
      estimatedCostUsd: cost,
      durationMs: duration,
    })),
  };
  const canonicalMetrics = calculateBranchDetailMetrics({
    selectedPrAdditions: 100,
    selectedPrDeletions: 20,
    selectedPrLocComplete: true,
    attributedCostUsd: cost,
    phaseAttribution,
    selectedCycle: cycle,
  });
  return {
    ...canonicalBranchDetailResponseFixture,
    attributedCostUsd: cost,
    canonicalMetrics,
    canonicalMetricCycle: cycle,
    phaseAttribution,
    canonicalProjection: {
      ...canonicalBranchProjectionFixture,
      detail: { ...fixture, phaseAttribution, metrics: canonicalMetrics },
    },
  };
}
