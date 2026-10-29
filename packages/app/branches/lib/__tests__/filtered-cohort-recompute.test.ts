/**
 * ISS-9967 — a facet filter narrows the population; it does not remove the
 * ability to count it. The recompute fallback derives every row-provable card
 * over the rows on screen where the shipped fallback fails closed, and the
 * host binder that selects it neither withholds the session cost map nor
 * captions the row as a filter problem.
 *
 * Row-provable is the whole boundary, and these cases pin BOTH sides of it.
 * Median PR size and Merge rate are derivable from the rows — over single-PR
 * branches only, so a cohort holding a multi-PR branch is published `Partial`
 * with that coverage. `canonicalLocPerDollar` and `totalLocPushed` are NOT:
 * their numerators are timestamped publication evidence a Branch row does not
 * carry, so they keep the shipped path rather than being re-derived from
 * whole-branch file-cache churn over a windowed cost map.
 */
import {
  type BranchAnalytics,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import { bindApprovedBranchCohortAnalyticsOverFilteredRows } from "../approved-branch-cohort";
import { bindCanonicalMetricsToFilteredRows } from "../approved-filtered-metrics";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { recomputeCanonicalMetricsOverFilteredRows } from "../filtered-cohort-recompute";
import { unavailableKpi, wireRow } from "./approved-branch-fixtures";

const FILTERS = {
  ...DEFAULT_BRANCH_FILTERS,
  statuses: [BranchStatus.Merged, BranchStatus.Open],
};
const COMPLETE_ONE = {
  current: { state: BranchMetricAvailability.Complete, value: 1 },
} as const;

function analytics(): BranchAnalytics {
  const canonicalMetrics: BranchListMetricBundle = {
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    window: {
      startAt: "2026-07-06T00:00:00.000Z",
      endAt: "2026-08-05T00:00:00.000Z",
    },
    cohortSize: 4,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-08-05T12:00:00.000Z",
    },
    activeBranches: COMPLETE_ONE,
    locPerDollar: COMPLETE_ONE,
    medianPrSize: COMPLETE_ONE,
    aiSpendUsd: COMPLETE_ONE,
    mergeRatePct: COMPLETE_ONE,
    canonicalLocPerDollar: COMPLETE_ONE,
    totalLocPushed: COMPLETE_ONE,
  };
  return {
    viewerScope: BranchViewerScope.Self,
    canonicalMetrics,
    medianPrSize: unavailableKpi(),
    mergeRate: unavailableKpi(),
    activeBranchCount: unavailableKpi(),
    activePrCount: unavailableKpi(),
    mergedCount: unavailableKpi(),
    totalSpendUsd: unavailableKpi(),
    locPerDollar: unavailableKpi(),
  } as BranchAnalytics;
}

/**
 * Two merged single-PR branches (sizes 100 and 300 → median 200), one closed
 * (so merge rate is 2 of 3 decided), one open. Four rows, 100 + 300 + 20 + 50
 * = 470 lines of LOC-enriched churn, and $50 of session cost counted once
 * across the shared session.
 */
const FILTERED_ROWS = [
  wireRow({
    id: "b1",
    status: BranchStatus.Merged,
    prState: GitHubPRState.Merged,
    additions: 60,
    deletions: 40,
    sessionIds: ["s1"],
  }),
  wireRow({
    id: "b2",
    status: BranchStatus.Merged,
    prState: GitHubPRState.Merged,
    additions: 200,
    deletions: 100,
    sessionIds: ["s1", "s2"],
  }),
  wireRow({
    id: "b3",
    status: BranchStatus.Closed,
    prState: GitHubPRState.Closed,
    additions: 10,
    deletions: 10,
    sessionIds: ["s3"],
  }),
  wireRow({
    id: "b4",
    status: BranchStatus.Open,
    prState: GitHubPRState.Open,
    additions: 30,
    deletions: 20,
    sessionIds: [],
  }),
];
const UNFILTERED_ROWS = [...FILTERED_ROWS, wireRow({ id: "b5" })];
const SESSION_COST_USD = { s1: 20, s2: 25, s3: 5 };

