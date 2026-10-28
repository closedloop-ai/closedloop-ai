/**
 * @file branch-total-estimated-cost-basis.test.ts
 * @description ISS-9970 — every Branches dollar, and every dollar used as a
 * denominator, is TOTAL ESTIMATED COST. Lifecycle phase is not a dimension of
 * the dollar.
 *
 * The retired behavior scoped the Branches AI-spend derivation, and the LOC/$
 * denominator behind it, to cost evidence that carried a Build/Review/Rework
 * classification: `calculateAiSpend` required `contribution.phase !== null` and
 * `allocatedCostGroupIsReadable` required the same, so a Session whose cost the
 * phase classifier could not place was silently dropped from both the headline
 * figure and the ratio it divides by.
 *
 * WHAT THESE TESTS PIN. The two downstream halves, and only those:
 *
 *   1. KERNEL: a contribution carrying only the fields the cost contract
 *      declares reaches `aiSpendUsd` whole AND lands in the LOC/$ denominator
 *      whole. Reinstating either phase requirement drops it and turns both
 *      assertions red.
 *   2. PRODUCER SHAPE: `branchMetricCostContributions` emits no `phase` key, so
 *      no downstream filter can reintroduce the classification requirement
 *      without first re-adding the field the producer deliberately stopped
 *      carrying. Restoring `phase: segment.phase` in the producer turns this
 *      red.
 *
 * WHAT THEY DO NOT PIN. They do not establish ISS-9970 AC-3 ("a Session whose
 * cost sits outside Build/Review/Rework still counts"), and nothing here should
 * be read as evidence for it. That Session's cost never reaches this module:
 * the shared projector discards a segment it has ALREADY PROVEN PRICED whenever
 * it cannot assign a phase (`branch-phase-attribution.ts`, `projectSegment` —
 * the `if (!phase) return null` that follows the `costUsd === null` early
 * return), so the cost events it carried are dropped on BOTH the cloud and
 * Desktop paths before any contribution is built. The inputs below are
 * constructed in memory, so they cannot observe that drop. Delivering AC-3
 * means changing that projector and the non-nullable
 * `BranchPhaseAttributionSegment.phase` contract, which in turn decides whether
 * unplaceable priced spend joins the total while belonging to no phase rollup,
 * and whether coverage may still read Complete — a product question, and
 * deliberately not settled here.
 *
 * These tests drive the real kernel and the real producer, never a
 * re-implementation of their arithmetic.
 */
import {
  BranchMetricAvailability,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import type {
  BranchListMetricInput,
  BranchMetricCostContribution,
} from "./branch-list-metrics";
import { calculateMetricsWithSpendFacts as calculateBranchListMetrics } from "./branch-list-metrics.test-helpers";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import { branchMetricCostContributions } from "./branch-phase-cost-contributions";
import type { BranchMetricLocContribution } from "./branch-publication-loc";

const NOW = new Date("2026-09-08T18:05:33.852Z");
const IN_WINDOW = "2026-09-07T12:00:00.000Z";
const BRANCH = "branch-1";
const LINES = 1000;
const CLASSIFIED_COST_USD = 4;
const UNCLASSIFIABLE_COST_USD = 6;
const TOTAL_ESTIMATED_COST_USD = CLASSIFIED_COST_USD + UNCLASSIFIABLE_COST_USD;

function costContribution(
  overrides: Partial<BranchMetricCostContribution> = {}
): BranchMetricCostContribution {
  return {
    sourceEventId: "cost-event-classified",
    branchId: BRANCH,
    sessionId: "session-classified",
    occurredAt: IN_WINDOW,
    costUsd: CLASSIFIED_COST_USD,
    qualifyingBranchCount: 1,
    ...overrides,
  };
}

function locContribution(): BranchMetricLocContribution {
  return {
    sourceEventId: "publication-1",
    branchId: BRANCH,
    occurredAt: IN_WINDOW,
    additions: LINES,
    deletions: 0,
  };
}

/**
 * One branch, two cost facts from two Sessions, each carrying exactly the
 * fields the cost contract declares and nothing that says which phase produced
 * it. This is a KERNEL input, hand-built: it pins that nothing downstream
 * filters on phase. It is NOT the unplaceable Session of AC-3 — see the file
 * docstring for why that cost never reaches this module at all.
 */
function inputWithUnclassifiableSessionCost(): BranchListMetricInput {
  return {
    cohortSize: 1,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: [
      {
        branchId: BRANCH,
        currentActive: true,
        priorActive: null,
        lastActivityAt: IN_WINDOW,
      },
    ],
    locContributions: [locContribution()],
    locCoverageComplete: true,
    locCompleteBranchIds: [BRANCH],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [
      costContribution(),
      costContribution({
        sourceEventId: "cost-event-unclassifiable",
        sessionId: "session-unclassifiable",
        costUsd: UNCLASSIFIABLE_COST_USD,
      }),
    ],
    costCompleteBranchIds: [BRANCH],
    locPerDollarCostCoverageComplete: true,
  };
}

function bundleFor(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
  );
}

