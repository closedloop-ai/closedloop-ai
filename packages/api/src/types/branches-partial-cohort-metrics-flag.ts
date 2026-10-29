/**
 * ISS-8968: the single cross-surface flag key gating whether the Branches List
 * summary cards accept a PARTIAL cohort answer. Closed, the three event-history
 * metrics keep failing closed to Unavailable whenever the producer's matched set
 * is not the requested one — the shipped behaviour. Open, a strictly smaller
 * matched set republishes the producer's own figures as Partial.
 *
 * Display only: no request, wire shape, or producer computation changes with it.
 *
 * Lives in this lightweight `@repo/api` module so the web PostHog alias and any
 * desktop alias resolve to the same literal instead of parallel strings.
 */
export const BRANCHES_PARTIAL_COHORT_METRICS_FLAG_KEY =
  "branches-partial-cohort-metrics" as const;
