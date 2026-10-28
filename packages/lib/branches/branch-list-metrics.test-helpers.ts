import { costFactsFromContributions } from "./branch-cost-facts-from-contributions";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import type { AdjacentBranchMetricWindows } from "./branch-metric-windows";
import { branchMetricFactWindows } from "./branch-pull-request-metrics";

/**
 * The kernel with AI spend arriving as producer-folded facts, here folded from
 * the test's own cost contributions, which is the shape every production
 * producer sends (ISS-12346, ISS-12361).
 */
export function calculateMetricsWithSpendFacts(
  input: BranchListMetricInput,
  windows: AdjacentBranchMetricWindows
) {
  return calculateBranchListMetrics(
    {
      ...input,
      aiSpendFacts: costFactsFromContributions(
        input.costContributions,
        branchMetricFactWindows(windows)
      ),
    },
    windows
  );
}
