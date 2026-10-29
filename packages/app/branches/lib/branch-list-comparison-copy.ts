import {
  BranchMetricAvailability,
  type BranchMetricComparison,
  BranchMetricComparisonLabel,
} from "@repo/api/src/types/branch-metrics";

// Copy for the "No comparison" delta-slot chip on the canonical PRD-601 Branches
// list cards (ISS-5714). A lightweight module so the sentences are an importable
// SSOT and a new availability state cannot ship without copy that explains it.

/**
 * The reader's word for a comparison window. `BranchMetricComparisonLabel` is
 * `WoW` / `MoM` / `QoQ` (or `vs prior 60d`), which works as a terse caption beside a number and does
 * not survive being dropped into a sentence — "no MoM data" does not parse, and
 * a screen reader pronounces `MoM` as "mom". Prose spells the period out; the
 * caption keeps the abbreviation.
 */
export const COMPARISON_PERIOD_NOUN: Record<
  BranchMetricComparison["label"],
  string
> = {
  [BranchMetricComparisonLabel.WeekOverWeek]: "week",
  [BranchMetricComparisonLabel.MonthOverMonth]: "month",
  [BranchMetricComparisonLabel.PriorSixtyDays]: "60-day period",
  [BranchMetricComparisonLabel.QuarterOverQuarter]: "quarter",
};

/**
 * Said when the local filtered-metrics fallback is what removed the comparison.
 *
 * `bindCanonicalMetricsToFilteredRows` (`approved-filtered-metrics.ts`)
 * recomputes each card's `current` over the filtered rows and its
 * `replaceCurrent` stamps every `deltaPct` `Unavailable`, because the stored prior window
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
export const FILTERED_REASON =
  "Comparisons aren't available while filters are applied.";

/**
 * WHY a card that HAS a value has no delta beside it, per `deltaPct` state.
 *
 * Exhaustive over every `BranchMetricAvailability` member but `NotApplicable`,
 * so a new one fails `tsc` here rather than silently inheriting someone else's
 * sentence, and each key owes a `string` rather than being allowed to return
 * nothing. Two states are genuinely reachable — see
 * `buildBranchMetricComparison`, the only producer:
 *
 *  - `NotApplicable` — no percentage this product asserts. Since ISS-10540 that
 *    is TWO causes under one state: the prior window is a near-zero base (there
 *    is nothing back there to divide by), or the movement sits at or past the
 *    ±999 ceiling `pctDelta` declines at (ISS-5003) — a prior that DOES have a
 *    value. One sentence cannot name both without lying about one of them, so
 *    it is EXCLUDED from this map's key set and answered by an early return in
 *    {@link describeMissingBranchComparison}, letting `KpiDeltaPlaceholder`
 *    fall to its own cause-agnostic default — the ISS-5003 sentence the
 *    Sessions strip already shows for the same decline. It is NOT "we don't
 *    compare this metric": the card beside it can be showing a live delta for
 *    the same window, which would make that claim visibly false. Excluding the
 *    key rather than widening the map's value type to `| undefined` is what
 *    keeps the obligation on the other four: widened, a state that forgot its
 *    sentence would compile and silently inherit that same default.
 *  - `Unavailable` — one of the two windows produced NO value at all, so there
 *    is nothing to divide. ISS-10540 narrowed this: a `Partial` window produced
 *    a real number over the population it admits, and a percentage off two such
 *    numbers is itself real, so it now renders as a `Partial` delta carrying its
 *    disclosure rather than being withheld. Only an absent operand reaches here.
 *
 * `Complete` and `Partial` cannot reach this map (a numeric delta renders
 * instead) but are answered honestly rather than with a placeholder string, so a
 * future producer change cannot turn them into a lie.
 */
const NO_COMPARISON_REASON: Record<
  Exclude<
    BranchMetricAvailability,
    typeof BranchMetricAvailability.NotApplicable
  >,
  (period: string) => string
> = {
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
 *
 * `undefined` means "let the placeholder say its own cause-agnostic sentence" —
 * see the `NotApplicable` note on {@link NO_COMPARISON_REASON}.
 */
export function describeMissingBranchComparison(input: {
  state: BranchMetricAvailability;
  label: BranchMetricComparison["label"];
  /**
   * Did the local filtered-metrics fallback replace this card's comparison?
   * NOT "is a facet active" — see {@link FILTERED_REASON}.
   */
  comparisonSuppressedByFilter: boolean;
}): string | undefined {
  if (input.comparisonSuppressedByFilter) {
    return FILTERED_REASON;
  }
  if (input.state === BranchMetricAvailability.NotApplicable) {
    return undefined;
  }
  return NO_COMPARISON_REASON[input.state](COMPARISON_PERIOD_NOUN[input.label]);
}
