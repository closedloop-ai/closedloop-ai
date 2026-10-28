import {
  type BranchKpi,
  BranchKpiState,
  NO_BRANCH_KPI_BASELINE,
} from "@repo/api/src/types/branch";
import type { BranchListMetricBundle } from "@repo/api/src/types/branch-metrics";
import { reportableSpendUsd } from "./spend-kpi";

/**
 * The two spend-based legacy `BranchAnalytics` KPIs, taken from the cards'
 * own figures so no producer derives them a second time (ISS-12346, ISS-12361).
 * Spend keeps the null-on-zero rule of `reportableSpendUsd` (ISS-4737).
 */
export function canonicalSpendKpis(
  metrics: Pick<BranchListMetricBundle, "aiSpendUsd" | "locPerDollar">
): { totalSpendUsd: BranchKpi; locPerDollar: BranchKpi } {
  return {
    totalSpendUsd: kpi(
      reportableSpendUsd(metrics.aiSpendUsd.current.value ?? 0)
    ),
    locPerDollar: kpi(metrics.locPerDollar.current.value),
  };
}

function kpi(value: number | null): BranchKpi {
  return {
    value,
    state:
      value === null ? BranchKpiState.Unavailable : BranchKpiState.Available,
    ...NO_BRANCH_KPI_BASELINE,
  };
}
