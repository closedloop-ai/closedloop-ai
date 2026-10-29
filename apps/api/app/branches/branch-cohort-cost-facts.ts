import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import { resolveCanonicalBranchMetricWindows } from "@repo/lib/branches/branch-list-metric-projection";
import {
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "@repo/lib/branches/branch-pull-request-metrics";
import { branchMetricDenominatorIdsSql } from "./branch-candidate-read";
import { readCostMetricFacts } from "./branch-cost-window-metrics";
import { branchListQuerySchema } from "./branch-list-query";

/**
 * AI spend for an exact branch cohort over every window the metric fold asks
 * about. The even-split divisor is the org-wide eligible set, not the cohort.
 */
export function readCohortCostFacts(
  organizationId: string,
  branchIds: readonly string[],
  query: { startDate?: Date; endDate?: Date },
  now: Date
): Promise<BranchMetricCostFacts> {
  const windows = branchMetricFactWindows(
    resolveCanonicalBranchMetricWindows({ ...query, now })
  );
  return readCostMetricFacts(
    organizationId,
    branchIds,
    branchMetricDenominatorIdsSql(
      organizationId,
      branchListQuerySchema.parse({}),
      now
    ),
    windows.map((window) => ({ key: branchMetricWindowKey(window), ...window }))
  );
}
