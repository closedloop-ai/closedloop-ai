import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costFactsFromContributions } from "./branch-cost-facts-from-contributions";
import {
  type CanonicalBranchMetricRow,
  projectCanonicalBranchListMetrics,
  resolveCanonicalBranchMetricWindows,
} from "./branch-list-metric-projection";
import {
  type BranchMetricCostContribution,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import {
  branchIsInMetricCohortWindow,
  buildAdjacentBranchMetricWindows,
} from "./branch-metric-windows";
import { branchMetricFactWindows } from "./branch-pull-request-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;
const END = new Date("2026-08-20T23:59:59.999Z");

/**
 * The 2026-08-20 Branches sweep, transcribed. Four ranges over ONE org: the
 * pagination footer reported 220 / 238 / 305 / 307 Branches and the same API's
 * own windowed count reported 201 / 206 / 206 / 207 open — while the ACTIVE
 * BRANCHES tile printed 207 in all four. Every literal below is hand-written
 * from that capture rather than derived from the code under test.
 */
const SWEEP = {
  sevenDay: { cohort: 220, open: 201 },
  thirtyDay: { cohort: 238, open: 206 },
  ninetyDay: { cohort: 305, open: 206 },
  lifetime: { cohort: 307, open: 207 },
} as const;

/** The bit-identical 90d and All AI SPEND figure from the same capture. */
const SWEEP_AI_SPEND_USD = 20.390_182_633_333_34;

/**
 * Bands of the same cohort by age, sized so the four cumulative totals above
 * fall out exactly. `openCount` is likewise hand-written per band.
 */
const COHORT_BANDS = [
  { daysAgo: 1, size: 220, openCount: 201 },
  { daysAgo: 15, size: 18, openCount: 5 },
  { daysAgo: 60, size: 67, openCount: 0 },
  { daysAgo: 200, size: 2, openCount: 1 },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(END);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ISS-7363: ACTIVE BRANCHES against the range the reader selected", () => {
  it("rescopes with the range while the unwindowed field stays on its lifetime number", () => {
    const sevenDay = projectSweep(7);
    const thirtyDay = projectSweep(30);
    const ninetyDay = projectSweep(90);
    const lifetime = projectSweep(null);

    // The defect, still exactly reproducible on the unwindowed field: one number,
    // every range, over a population none of the finite ranges describe. ISS-12309
    // moved the CARD off this field; the field itself is unchanged and still
    // answers for the lifetime cohort, which is what these literals pin.
    expect([
      sevenDay.activeBranches.current.value,
      thirtyDay.activeBranches.current.value,
      ninetyDay.activeBranches.current.value,
      lifetime.activeBranches.current.value,
    ]).toEqual([
      SWEEP.lifetime.open,
      SWEEP.lifetime.open,
      SWEEP.lifetime.open,
      SWEEP.lifetime.open,
    ]);

    // The range-scoped field moves with the range, and lands on the count the
    // sweep took from the API's own windowed figure. Since ISS-12309 this is what
    // the Active branches card renders.
    expect([
      sevenDay.windowScoped?.activeBranches.current.value,
      thirtyDay.windowScoped?.activeBranches.current.value,
      ninetyDay.windowScoped?.activeBranches.current.value,
      lifetime.windowScoped?.activeBranches.current.value,
    ]).toEqual([
      SWEEP.sevenDay.open,
      SWEEP.thirtyDay.open,
      SWEEP.ninetyDay.open,
      SWEEP.lifetime.open,
    ]);
  });

  it("never reports more active Branches than the range's own cohort holds", () => {
    const cohorts = [
      { metrics: projectSweep(7), cohort: SWEEP.sevenDay.cohort },
      { metrics: projectSweep(30), cohort: SWEEP.thirtyDay.cohort },
      { metrics: projectSweep(90), cohort: SWEEP.ninetyDay.cohort },
    ];
    for (const { metrics, cohort } of cohorts) {
      const scoped = metrics.windowScoped?.activeBranches.current.value ?? null;
      expect(scoped).not.toBeNull();
      expect(scoped as number).toBeLessThanOrEqual(cohort);
    }
    // Positive sibling: the bound above is not satisfied by an absent tile.
    expect(projectSweep(7).windowScoped?.activeBranches.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });

  it("retains an unknown or future Last active exactly as the list cohort does", () => {
    const window = {
      startAt: "2026-08-13T23:59:59.999Z",
      endAt: END.toISOString(),
    };
    const evaluationNow = END.toISOString();
    expect(branchIsInMetricCohortWindow(null, window, evaluationNow)).toBe(
      true
    );
    expect(
      branchIsInMetricCohortWindow("not-a-timestamp", window, evaluationNow)
    ).toBe(true);
    expect(
      branchIsInMetricCohortWindow(
        "2026-09-01T00:00:00.000Z",
        window,
        evaluationNow
      )
    ).toBe(true);
    expect(
      branchIsInMetricCohortWindow(
        "2026-08-19T00:00:00.000Z",
        window,
        evaluationNow
      )
    ).toBe(true);
    // The one arm that must exclude, or the predicate admits everything.
    expect(
      branchIsInMetricCohortWindow(
        "2026-07-01T00:00:00.000Z",
        window,
        evaluationNow
      )
    ).toBe(false);
  });
});

describe("ISS-7364: a knowable zero is not an unknown", () => {
  it("settles AI SPEND at a real zero as the range narrows instead of vanishing", () => {
    const thirtyDay = projectSpendSweep(30);
    const ninetyDay = projectSpendSweep(90);

    // ISS-12346: the shipped field and the range-scoped one read the same facts,
    // so the 30-day range no longer collapses to Unavailable while the companion
    // shows a zero. The cohort holds cost, none of it in range: a knowable zero.
    const settledZero = {
      state: BranchMetricAvailability.Complete,
      value: 0,
    };
    expect(thirtyDay.aiSpendUsd.current).toEqual(settledZero);
    expect(thirtyDay.windowScoped?.aiSpendUsd.current).toEqual(settledZero);
    expect(ninetyDay.aiSpendUsd.current.value).toBe(SWEEP_AI_SPEND_USD);
    expect(ninetyDay.windowScoped?.aiSpendUsd.current.value).toBe(
      SWEEP_AI_SPEND_USD
    );
    // A subset range cannot exceed its superset.
    expect(
      thirtyDay.windowScoped?.aiSpendUsd.current.value as number
    ).toBeLessThanOrEqual(
      ninetyDay.windowScoped?.aiSpendUsd.current.value as number
    );
  });

  it("keeps a settled zero and an unknown as separate states", () => {
    const knowableZero = projectSpendSweep(30).aiSpendUsd.current;
    const trulyUnknown = projectNoTelemetry(30).aiSpendUsd.current;

    expect(knowableZero.state).toBe(BranchMetricAvailability.Complete);
    expect(trulyUnknown.state).toBe(BranchMetricAvailability.Unavailable);
    expect(knowableZero.value).toBe(0);
    expect(trulyUnknown.value).toBeNull();
  });

  it("leaves LOC per $ unknown when the range holds no cost to divide by", () => {
    // A ratio over an unknown denominator is not a zero, so LOC per $ has NO
    // range-scoped companion and the shipped field stays the honest answer.
    expect(projectSpendSweep(30).windowScoped).not.toHaveProperty(
      "locPerDollar"
    );
    expect(projectSpendSweep(30).locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
    // Positive sibling: the same tile does resolve where the range has cost.
    expect(projectSpendSweep(90).locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("keeps in-range cost it could not READ as unknown, not as zero", () => {
    // `included === 0` also covers evidence that DID land in the range and was
    // unreadable. Summing that to $0.00 would be the same collapse, reversed.
    const unreadable = projectCanonicalBranchListMetrics({
      branches: sweepCohort(),
      pullRequests: [],
      pullRequestCoverageComplete: true,
      costContributions: [
        { ...spendContribution(15), qualifyingBranchCount: 0 },
      ],
      costCompleteBranchIds: ["cost-branch"],
      aiSpendFacts: spendFacts(
        [{ ...spendContribution(15), qualifyingBranchCount: 0 }],
        30
      ),
      ...rangeFor(30),
      now: END,
    });
    // ISS-12346 C6 and operator ruling 2026-10-14: publish the spend that could
    // be read, starred, never Unavailable because one record is unusable.
    expect(unreadable.windowScoped?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 0,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
    // Positive sibling: the SAME range publishes the zero once the only
    // qualifying evidence is readable and simply sits outside it.
    expect(projectSpendSweep(30).windowScoped?.aiSpendUsd.current.value).toBe(
      0
    );
  });

  it.each([
    { label: "an absent instant", occurredAt: null },
    { label: "an unparseable instant", occurredAt: "not-a-timestamp" },
  ])(
    "keeps cost carrying $label as unknown, not as a knowable zero",
    ({ occurredAt }) => {
      // Evidence whose instant cannot be READ never reaches the window filter,
      // so "none of it landed in this range" is not a fact the cohort supports:
      // the contribution may well be in the range. Absence of evidence and
      // evidence that cannot be placed are different answers.
      const unplaceable = projectCanonicalBranchListMetrics({
        branches: sweepCohort(),
        pullRequests: [],
        pullRequestCoverageComplete: true,
        costContributions: [{ ...spendContribution(60), occurredAt }],
        costCompleteBranchIds: ["cost-branch"],
        aiSpendFacts: spendFacts(
          [{ ...spendContribution(60), occurredAt }],
          30
        ),
        ...rangeFor(30),
        now: END,
      });
      // ISS-12346 C6 and operator ruling 2026-10-14: an undatable event stars
      // the figure; it does not withhold it.
      expect(unplaceable.windowScoped?.aiSpendUsd.current).toEqual({
        state: BranchMetricAvailability.Partial,
        value: 0,
        disclosure: BranchMetricDisclosure.CostIncomplete,
      });
      // The state it must NOT take: the $0.00* a placeable contribution earns.
      expect(unplaceable.windowScoped?.aiSpendUsd.current).not.toEqual({
        state: BranchMetricAvailability.Complete,
        value: 0,
      });
    }
  );

  it("keeps a cohort with no cost telemetry at all as unknown", () => {
    expect(projectNoTelemetry(30).windowScoped?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });
});

describe("range-scoped cohort membership through the production projection", () => {
  it("retains a Branch last active AHEAD of the evaluation clock", () => {
    const future = projectCanonicalBranchListMetrics({
      branches: [
        {
          id: "skewed",
          status: BranchStatus.Open,
          lastActivityAt: new Date(END.getTime() + DAY_MS).toISOString(),
        },
        {
          id: "stale",
          status: BranchStatus.Open,
          lastActivityAt: instantDaysAgo(200),
        },
      ],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      ...rangeFor(7),
      now: END,
    });
    // The list SQL retains a future Last active and drops the stale row, so the
    // tile counts exactly one. This fails if the projection stops handing the
    // metric its evaluation instant.
    expect(future.windowScoped?.activeBranches.current.value).toBe(1);
  });

  it("compares the range against the PRIOR range, not against itself", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      END,
      END
    );
    const result = calculateBranchListMetrics(
      {
        cohortSize: 8,
        lastActiveCoverageComplete: true,
        lastActiveEvents: [],
        statusSnapshots: [
          ...activeSnapshots("current", 1, [true, true, true, false], false),
          ...activeSnapshots("prior", 10, [true, true, false, false], true),
        ],
        locContributions: [],
        locCompleteBranchIds: [],
        pullRequests: [],
        pullRequestCoverageComplete: true,
        costContributions: [],
        costCompleteBranchIds: [],
        evaluationNow: END.toISOString(),
      },
      windows
    );
    // 3 active now vs 2 in the prior 7 days: +50%. Comparing the range against
    // itself instead reads the current rows' null `priorActive` and goes
    // Unavailable.
    expect(result.windowScoped?.activeBranches.comparison?.deltaPct).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 50,
    });
    expect(result.windowScoped?.activeBranches.current.value).toBe(3);
  });

  it("never claims a prior-range zero from a cohort with no prior evidence", () => {
    // Production never supplies `priorActive`, so every comparison must stay
    // unknown — including when the prior range's scoped subset is EMPTY, where
    // `[].some()` would otherwise skip the fail-closed guard.
    const sevenDay = projectSweep(7);
    expect(sevenDay.windowScoped?.activeBranches.comparison?.deltaPct).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
    // Positive sibling: the current range on the same bundle DID resolve.
    expect(sevenDay.windowScoped?.activeBranches.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });
});

function activeSnapshots(
  prefix: string,
  daysAgo: number,
  flags: readonly boolean[],
  prior: boolean
) {
  return flags.map((flag, index) => ({
    branchId: `${prefix}-${index}`,
    currentActive: prior ? null : flag,
    priorActive: prior ? flag : null,
    lastActivityAt: instantDaysAgo(daysAgo),
  }));
}

function projectSweep(days: number | null) {
  return projectCanonicalBranchListMetrics({
    branches: sweepCohort(),
    pullRequests: [],
    pullRequestCoverageComplete: true,
    ...rangeFor(days),
    now: END,
  });
}

function projectSpendSweep(days: number | null) {
  return projectCanonicalBranchListMetrics({
    branches: sweepCohort(),
    pullRequests: [],
    pullRequestCoverageComplete: true,
    // One priced contribution, 60 days old: inside 90d, outside 30d. Coverage is
    // incomplete because only one of the cohort's Branches has complete cost.
    costContributions: [spendContribution(60)],
    costCompleteBranchIds: ["cost-branch"],
    aiSpendFacts: spendFacts([spendContribution(60)], days),
    locContributions: [
      {
        sourceEventId: "loc-60",
        branchId: "cost-branch",
        occurredAt: instantDaysAgo(60),
        additions: 5000,
        deletions: 1000,
      },
    ],
    locCompleteBranchIds: ["cost-branch"],
    ...rangeFor(days),
    now: END,
  });
}

function projectNoTelemetry(days: number | null) {
  return projectCanonicalBranchListMetrics({
    branches: sweepCohort(),
    pullRequests: [],
    pullRequestCoverageComplete: true,
    aiSpendFacts: spendFacts([], days),
    ...rangeFor(days),
    now: END,
  });
}

/** What a producer folds for the range: spend per window from its cost events. */
function spendFacts(
  contributions: readonly BranchMetricCostContribution[],
  days: number | null
) {
  return costFactsFromContributions(
    contributions,
    branchMetricFactWindows(
      resolveCanonicalBranchMetricWindows({ ...rangeFor(days), now: END })
    )
  );
}

function rangeFor(days: number | null) {
  if (days === null) {
    return {};
  }
  return {
    startDate: new Date(END.getTime() - days * DAY_MS),
    endDate: END,
  };
}

function sweepCohort(): CanonicalBranchMetricRow[] {
  return COHORT_BANDS.flatMap((band) =>
    Array.from({ length: band.size }, (_unused, index) => ({
      id: `branch-${band.daysAgo}-${index}`,
      status: index < band.openCount ? BranchStatus.Open : BranchStatus.Merged,
      lastActivityAt: instantDaysAgo(band.daysAgo),
    }))
  );
}

function spendContribution(daysAgo: number): BranchMetricCostContribution {
  return {
    sourceEventId: `spend-${daysAgo}`,
    branchId: "cost-branch",
    sessionId: `session-${daysAgo}`,
    occurredAt: instantDaysAgo(daysAgo),
    costUsd: SWEEP_AI_SPEND_USD,
    qualifyingBranchCount: 1,
  };
}

function instantDaysAgo(days: number): string {
  return new Date(END.getTime() - days * DAY_MS).toISOString();
}
