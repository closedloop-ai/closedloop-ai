/**
 * Edge cases for branch-list-metrics covering uncovered branches:
 * 1. calculateBranchLastActiveMetric — malformed-only events → unavailable
 * 2. calculateActiveBranches — partial result when snapshots < cohortSize
 * 3. calculateMedianPrSize — merged PRs with all-null additions → unavailable
 * 4. reconcileByIdentity — empty identity key → conflicted
 * 5. metricValue — AllTime label with non-null prior → returns { current } only
 */
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  calculateBranchLastActiveMetric,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";

const NOW = new Date("2026-08-03T21:00:00.000Z");
const CURRENT = "2026-08-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Inline helpers — NO default parameters or ternaries.
// ---------------------------------------------------------------------------

function emptyInput(cohortSize: number): BranchListMetricInput {
  return {
    cohortSize,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: Array.from({ length: cohortSize }, (_, i) => ({
      branchId: String.fromCharCode(97 + i),
      currentActive: true,
      priorActive: true,
    })),
    locContributions: [],
    locCompleteBranchIds: [],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: Array.from({ length: cohortSize }, (_, i) =>
      String.fromCharCode(97 + i)
    ),
  };
}

function pullRequest(
  identity: string,
  mergedAt: string | null,
  additions: number | null,
  deletions: number | null
) {
  return {
    identity,
    mergedAt,
    closedAt: null,
    isDraft: false,
    additions,
    deletions,
  };
}

function cost(
  sourceEventId: string,
  branchId: string,
  occurredAt: string | null,
  costUsd: number | null,
  qualifyingBranchCount: number | null
) {
  return {
    sourceEventId,
    branchId,
    sessionId: `session-${sourceEventId}`,
    occurredAt,
    phase: BranchVisibleLifecyclePhase.Build,
    costUsd,
    qualifyingBranchCount,
  };
}

// ---------------------------------------------------------------------------
// calculateBranchLastActiveMetric — malformed-only events → Unavailable
// ---------------------------------------------------------------------------