describe("recomputeCanonicalMetricsOverFilteredRows", () => {
  it("derives every row-provable card over the filtered rows where the shipped fallback fails closed", () => {
    const shipped = bindCanonicalMetricsToFilteredRows(
      analytics(),
      FILTERED_ROWS,
      FILTERS,
      SESSION_COST_USD,
      UNFILTERED_ROWS
    ).canonicalMetrics;
    const recomputed = recomputeCanonicalMetricsOverFilteredRows(
      analytics(),
      FILTERED_ROWS,
      FILTERS,
      SESSION_COST_USD,
      UNFILTERED_ROWS
    ).canonicalMetrics;
    if (!(shipped && recomputed)) {
      throw new Error("both binders must publish a bundle");
    }

    expect(shipped.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(shipped.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(shipped.canonicalLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );

    expect(recomputed.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 200,
    });
    expect(recomputed.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: (2 / 3) * 100,
    });
    // $50 over one shared session, counted once — the same figure the spend
    // card beside it reports — under 500 lines of churn.
    expect(recomputed.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 50,
    });
    // NOT 470/50 = 9.4. That ratio divides whole-branch file-cache churn by the
    // WINDOWED session-cost map — two populations — which is the defect
    // ISS-9956 removed from the producer. With no publication evidence on the
    // row there is nothing honest to publish, so it stays on the shipped path.
    expect(recomputed.canonicalLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(recomputed.canonicalLocPerDollar?.current.value).toBeNull();
    expect(recomputed.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
    expect(recomputed.cohortSize).toBe(4);
  });

  it("returns the analytics object unchanged when the facet removed no row", () => {
    const input = analytics();
    expect(
      recomputeCanonicalMetricsOverFilteredRows(
        input,
        FILTERED_ROWS,
        FILTERS,
        SESSION_COST_USD,
        FILTERED_ROWS
      )
    ).toBe(input);
  });

  it("reports a partially LOC-enriched cohort as Partial with its coverage, never a confident median", () => {
    const rows = [
      ...FILTERED_ROWS,
      wireRow({
        id: "b6",
        status: BranchStatus.Merged,
        prState: GitHubPRState.Merged,
        additions: null,
        deletions: null,
        sessionIds: [],
      }),
    ];
    const recomputed = recomputeCanonicalMetricsOverFilteredRows(
      analytics(),
      rows,
      FILTERS,
      SESSION_COST_USD,
      UNFILTERED_ROWS
    ).canonicalMetrics;
    // Three merged branches, two with landed line counts: the median is real
    // but it does not describe the third, so it is disclosed rather than starred.
    expect(recomputed?.medianPrSize.current).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: 200,
      coverage: { included: 2, total: 3 },
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
  });

  /**
   * `packages/app/branches/AGENTS.md` — "a branch is not a single PR". A row
   * carries only its latest PR's state, so a multi-PR branch is unreadable
   * here, while the canonical kernel derives per-PR from the full associated-PR
   * collection and excludes nothing. Publishing the remainder as `Complete`
   * would claim a population this derivation never measured (codex review).
   */
  it("discloses a cohort holding a multi-PR branch as Partial, never Complete", () => {
    const rows = [
      ...FILTERED_ROWS,
      wireRow({
        id: "b7",
        status: BranchStatus.Merged,
        prState: GitHubPRState.Merged,
        multiPrWarning: true,
        additions: 500,
        deletions: 0,
        sessionIds: [],
      }),
    ];
    const recomputed = recomputeCanonicalMetricsOverFilteredRows(
      analytics(),
      rows,
      FILTERS,
      SESSION_COST_USD,
      UNFILTERED_ROWS
    ).canonicalMetrics;
    expect(recomputed?.mergeRatePct.current).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: (2 / 3) * 100,
      coverage: { included: 4, total: 5 },
      disclosure: BranchMetricDisclosure.BranchesIncomplete,
    });
    // The merged multi-PR branch is in the denominator it shortens, and its own
    // 500 lines never reach the median.
    expect(recomputed?.medianPrSize.current).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: 200,
      coverage: { included: 2, total: 3 },
      disclosure: BranchMetricDisclosure.BranchesIncomplete,
    });
  });

  it("marks a cohort with no decided PR N/A rather than Unavailable", () => {
    const rows = [
      wireRow({
        id: "b4",
        status: BranchStatus.Open,
        prState: GitHubPRState.Open,
      }),
    ];
    const recomputed = recomputeCanonicalMetricsOverFilteredRows(
      analytics(),
      rows,
      FILTERS,
      SESSION_COST_USD,
      UNFILTERED_ROWS
    ).canonicalMetrics;
    expect(recomputed?.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    expect(recomputed?.medianPrSize.current.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });
});

describe("bindApprovedBranchCohortAnalyticsOverFilteredRows", () => {
  const request = { branchIds: FILTERED_ROWS.map((row) => row.id) };

  it("keeps the session cost map once a cohort was requested and does not blame the filter", () => {
    const bound = bindApprovedBranchCohortAnalyticsOverFilteredRows({
      analytics: analytics(),
      filteredRows: FILTERED_ROWS,
      unfilteredRows: UNFILTERED_ROWS,
      filters: FILTERS,
      sessionCostUsd: SESSION_COST_USD,
      request,
      response: undefined,
    });
    expect(bound.comparisonSuppressedByFilter).toBe(false);
    expect(bound.analytics?.canonicalMetrics?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 50,
    });
    expect(bound.analytics?.canonicalMetrics?.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 200,
    });
  });

  /**
   * marisolashgrove, ISS-12638: the Branches strip's connect ask may not be keyed
   * on an availability bucket, because THIS path writes `Unavailable` for
   * reasons GitHub cannot fix — the two cards with no row-provable form. The
   * flag below is what a host reads to withhold the ask on them; the host half
   * is `apps/desktop/.../branches-summary-connect-ask.test.ts`.
   */
  it("reports the figures as locally derived, with the cost-side cards blanked", () => {
    const bound = bindApprovedBranchCohortAnalyticsOverFilteredRows({
      analytics: analytics(),
      filteredRows: FILTERED_ROWS,
      unfilteredRows: UNFILTERED_ROWS,
      filters: FILTERS,
      sessionCostUsd: SESSION_COST_USD,
      request,
      response: undefined,
    });

    expect(bound.metricsDerivedLocally).toBe(true);
    // Both come back Unavailable with a connection that is healthy or absent
    // alike, which is exactly why the ask cannot read this state as GitHub's.
    expect(
      bound.analytics?.canonicalMetrics?.canonicalLocPerDollar?.current
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
    expect(bound.analytics?.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("reports an exact producer answer as not locally derived", () => {
    const bound = bindApprovedBranchCohortAnalyticsOverFilteredRows({
      analytics: analytics(),
      filteredRows: FILTERED_ROWS,
      unfilteredRows: UNFILTERED_ROWS,
      filters: FILTERS,
      sessionCostUsd: SESSION_COST_USD,
      request,
      response: {
        matchedBranchIds: request.branchIds,
        canonicalMetrics: analytics()
          .canonicalMetrics as BranchListMetricBundle,
      },
    });

    expect(bound.metricsDerivedLocally).toBe(false);
  });
});
