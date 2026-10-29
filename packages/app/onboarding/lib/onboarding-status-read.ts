import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import type { UseQueryResult } from "@tanstack/react-query";

/**
 * Whether the onboarding status read has failed with no answer to show
 * (ISS-7828), including while Retry's own read of that failure is in flight.
 *
 * A refetch of a query that holds no data resets it to pending and clears
 * `isError`, so `isError` alone would drop the recovery card for the length of
 * the retry; `errorUpdateCount` is the failure already on record. Read it only
 * once no settled status exists — a settled answer outranks a failed refetch.
 */
export function isOnboardingStatusReadFailing(
  query: Pick<
    UseQueryResult<OnboardingStatus>,
    "errorUpdateCount" | "isError" | "isFetching"
  >
): boolean {
  return query.isError || (query.isFetching && query.errorUpdateCount > 0);
}
