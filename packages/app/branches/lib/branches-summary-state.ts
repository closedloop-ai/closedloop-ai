export function resolveBranchesSummaryPending({
  analyticsPending,
  cohortPending,
  listPending,
  hasData,
}: {
  analyticsPending: boolean;
  cohortPending: boolean;
  listPending: boolean;
  hasData: boolean;
}) {
  return (listPending && !hasData) || analyticsPending || cohortPending;
}

/**
 * Whether the summary's figures are ERRORED — either half of the read, since a
 * failure in either stops the cards being refreshed. Named beside its pending
 * sibling so the two cannot drift, and so the host is not the place four
 * booleans get folded by hand (ISS-7424).
 */
export function resolveBranchesSummaryErrored({
  analyticsError,
  cohortErrored,
  listError,
  pageDataAnalyticsError,
}: {
  analyticsError: boolean;
  cohortErrored: boolean;
  listError: boolean;
  pageDataAnalyticsError: boolean;
}) {
  return analyticsError || pageDataAnalyticsError || cohortErrored || listError;
}
