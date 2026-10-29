/**
 * The freshness contract for `computeTargetKeys.list()` — one definition, every
 * surface that renders a compute target's liveness.
 *
 * Hoisted out of `apps/app/lib/engineer/constants.ts` (ISS-8366): the Settings
 * v2 Connected Devices panel lives in `packages/app` and renders the same
 * online/offline badge off the same query key, and a `packages/app` module
 * cannot import from `apps/app`. Left where it was, the panel would have fallen
 * back to the client's 60s default `staleTime` with no poll at all, so one query
 * key would have had two freshness stories and a liveness badge could sit stale
 * on the surface that only ever moved on focus.
 */

export const COMPUTE_TARGETS_POLL_INTERVAL_MS = 30_000;

/**
 * Stop the 30s compute-targets poll once the query is in an error state
 * (FEA-3940). A bricked/unauthenticated API (a 401/403 from this poll) must not
 * be hammered every 30 seconds while the app shows its degraded/re-auth surface;
 * an explicit `invalidateQueries` (e.g. the auth guard's Retry, or a successful
 * re-auth) resumes it. Mirrors the polling-hooks rule in packages/app/AGENTS.md.
 */
function computeTargetsRefetchInterval(query: {
  state: { status: string };
}): number | false {
  return query.state.status === "error"
    ? false
    : COMPUTE_TARGETS_POLL_INTERVAL_MS;
}

export const COMPUTE_TARGETS_QUERY_OPTIONS = {
  staleTime: COMPUTE_TARGETS_POLL_INTERVAL_MS,
  refetchInterval: computeTargetsRefetchInterval,
} as const;
