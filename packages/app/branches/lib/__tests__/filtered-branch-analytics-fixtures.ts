import {
  type BranchAnalytics,
  BranchBaselineScope,
  BranchKpiState,
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { makeBranchAnalytics } from "../../components/branch-analytics-fixtures";

/**
 * Shared fixtures for the `deriveFilteredBranchAnalytics` suites — the general
 * re-projection tests (`filtered-branch-analytics.test.ts`) and the Value-per-$
 * window-stability tests (`filtered-branch-analytics.value-per-dollar.test.ts`).
 * Kept in one module so the two files cannot drift on the wire-row shape or on
 * what a "full corpus" base looks like.
 */

export function makeWireRow(over: Partial<WireBranchRow> = {}): WireBranchRow {
  return {
    id: "b1",
    branchName: "feature/x",
    baseBranch: null,
    repoFullName: "acme/web",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-10T12:00:00.000Z",
    sessionIds: [],
    ...over,
  };
}

/**
 * A base analytics whose local KPIs report the FULL corpus, so a passthrough
 * (unfiltered) result is obviously distinguishable from a re-derived one.
 */
export function fullCorpusBase(): BranchAnalytics {
  return makeBranchAnalytics({
    activeBranchCount: {
      value: 99,
      state: BranchKpiState.Available,
      baseline30d: 50,
      deltaPct: 10,
      // A corpus KPI carries a corpus-scoped baseline (ISS-4686).
      comparisonScope: BranchBaselineScope.Corpus,
    },
    totalSpendUsd: {
      value: 1000,
      state: BranchKpiState.Available,
      baseline30d: 900,
      deltaPct: 5,
      comparisonScope: BranchBaselineScope.Corpus,
    },
    mergeRate: {
      value: 42,
      state: BranchKpiState.Available,
      baseline30d: null,
      deltaPct: null,
    },
  });
}
