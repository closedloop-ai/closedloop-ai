import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";

/** Surface-independent expectations for one exact, fully persisted cohort. */
export const exactCohortMetricParityExpectation = {
  cohortSize: 1,
  medianPrSize: {
    state: BranchMetricAvailability.Complete,
    value: 12,
  },
  aiSpendUsd: {
    state: BranchMetricAvailability.Complete,
    value: 10,
  },
  mergeRatePct: {
    state: BranchMetricAvailability.Complete,
    value: 100,
  },
  activeComparisonState: BranchMetricAvailability.Unavailable,
  locPerDollarState: BranchMetricAvailability.Unavailable,
} as const;
