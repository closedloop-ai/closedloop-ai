/**
 * Edge cases for branch-list-metrics covering uncovered branches:
 * 1. calculateBranchLastActiveMetric — malformed-only events → unavailable
 * 2. calculateActiveBranches — partial result when snapshots < cohortSize
 * 3. calculateMedianPrSize — merged PRs with all-null additions → unavailable
 * 4. the reconcilers' empty identity key → conflicted
 * 5. metricValue — AllTime label with non-null prior → returns { current } only
 */
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  calculateBranchLastActiveMetric,
} from "./branch-list-metrics";
import { calculateMetricsWithSpendFacts as calculateBranchListMetrics } from "./branch-list-metrics.test-helpers";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import { BranchPublicationLocSource } from "./branch-publication-loc";

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
// empty identity key → conflicted
// ---------------------------------------------------------------------------

describe("calculateBranchListMetrics — reconcilers with an empty identity key", () => {
  it("marks cost reconciliation conflicted when a contribution has empty sourceEventId (empty key)", () => {
    const input = emptyInput(1);
    // Cost contribution with empty sourceEventId: key = "\0" + branchId is truthy,
    // but a pullRequest with identity "" has an EMPTY key, which no reconciler
    // can group on, so it is dropped and reported (ISS-11589 kept that arm).
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
    // authority is unavailable, so nothing was actually decided about the
    // cohort. No data would assert a fact about a population that was never
    // qualified.
    //
    // ISS-10864 changed how that cohort ARRIVES without changing this rule: a
    // failed authority read still fails closed and excludes every candidate, so
    // the cohort is empty; an ABSENT GitHub connection now passes every
    // candidate through instead, so the cohort can be full. Either way it is
    // unqualified, and `cohortCoverageComplete: false` is what says so.
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

const OUT_OF_WINDOW = "2026-01-01T00:00:00.000Z";
const HUGE_COST = Number.MAX_VALUE;

function sevenDayMetrics(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
  );
}

function locRow(sourceEventId: string, additions: number) {
  return {
    sourceEventId,
    branchId: "a",
    occurredAt: CURRENT,
    additions,
    deletions: 0,
  };
}

function pushedLocRow(sourceEventId: string, additions: number) {
  return {
    ...locRow(sourceEventId, additions),
    source: BranchPublicationLocSource.SuccessfulPush,
  };
}

function ratioInput(): BranchListMetricInput {
  const input = emptyInput(1);
  input.locContributions = [locRow("loc-1", 100)];
  input.locCompleteBranchIds = ["a"];
  input.costContributions = [cost("c1", "a", CURRENT, 10, 1)];
  return input;
}

describe("calculateBranchListMetrics — contested status snapshots", () => {
  it("withholds activeBranches when one branch reports two states", () => {
    const input = emptyInput(1);
    input.statusSnapshots = [
      { branchId: "a", currentActive: true, priorActive: true },
      { branchId: "a", currentActive: false, priorActive: true },
    ];
    expect(sevenDayMetrics(input).activeBranches.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

describe("calculateBranchListMetrics — locPerDollar denominator edges", () => {
  it("withholds a zero-cost ratio when cost coverage is incomplete", () => {
    const input = ratioInput();
    input.costContributions = [cost("c1", "a", CURRENT, 0, 1)];
    input.costCompleteBranchIds = [];
    expect(sevenDayMetrics(input).locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("withholds the ratio when the summed cost overflows to Infinity", () => {
    const input = ratioInput();
    input.costContributions = [
      cost("c1", "a", CURRENT, HUGE_COST, 1),
      cost("c2", "a", CURRENT, HUGE_COST, 1),
    ];
    expect(sevenDayMetrics(input).locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("marks the ratio partial when an interval gap spans the whole window", () => {
    const input = ratioInput();
    input.locCoverageGaps = [
      {
        sourceEventId: "gap-1",
        occurredAt: "2026-07-01T00:00:00.000Z",
        affectsUntil: "2026-09-01T00:00:00.000Z",
      },
    ];
    expect(sevenDayMetrics(input).locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("keeps the ratio complete when an interval gap ends before the window", () => {
    const input = ratioInput();
    input.locCoverageGaps = [
      {
        sourceEventId: "gap-1",
        occurredAt: "2026-07-01T00:00:00.000Z",
        affectsUntil: "2026-07-02T00:00:00.000Z",
      },
    ];
    expect(sevenDayMetrics(input).locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 10,
    });
  });
});

describe("calculateBranchListMetrics — merge rate under twinned PR rows", () => {
  it("counts a twinned merged identity once rather than dropping it", () => {
    // ISS-11589: `org/repo#1` arrives twice with disagreeing line counts. Both
    // rows used to be erased, leaving one closed-unmerged PR and a 0% rate over
    // a population missing a merge it had read. The tie-break keeps the merged
    // identity, so the rate is 1 merged of 2 decided.
    //
    // Neither row carries a `githubId`, so nothing settles WHICH size is right
    // and arrival order holds the answer. Per tamsinb's review on #8237 that
    // keeps `conflicted` set, so the rate publishes its real figure STARRED
    // rather than complete — the state this pair carried before the tie-break
    // existed. Counting the identity once is what this case pins, and that is
    // unchanged.
    const input = emptyInput(1);
    input.pullRequests = [
      pullRequest("org/repo#1", CURRENT, 30, 0),
      pullRequest("org/repo#1", CURRENT, 40, 0),
      { ...pullRequest("org/repo#2", null, 5, 0), closedAt: CURRENT },
      pullRequest("org/repo#3", OUT_OF_WINDOW, 5, 0),
    ];
    expect(sevenDayMetrics(input).mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 50,
      coverage: { included: 2, total: 2 },
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });
});

describe("calculateBranchLastActiveMetric — unparseable timestamp", () => {
  it("treats an unparseable instant as malformed and keeps the valid latest", () => {
    expect(
      calculateBranchLastActiveMetric(
        [
          { sourceEventId: "ev-1", occurredAt: CURRENT },
          { sourceEventId: "ev-2", occurredAt: "not-a-date" },
        ],
        true
      )
    ).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: CURRENT,
      coverage: { included: 1, total: 2 },
    });
  });
});

describe("calculateBranchListMetrics — canonicalLocPerDollar incomplete LOC", () => {
  it("withholds a zero-cost canonical ratio when LOC coverage is incomplete", () => {
    const input = ratioInput();
    input.locCompleteBranchIds = [];
    input.canonicalEstimatedCostUsd = 0;
    expect(sevenDayMetrics(input).canonicalLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("withholds the canonical ratio when no LOC lands in range and coverage is incomplete", () => {
    const input = ratioInput();
    input.locContributions = [];
    input.locCompleteBranchIds = [];
    input.canonicalEstimatedCostUsd = 20;
    expect(sevenDayMetrics(input).canonicalLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

describe("calculateBranchListMetrics — pushedLocPerDollar denominator edges", () => {
  function pushedInput(): BranchListMetricInput {
    const input = ratioInput();
    input.locContributions = [pushedLocRow("push-1", 100)];
    return input;
  }

  it("withholds the ratio when spend is zero and an event could not be priced", () => {
    const input = pushedInput();
    input.costContributions = [
      cost("c1", "a", CURRENT, 0, 1),
      cost("unpriced", "a", CURRENT, null, 1),
    ];
    expect(sevenDayMetrics(input).pushedLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("reads an Infinity spend total as not applicable", () => {
    // pins current behavior; looks odd because an overflowed (non-finite) spend
    // total with complete coverage is reported as "cost nothing" rather than
    // Unavailable.
    const input = pushedInput();
    input.costContributions = [
      cost("c1", "a", CURRENT, HUGE_COST, 1),
      cost("c2", "a", CURRENT, HUGE_COST, 1),
    ];
    expect(sevenDayMetrics(input).pushedLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });

  it("names cost as the incomplete term when an event could not be priced", () => {
    const input = pushedInput();
    input.costContributions = [
      ...input.costContributions,
      cost("unpriced", "a", CURRENT, null, 1),
    ];
    expect(sevenDayMetrics(input).pushedLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 10,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
  });
});
