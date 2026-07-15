import type { BranchAnalytics, BranchKpi } from "@repo/api/src/types/branch";
import { BranchKpiState, BranchViewerScope } from "@repo/api/src/types/branch";

/**
 * Shared `BranchAnalytics` fixture builders for the branches summary-card
 * tests. Both the app-side `branches-summary-cards.test.tsx` and the desktop
 * `metric-stability-mid-import.test.tsx` mount `BranchesSummaryCards` over an
 * analytics payload, so the `kpi` cell builder and the full-analytics builder
 * live here once instead of being redefined verbatim in each suite.
 */

/** A single KPI cell with a chosen state/value; deltas default to null. */
export function kpi(state: BranchKpiState, value: number | null): BranchKpi {
  return { value, state, baseline30d: null, deltaPct: null };
}

/**
 * A full `BranchAnalytics` payload where every card is inert (Unavailable /
 * Gated with null values) by default. Callers override just the KPI(s) their
 * test exercises, e.g. `makeBranchAnalytics({ activeBranchCount: kpi(...) })`.
 */
export function makeBranchAnalytics(
  overrides: Partial<BranchAnalytics> = {}
): BranchAnalytics {
  return {
    viewerScope: BranchViewerScope.Self,
    medianPrSize: kpi(BranchKpiState.Unavailable, null),
    mergeRate: kpi(BranchKpiState.Unavailable, null),
    medianTimeToMergeMs: kpi(BranchKpiState.Gated, null),
    activePrCount: kpi(BranchKpiState.Gated, null),
    mergedCount: kpi(BranchKpiState.Gated, null),
    leadTimeForChangeMs: kpi(BranchKpiState.Gated, null),
    locPerDollar: kpi(BranchKpiState.Unavailable, null),
    totalSpendUsd: kpi(BranchKpiState.Unavailable, null),
    activeBranchCount: kpi(BranchKpiState.Unavailable, null),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    ...overrides,
  };
}
