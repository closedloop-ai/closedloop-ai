/**
 * ISS-4503: the logical-QA pack's CROSS-SURFACE invariant, held against the
 * derivation the Branches summary card actually renders from.
 *
 * The pack's soul names this defect by its shape: the KPI card and the table it
 * summarizes, windowed differently. The card is not free to describe a
 * population the table below it is not showing.
 *
 * WHICH DERIVATION, and entered where the hosts enter it. Both shells call
 * `bindApprovedBranchCohortAnalyticsOverFilteredRows` (`approved-branch-cohort.ts`,
 * whose own comment calls these "the binders every host uses, and since ISS-10734
 * the only two that exist") — `apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx`
 * and `apps/desktop/src/renderer/components/branches/branches-view.tsx` each
 * pick one of the pair. These cases drive that binder, not the
 * `recomputeCanonicalMetricsOverFilteredRows` fallback underneath it,
 * because the binder is what chooses the population the fallback sees: it hands
 * the fallback `filteredRows` and `unfilteredRows` in separate argument slots,
 * and swapping them is a card windowed to the corpus above a table windowed to
 * the facet. A suite entered at the fallback cannot see that swap (whitlockk,
 * review). That is also what makes this a cross-surface invariant rather than a
 * single screen's: one binder, two shells, so a windowing bug here is a lie on
 * both.
 *
 * NOT `deriveFilteredBranchAnalytics`. The ISS-4407 suite
 * (`sessions-branches-reconciliation-invariants.test.ts`) already pins the
 * population and narrowing invariants against that function, and a review of
 * this change established it has no production caller left: every reference to
 * it repo-wide is a test, a stale docstring, or its own definition. Adding a
 * second suite over it would have doubled the coverage of a path nothing
 * renders while leaving the live one bare.
 */

import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import { projectCanonicalBranchListMetrics } from "@repo/lib/branches/branch-list-metric-projection";
import { describe, expect, it } from "vitest";
import { makeBranchAnalytics } from "../../components/branch-analytics-fixtures";
import { bindApprovedBranchCohortAnalyticsOverFilteredRows } from "../approved-branch-cohort";
import { type BranchFilters, DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { makeWireRow } from "./filtered-branch-analytics-fixtures";

const MERGE_EVIDENCE = "2026-08-03T17:07:41.797Z";
const NOW = new Date("2026-09-25T00:00:00.000Z");

/** A branch GitHub has merged whose stored PR state has not caught up. */
function mergedRow(id: string, repoFullName: string) {
  return makeWireRow({
    id,
    mergedAt: MERGE_EVIDENCE,
    prNumber: 1,
    prState: GitHubPRState.Open,
    repoFullName,
    status: BranchStatus.Merged,
  });
}

function closedRow(id: string, repoFullName: string) {
  return makeWireRow({
    id,
    prNumber: 2,
    prState: GitHubPRState.Closed,
    repoFullName,
    status: BranchStatus.Closed,
  });
}

/** A genuinely open PR: OPEN state and no merge evidence behind it. */
function openRow(id: string, repoFullName: string) {
  return makeWireRow({
    id,
    mergedAt: null,
    prNumber: 3,
    prState: GitHubPRState.Open,
    repoFullName,
    status: BranchStatus.Open,
  });
}

/** A base carrying a canonical bundle, the precondition for a recompute. */
function baseWithCanonicalMetrics(): BranchAnalytics {
  return {
    ...makeBranchAnalytics({}),
    canonicalMetrics: projectCanonicalBranchListMetrics({
      branches: [],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      now: NOW,
    }),
  };
}

/**
 * The host call, with no cohort response for the producer to answer with, which
 * is the state a facet the producer cannot serve leaves the card in. Everything
 * the card publishes then comes from the rows the binder chose.
 */
function cardThroughBinder(
  filteredRows: ReturnType<typeof makeWireRow>[],
  unfilteredRows: ReturnType<typeof makeWireRow>[],
  filters: BranchFilters
) {
  return bindApprovedBranchCohortAnalyticsOverFilteredRows({
    analytics: baseWithCanonicalMetrics(),
    filteredRows,
    filters,
    request: null,
    response: null,
    unfilteredRows,
  }).analytics;
}

// The approved Repository facet's option ids are full repo names
// (`branch-filter-adapter.tsx` counts `row.repo`), so this is a selection the
// rendered table can actually send.
const REPO_FACET: BranchFilters = {
  ...DEFAULT_BRANCH_FILTERS,
  repos: ["acme/web"],
};

describe("ISS-4503 invariant: the summary card is windowed to the rows the table shows", () => {
  /**
   * The cohort the table renders after a Repository facet: one merged PR and
   * one closed, so the decided denominator is 2 and the rate is 50%.
   *
   * The wider corpus holds two further merged branches, so a card reading the
   * wrong population cannot land on 50 by coincidence — but it does not land on
   * the corpus's own 75 either. Handed the corpus in both row slots,
   * `sameRowCohort` is true, the shipped binder declines on identity, and the
   * card publishes the empty base bundle: a `null` rate over a cohort of 0.
   * `toBe(50)` is therefore the whole guard here, and an assertion that the
   * rate is merely not 75 would hold for the correct value and for every
   * mutation alike (marisolashgrove, review).
   */
  const visibleRows = [
    mergedRow("b1", "acme/web"),
    closedRow("b2", "acme/web"),
  ];
  const unfilteredRows = [
    ...visibleRows,
    mergedRow("b3", "acme/api"),
    mergedRow("b4", "acme/api"),
  ];

  it("publishes the filtered cohort's merge rate, not the corpus's", () => {
    const card = cardThroughBinder(visibleRows, unfilteredRows, REPO_FACET);

    const rate = card?.canonicalMetrics?.mergeRatePct.current;

    // One merged, one closed among the two rows the table shows.
    expect(rate?.value).toBe(50);
  });

  it("sizes the cohort to the visible rows", () => {
    const card = cardThroughBinder(visibleRows, unfilteredRows, REPO_FACET);

    expect(card?.canonicalMetrics?.cohortSize).toBe(visibleRows.length);
    expect(card?.canonicalMetrics?.cohortSize).toBe(2);
  });

  it("keeps a stale-open-but-merged branch on the merged side of the rate", () => {
    // Both rows carry `prState: OPEN`; only `mergedAt` separates them, so the
    // merge-evidence-first classifier is the only thing that can tell them
    // apart. Reading the raw state instead makes BOTH active, emptying the
    // decided denominator entirely — the rate stops being 100 and stops being
    // Complete, while the table still shows one merged branch and one open one.
    const staleOpenPair = [
      mergedRow("b1", "acme/web"),
      openRow("b2", "acme/web"),
    ];
    const card = cardThroughBinder(
      staleOpenPair,
      [...staleOpenPair, closedRow("b3", "acme/api")],
      REPO_FACET
    );

    expect(card?.canonicalMetrics?.mergeRatePct.current.value).toBe(100);
    expect(card?.canonicalMetrics?.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });
});
