import {
  BranchMetricAvailability,
  type BranchMetricComparison,
  BranchMetricComparisonLabel,
} from "@repo/api/src/types/branch-metrics";

// Copy for the "No comparison" delta-slot chip on the canonical PRD-601 Branches
// list cards (ISS-5714). A lightweight module, matching `branch-headline-copy.ts`
// for the same chip on branch detail, so the sentences are an importable SSOT and
// a new availability state cannot ship without copy that explains it.

/**
 * The reader's word for a comparison window. `BranchMetricComparisonLabel` is
 * `WoW` / `MoM` / `QoQ`, which works as a terse caption beside a number and does
 * not survive being dropped into a sentence — "no MoM data" does not parse, and
 * a screen reader pronounces `MoM` as "mom". Prose spells the period out; the
 * caption keeps the abbreviation.
 */
const COMPARISON_PERIOD_NOUN: Record<BranchMetricComparison["label"], string> =
  {
    [BranchMetricComparisonLabel.WeekOverWeek]: "week",
    [BranchMetricComparisonLabel.MonthOverMonth]: "month",
    [BranchMetricComparisonLabel.QuarterOverQuarter]: "quarter",
  };

/**
 * Said when the local filtered-metrics fallback is what removed the comparison.
 *
 * `approvedFilteredMetrics` recomputes each card's `current` over the filtered
 * rows and stamps every `deltaPct` `Unavailable`, because the stored prior window
 * was measured over the unfiltered corpus. So when that fallback ran the cause is
 * ALWAYS the filter, never the period — and blaming the period there is the
 * FEA-4241 failure mode (a reason that makes the user's own data look like the
 * problem). The no-value cards in the same row already say "Not available with
 * filters applied", so this keeps one story per cause across the row.
 *
 * ISS-5714 (review thread): it is emphatically NOT said merely because a facet is
 * active. When the exact-cohort producer answers, its metrics ARE the filtered
 * cohort's, so a gap in them is a data-availability gap that the filter did not
 * cause — and captioning it this way would blame the user's own facet for our
 * missing window. See `ApprovedBranchCohortAnalytics.comparisonSuppressedByFilter`,
 * which is the only thing allowed to turn this sentence on.
 */
const FILTERED_REASON =
  "Comparisons aren't available while filters are applied.";

/**
 * WHY a card that HAS a value has no delta beside it, per `deltaPct` state.
 *
 * Exhaustive over `BranchMetricAvailability` so a new member fails `tsc` here
 * rather than silently inheriting someone else's sentence. Two states are
 * genuinely reachable — see `buildBranchMetricComparison`, the only producer:
 *
 *  - `NotApplicable` — the prior window is not a complete, nonzero base. That is
 *    "there is nothing back there to divide by", NOT "we don't compare this
 *    metric": the card beside it can be showing a live delta for the same
 *    window, which would make that claim visibly false.
 *  - `Unavailable` — this period's or the prior period's value is itself partial
 *    or missing, so a percentage off it would be a number we cannot stand behind.
 *
 * `Complete` and `Partial` cannot reach this map (a numeric delta renders
 * instead) but are answered honestly rather than with a placeholder string, so a
 * future producer change cannot turn them into a lie.
 */
const NO_COMPARISON_REASON: Record<
  BranchMetricAvailability,
  (period: string) => string
> = {
  [BranchMetricAvailability.NotApplicable]: (period) =>
    `The previous ${period} has no value to compare against.`,
  [BranchMetricAvailability.Unavailable]: (period) =>
    `This ${period} or the one before it is missing data, so the change isn't calculated.`,
  [BranchMetricAvailability.NoData]: (period) =>
    `The previous ${period} has no value to compare against.`,
  [BranchMetricAvailability.Complete]: (period) =>
    `The change from the previous ${period} isn't shown here.`,
  [BranchMetricAvailability.Partial]: (period) =>
    `The change from the previous ${period} isn't shown here.`,
};

/**
 * The tooltip + screen-reader sentence for a Branches list card that rendered a
 * value but cannot render a delta.
 *
 * Never restates the conclusion: the chip beside it already reads "No
 * comparison", and a screen reader reaches that label immediately before this
 * sentence.
 */
export function describeMissingBranchComparison(input: {
  state: BranchMetricAvailability;
  label: BranchMetricComparison["label"];
  /**
   * Did the local filtered-metrics fallback replace this card's comparison?
   * NOT "is a facet active" — see {@link FILTERED_REASON}.
   */
  comparisonSuppressedByFilter: boolean;
}): string {
  if (input.comparisonSuppressedByFilter) {
    return FILTERED_REASON;
  }
  return NO_COMPARISON_REASON[input.state](COMPARISON_PERIOD_NOUN[input.label]);
}