describe("ISS-9970 the dollar is total estimated cost, not a phase subset", () => {
  it("counts every cost contribution it receives, with no phase left to filter on", () => {
    const bundle = bundleFor(inputWithUnclassifiableSessionCost());

    expect(bundle.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: TOTAL_ESTIMATED_COST_USD,
    });
  });

  it("divides LOC by that same total, not by the classified subset", () => {
    const bundle = bundleFor(inputWithUnclassifiableSessionCost());

    expect(bundle.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: LINES / TOTAL_ESTIMATED_COST_USD,
    });
    expect(bundle.locPerDollar.current.value).not.toBe(
      LINES / CLASSIFIED_COST_USD
    );
  });
});

describe("ISS-9970 the producer stops carrying lifecycle phase", () => {
  it("emits cost contributions with no phase key for any phase to filter on", () => {
    const contributions = branchMetricCostContributions(
      new Map([[BRANCH, reviewPhaseAttribution()]])
    );

    expect(contributions).toHaveLength(1);
    for (const contribution of contributions) {
      expect(Object.keys(contribution)).not.toContain("phase");
    }
  });

  it("emits one contribution per cost event whatever phase produced it", () => {
    const contributions = branchMetricCostContributions(
      new Map([[BRANCH, everyPhaseAttribution()]])
    );

    expect(contributions.map((contribution) => contribution.costUsd)).toEqual([
      CLASSIFIED_COST_USD,
      CLASSIFIED_COST_USD,
      CLASSIFIED_COST_USD,
    ]);
  });
});

function attributionSegment(
  phase: BranchVisibleLifecyclePhase,
  sequence: number
): BranchPhaseAttributionResult["segments"][number] {
  return {
    sessionId: `session-${sequence}`,
    sequence,
    phase,
    startMs: Date.parse(IN_WINDOW),
    endMs: Date.parse(IN_WINDOW) + 1,
    estimatedCostUsd: CLASSIFIED_COST_USD,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
    qualifyingBranchCount: 1,
    costEvents: [
      {
        sourceEventId: `cost-event-${sequence}`,
        occurredAtMs: Date.parse(IN_WINDOW),
        costUsd: CLASSIFIED_COST_USD,
      },
    ],
  };
}

function attributionOf(
  segments: BranchPhaseAttributionResult["segments"]
): BranchPhaseAttributionResult {
  return {
    segments,
    rollups: [],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: CLASSIFIED_COST_USD * segments.length,
    },
  };
}

function reviewPhaseAttribution(): BranchPhaseAttributionResult {
  return attributionOf([
    attributionSegment(BranchVisibleLifecyclePhase.Review, 0),
  ]);
}

function everyPhaseAttribution(): BranchPhaseAttributionResult {
  return attributionOf([
    attributionSegment(BranchVisibleLifecyclePhase.Build, 0),
    attributionSegment(BranchVisibleLifecyclePhase.Review, 1),
    attributionSegment(BranchVisibleLifecyclePhase.Rework, 2),
  ]);
}
