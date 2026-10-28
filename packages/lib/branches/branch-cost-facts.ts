/** What one window's cost events came to, over the cohort's even-split shares. */
export type BranchMetricCostWindowFacts = {
  spendUsd: number;
  /** Events with a usable cost that were summed into `spendUsd`. */
  included: number;
  /** Events in the window whose cost is unknown or unreadable (ISS-12346 C6). */
  unusable: number;
};

/**
 * AI spend folded by the producer in place of cost contributions (ISS-12346).
 * `cohortHoldsEvents` is window-independent, so an empty range can be told from
 * a cohort with no cost telemetry at all.
 */
export type BranchMetricCostFacts = {
  cohortHoldsEvents: boolean;
  windows: ReadonlyMap<string, BranchMetricCostWindowFacts>;
};
