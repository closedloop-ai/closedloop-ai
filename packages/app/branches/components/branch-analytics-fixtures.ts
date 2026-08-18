import type {
  BranchAnalytics,
  BranchBaselineScope,
  BranchKpi,
} from "@repo/api/src/types/branch";
import { BranchKpiState, BranchViewerScope } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";

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

/**
 * A canonical PRD-601 List metric bundle with every numeric card unavailable.
 * Tests override only the canonical values they exercise so renderer fixtures
 * cannot accidentally assert legacy KPI fields against the approved renderer.
 */
export function makeBranchListMetrics(
  overrides: Partial<BranchListMetricBundle> = {}
): BranchListMetricBundle {
  const unavailable = {
    current: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    },
  } as const;
  return {
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    window: {
      startAt: "2026-07-06T00:00:00.000Z",
      endAt: "2026-08-05T00:00:00.000Z",
    },
    cohortSize: 0,
    lastActiveAt: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    },
    activeBranches: unavailable,
    locPerDollar: unavailable,
    medianPrSize: unavailable,
    aiSpendUsd: unavailable,
    mergeRatePct: unavailable,
    ...overrides,
  };
}

/**
 * An AVAILABLE KPI carrying a real 30-day baseline and the population it was
 * measured in (ISS-4686). The scope is required because `BranchKpiWithBaseline`
 * requires it — a fixture can no more build an unscoped baseline than a producer
 * can. `deltaPct` is settable independently of `value`/`baseline30d` so a suite
 * can pin the wire-vs-derived case: consumers derive the percentage themselves
 * and must ignore a contradictory one here.
 */
export function baselinedKpi({
  value,
  baseline30d,
  deltaPct,
  comparisonScope,
}: {
  value: number;
  baseline30d: number;
  deltaPct: number | null;
  comparisonScope: BranchBaselineScope;
}): BranchKpi {
  return {
    value,
    state: BranchKpiState.Available,
    baseline30d,
    deltaPct,
    comparisonScope,
  };
}
