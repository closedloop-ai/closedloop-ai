/** ISS-12279: Saffi approved a five-minute visible-tab fallback on 2026-10-09. */
export const BRANCH_DETAIL_FRESHNESS_MS = 5 * 60_000;

export const branchDetailQueryPolicy = {
  staleTime: BRANCH_DETAIL_FRESHNESS_MS,
  refetchOnWindowFocus: false,
  refetchIntervalInBackground: false,
} as const;