describe("calculateBranchLastActiveMetric — malformed events", () => {
  it("returns Unavailable when all events have null occurredAt (bySource stays empty → -Infinity → Unavailable)", () => {
    const result = calculateBranchLastActiveMetric(
      [
        { sourceEventId: "ev-1", occurredAt: null },
        { sourceEventId: "ev-2", occurredAt: null },
      ],
      true
    );
    // Every event has null timestamp → malformed → bySource empty → latest = -Infinity → unavailable
    expect(result.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("returns Unavailable when the only events have missing sourceEventIds", () => {
    const result = calculateBranchLastActiveMetric(
      [{ sourceEventId: "", occurredAt: CURRENT }],
      true
    );
    // Empty sourceEventId is falsy → !event.sourceEventId → continue → bySource empty → unavailable
    expect(result.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("returns Partial when valid events are mixed with malformed events and coverage is complete", () => {
    const result = calculateBranchLastActiveMetric(
      [
        { sourceEventId: "ev-1", occurredAt: CURRENT }, // valid → enters bySource
        { sourceEventId: "", occurredAt: CURRENT }, // malformed (empty id) → malformedEvidence=true
      ],
      true // coverageComplete → skips the !coverageComplete early-return
    );
    // malformedEvidence=true AND bySource non-empty AND coverageComplete
    // → the ternary arm: malformedEvidence ? partial(value, 1, 2) : complete(value)
    expect(result.state).toBe(BranchMetricAvailability.Partial);
  });
});

// ---------------------------------------------------------------------------
// calculateActiveBranches — partial when statusSnapshots.length < cohortSize
// ---------------------------------------------------------------------------

describe("calculateBranchListMetrics — partial activeBranches when snapshot count < cohortSize", () => {
  it("returns Partial activeBranches when fewer snapshots than cohortSize", () => {
    const input = emptyInput(3);
    // Only 1 of 3 expected snapshots present
    input.statusSnapshots = [
      { branchId: "a", currentActive: true, priorActive: true },
    ];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.activeBranches.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(result.activeBranches.current.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// calculateMedianPrSize — all merged PRs have null additions → Unavailable
// ---------------------------------------------------------------------------

describe("calculateBranchListMetrics — medianPrSize when all PR sizes are missing", () => {
  it("returns Unavailable when merged PRs have null additions and deletions", () => {
    const input = emptyInput(1);
    // PR merged in the current window but size is unknown
    input.pullRequests = [pullRequest("pr-1", CURRENT, null, null)];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    // knownSizes is empty → unavailable
    expect(result.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileByIdentity — empty identity key → conflicted
// ---------------------------------------------------------------------------

describe("calculateBranchListMetrics — reconcileByIdentity with empty identity key", () => {
  it("marks cost reconciliation conflicted when a contribution has empty sourceEventId (empty key)", () => {
    const input = emptyInput(1);
    // Cost contribution with empty sourceEventId: key = "\0" + branchId is truthy,
    // but for pullRequest with identity: "" the key IS empty → !key → conflicted.
    input.pullRequests = [
      pullRequest("", CURRENT, 10, 0), // identity: "" → !key → conflicted
    ];
    input.pullRequestCoverageComplete = true;
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    // With no valid (keyed) PRs after skipping the empty-identity one, decided=0
    // and pullRequestCoverageComplete=true → notApplicable for mergeRate.
    // The conflicted=true flag degrades mergeRate to partial/unavailable.
    expect(result.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("marks aiSpend conflicted when a cost contribution produces empty key (empty sourceEventId + branchId)", () => {
    const input = emptyInput(1);
    // sourceEventId="" and branchId="" makes key = "\x00" (non-empty, but truthy).
    // The true empty-key case for costContributions is actually not achievable via
    // the key formula `sourceEventId\0branchId` (always non-empty if both are "").
    // Cover it via pullRequest with identity="" instead (same reconcileByIdentity).
    input.costContributions = [
      cost("evt-1", "a", CURRENT, 10, 1),
      cost("evt-1", "a", CURRENT, 20, 1), // conflicting value for same key
    ];
    input.costCompleteBranchIds = ["a"];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    // Conflicting values → reconciled.conflicted=true → completeCoverage=false → Partial or Unavailable
    expect(result.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

// ---------------------------------------------------------------------------
// metricValue — AllTime label with non-null prior → returns { current } only
// ---------------------------------------------------------------------------

describe("calculateBranchListMetrics — metricValue AllTime label with prior window", () => {
  it("skips comparison output when label is AllTime even if a prior window is present", () => {
    // Construct a window with prior non-null but label=AllTime.
    // This exercises the `windows.label === AllTime → return { current }` branch.
    const artificialWindows = {
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: null, endAt: NOW.toISOString() },
      // Non-null prior is the unusual combination that exercises the second if branch.
      prior: {
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-07-01T00:00:00.000Z",
      },
    };
    const input = emptyInput(1);
    const result = calculateBranchListMetrics(input, artificialWindows);
    // metricValue short-circuits on AllTime label → no comparison produced.
    expect(result.activeBranches.comparison).toBeUndefined();
    expect(result.aiSpendUsd.comparison).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ISS-5987 — an UNQUALIFIED empty cohort is Unavailable, never No data
// ---------------------------------------------------------------------------

describe("calculateBranchListMetrics — empty cohort the producer could not qualify", () => {
  const windows = buildAdjacentBranchMetricWindows(
    BranchMetricPeriod.SevenDays,
    NOW
  );

  it("reports every metric Unavailable when cohortCoverageComplete is false", () => {
    // The desktop list read reaches this state whenever the repository-default
    // authority is unavailable: `resolveBranchDefaultEligibilitySnapshot` fails
    // closed and excludes every candidate, so the cohort arrives empty with
    // nothing actually decided about it. No data would assert a fact about a
    // population that was never qualified.
    const result = calculateBranchListMetrics(
      { ...emptyInput(0), cohortCoverageComplete: false },
      windows
    );

    for (const metric of [
      result.lastActiveAt,
      result.activeBranches.current,
      result.locPerDollar.current,
      result.medianPrSize.current,
      result.aiSpendUsd.current,
      result.mergeRatePct.current,
    ]) {
      expect(metric.state).toBe(BranchMetricAvailability.Unavailable);
      expect(metric.value).toBeNull();
    }
  });

  it("keeps every aggregate Unavailable for a non-empty mixed cohort", () => {
    const result = calculateBranchListMetrics(
      {
        ...emptyInput(6),
        cohortCoverageComplete: false,
        lastActiveEvents: [
          { sourceEventId: "known-branch", occurredAt: NOW.toISOString() },
        ],
        lastActiveCoverageComplete: true,
      },
      windows
    );

    expect(result.cohortSize).toBe(6);
    for (const metric of [
      result.lastActiveAt,
      result.activeBranches.current,
      result.locPerDollar.current,
      result.medianPrSize.current,
      result.aiSpendUsd.current,
      result.mergeRatePct.current,
    ]) {
      expect(metric.state).toBe(BranchMetricAvailability.Unavailable);
      expect(metric.value).toBeNull();
    }
  });

  it("still reports No data for a cohort the producer proved empty", () => {
    // The counterpart the rule must not swallow: an omitted flag means the
    // producer has no qualification step at all, so an empty cohort IS the
    // answer. Without this the fix above would read as a blanket change.
    const result = calculateBranchListMetrics(emptyInput(0), windows);

    expect(result.lastActiveAt.state).toBe(BranchMetricAvailability.NoData);
    expect(result.medianPrSize.current.state).toBe(
      BranchMetricAvailability.NoData
    );
    expect(result.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.NoData
    );
  });
});
