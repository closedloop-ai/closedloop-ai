import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import { rollupTotalUsd } from "./__tests__/branch-phase-attribution-fixture";
import { calculateBranchDetailMetrics } from "./branch-detail-outcomes";
import { calculateBranchListMetrics } from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import { BranchPublicationLocSource } from "./branch-publication-loc";

// Each call passes the fixture's own rollup total, which keeps these lead-time,
// idle and LOC cases on the reconciled path. Divergence between attributed and
// rollup cost is exercised in `branch-detail-cost-reconciliation.test.ts`.

describe("ISS-6543 lifetime Branch Detail LOC per $", () => {
  it("does not change when the selected PR presentation changes", () => {
    const common = {
      lifetimeLocContributions: [
        {
          sourceEventId: "merged-pr-1",
          changeIdentity: "repo:head-1",
          branchId: "branch-a",
          occurredAt: "2026-08-01T00:00:00.000Z",
          additions: 80,
          deletions: 20,
          source: BranchPublicationLocSource.MergedPullRequest,
        },
      ],
      lifetimeLocCoverageComplete: true,
      qualifyingSessionCount: 1,
      attributedCostUsd: rollupTotalUsd(phaseAttribution(50)),
      phaseAttribution: phaseAttribution(50),
      selectedCycle: null,
    } as const;
    const first = calculateBranchDetailMetrics({
      ...common,
      selectedPrAdditions: 5,
      selectedPrDeletions: 5,
      selectedPrLocComplete: true,
    });
    const second = calculateBranchDetailMetrics({
      ...common,
      selectedPrAdditions: 900,
      selectedPrDeletions: 100,
      selectedPrLocComplete: true,
    });

    expect(first.locPerDollar).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
    expect(second.locPerDollar).toEqual(first.locPerDollar);
  });

  it("keeps timestampless publication LOC incomplete on List and Detail", () => {
    const contribution = {
      sourceEventId: "merged-pr-1",
      changeIdentity: "repo:head-1",
      branchId: "branch-a",
      occurredAt: null,
      additions: 80,
      deletions: 20,
      source: BranchPublicationLocSource.MergedPullRequest,
    } as const;
    const detail = calculateBranchDetailMetrics({
      lifetimeLocContributions: [contribution],
      lifetimeLocCoverageComplete: true,
      qualifyingSessionCount: 1,
      attributedCostUsd: rollupTotalUsd(phaseAttribution(50)),
      phaseAttribution: phaseAttribution(50),
      selectedCycle: null,
      selectedPrAdditions: 80,
      selectedPrDeletions: 20,
      selectedPrLocComplete: true,
    });
    const list = calculateBranchListMetrics(
      {
        cohortSize: 1,
        cohortCoverageComplete: true,
        lastActiveEvents: [],
        lastActiveCoverageComplete: false,
        statusSnapshots: [
          { branchId: "branch-a", currentActive: false, priorActive: null },
        ],
        locContributions: [contribution],
        locCoverageComplete: true,
        locCompleteBranchIds: ["branch-a"],
        pullRequests: [],
        pullRequestCoverageComplete: true,
        costContributions: [],
        costCompleteBranchIds: ["branch-a"],
        locPerDollarCostContributions: [
          {
            sourceEventId: "cost-1",
            branchId: "branch-a",
            sessionId: "session-1",
            occurredAt: "2026-08-01T00:00:00.000Z",
            costUsd: 50,
            qualifyingBranchCount: 1,
          },
        ],
        locPerDollarQualifyingSessionIds: ["session-1"],
        locPerDollarCostCoverageComplete: true,
      },
      buildAdjacentBranchMetricWindows(
        BranchMetricPeriod.All,
        new Date("2026-08-18T00:00:00.000Z")
      )
    );

    expect(detail.locPerDollar).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
    expect(list.locPerDollar.current).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
  });
});

function phaseAttribution(cost: number): BranchPhaseAttributionResult {
  return {
    segments: [],
    rollups: [
      {
        phase: BranchVisibleLifecyclePhase.Build,
        estimatedCostUsd: cost,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        sessionCount: 1,
      },
    ],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: cost,
    },
  };
}
