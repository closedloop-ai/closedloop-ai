/**
 * The one loading question every list summary metric strip answers (ISS-9887).
 *
 * Two surfaces render a strip of KPI cards above a list — Sessions and Branches
 * — and both read through TanStack `keepPreviousData`, so both can be holding a
 * settled payload that describes a scope the reader has already left. Sessions
 * folded that into its loading decision (`isPending || isPlaceholderData`,
 * FEA-4177) and Branches never did, so the same moment rendered a skeleton on
 * one screen and the PREVIOUS window's KPI values, stated as current, on the
 * other.
 *
 * The fold lives here rather than being spelled out per host because that is the
 * half that drifted: both rows already compose `SummaryCardRow` + `MetricCard`,
 * and it was the DECISION each host reached on its own that disagreed.
 *
 * What this deliberately does NOT fold in is a plain background refetch
 * (`isFetching` over data for the SAME scope). That value is not stale — it
 * describes exactly the scope the reader is looking at — and skeletoning it
 * would grey-flash five cards on every window-focus refetch, which is the
 * regression `getMetricDataRefreshingState` exists to prevent on desktop
 * Sessions. The lie is specifically a payload from a DIFFERENT scope presented
 * as current, and `isPlaceholderData` is exactly that signal.
 *
 * A FAILED read is not this question. Error precedence stays with each row, and
 * on both rows an error outranks the skeleton — hiding a failed read behind a
 * shimmer removes the reader's only signal that something broke.
 */
export function isSummaryMetricsLoading({
  isPending,
  isServingPreviousScope,
}: {
  /** No payload for this scope has arrived yet. */
  isPending: boolean;
  /**
   * The payload in hand belongs to the PREVIOUS scope — TanStack's
   * `isPlaceholderData` under `keepPreviousData`.
   */
  isServingPreviousScope: boolean;
}): boolean {
  return isPending || isServingPreviousScope;
}
