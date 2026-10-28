import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import { resolveCanonicalBranchMetricWindows } from "@repo/lib/branches/branch-list-metric-projection";
import {
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "@repo/lib/branches/branch-pull-request-metrics";
import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";
import { readBranchCostMetricFacts } from "../database/branch-cost-window-reads.js";
import type { BranchKeyRow } from "../database/branch-reads.js";
import type { DbHostPrisma } from "../database/prisma-client.js";

/**
 * AI spend for an exact branch cohort over every window the metric fold asks
 * about. The even-split divisor is the eligible set, not the cohort.
 */
export function readDesktopCohortAiSpendFacts(
  prisma: DbHostPrisma,
  cohort: readonly BranchKeyRow[],
  eligible: readonly BranchKeyRow[],
  request: Pick<SharedBranchesQuery, "startDate" | "endDate">,
  requestBoundary: Date
): Promise<BranchMetricCostFacts> {
  const windows = branchMetricFactWindows(
    resolveCanonicalBranchMetricWindows({
      startDate: request.startDate,
      endDate: request.endDate,
      now: requestBoundary,
    })
  );
  return readBranchCostMetricFacts(prisma, {
    cohort,
    eligible,
    windows: windows.map((window) => ({
      key: branchMetricWindowKey(window),
      ...window,
    })),
  });
}
