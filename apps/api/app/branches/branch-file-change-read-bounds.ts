/**
 * The Branch file-change completeness bound, and the persistence cap it
 * constrains.
 *
 * `refreshBranchFileChangeCache` stores one compare's worth of rows, truncating
 * at the persistence cap this module bounds. The bound exists so a stored count
 * can never sit AT it, because a full write is indistinguishable from one the
 * write path cut short — a reader comparing `fileCacheFileCount` against the
 * bound would then have to reject every large branch permanently.
 *
 * ISS-8480 binds the two numbers together here so they cannot drift apart
 * silently. ISS-10298 removed the `take`-bounded reads that used to be one half:
 * the list, detail, and analytics selects no longer load per-file rows at all —
 * `getBranchFileChangeTotals` folds them in SQL. ISS-10009 part 2 removed the
 * other: publication LOC now comes from captured push atoms, so
 * `hasCompleteCloudLocCache` and its at-bound `<` guard are gone and NO reader
 * measures a cache against `branchAnalytics` today. The bound survives as the
 * ceiling on persistence, and `currentFileTotals` — the display path — gates on
 * the provider's own `capped` flag rather than on any count.
 *
 * Every consumer that must move when the provider cap changes:
 *
 * - `file-cache-service.ts` — `refreshBranchFileChangeCache`, which resolves the
 *   persistence cap this module bounds and hands it to `prepareFileChanges`.
 * - `branch-file-change-read-bounds.test.ts` — restates the bound as a literal
 *   `500` on purpose (an independent pin, not a copy).
 *
 * `branch-contribution-sql.ts` reads the same rows deliberately UNBOUNDED (a
 * SQL `SUM` over every row), so it is not bound by this module and does not move
 * with the cap.
 */

/**
 * The bound the persistence cap is held under, keyed by whoever asked for it.
 * Keyed rather than a bare literal so a new consumer has to name itself here,
 * and so {@link narrowestReadBound} tightens automatically if one is stricter
 * than the others.
 *
 * `branchAnalytics` is the last key standing and no longer names a READER:
 * ISS-10009 part 2 deleted `hasCompleteCloudLocCache`, the only consumer that
 * measured a cached branch against it (see the module header). The entry stays
 * because the number is still the ceiling `refreshBranchFileChangeCache` writes
 * under, and the name still says which consumer set it.
 */
export const BRANCH_FILE_CHANGE_READ_BOUNDS = {
  branchAnalytics: 500,
} as const;

/**
 * The strictest bound in the set. Exported as a function so the min-vs-max
 * direction stays pinnable with unequal bounds: a cap checked against the WIDEST
 * bound would pass while a stricter entry silently rejected every cache that
 * filled it.
 */
export function narrowestReadBound(
  bounds: Readonly<Record<string, number>>
): number {
  const rowCounts = Object.values(bounds);
  if (rowCounts.length === 0) {
    throw new Error(
      "Branch file-change bounds cannot be empty; a cap with no consumer to bound it is not bounded at all."
    );
  }
  return Math.min(...rowCounts);
}

/** What persistence may not exceed. */
export const NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND = narrowestReadBound(
  BRANCH_FILE_CHANGE_READ_BOUNDS
);

/**
 * Bound the compare-file persistence cap to what every completeness consumer
 * can still admit.
 *
 * Refuses rather than clamps, deliberately. `currentFileTotals` (`branch-loc.ts`)
 * gates only on cache currency and the provider's `capped` flag — it never
 * compares `fileCacheFileCount` against the bound — so it reports whatever the
 * write path stored. Clamping the cap would make a write-time shortfall
 * permanent and silent on the two surfaces it feeds, the branch list/detail LOC
 * display and `analyticsPullRequestSize`'s median: a genuinely complete branch
 * would report a confident total over its first
 * `NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND` files with nothing marking it short.
 * Since ISS-10009 part 2 no reader compares a count against the bound at all, so
 * a clamp would fool every consumer that remains. Refusing removes the
 * configuration instead of the evidence, and cannot ship: the cap's only
 * argument is a compile-time constant, so a mismatch fails every suite that
 * exercises a cache refresh rather than reaching a user. Called per refresh, not
 * at module scope — `webhooks/github/route.ts` statically imports this path for
 * every event type it serves, and a cap mismatch must not refuse an unrelated
 * `check_run` payload — and, within a refresh, called BEFORE `startBranchSync`.
 * Nothing here settles a branch, so a throw once the Syncing token is held
 * strands the branch in flight for the whole `BRANCH_VIEW_IN_FLIGHT_STALE_MS`
 * lease; refusing first leaves no token to release and no cache status to lie
 * about.
 */
export function branchFileChangePersistenceCap(
  providerFileLimit: number
): number {
  if (!Number.isSafeInteger(providerFileLimit) || providerFileLimit < 1) {
    throw new Error(
      `Branch file-change persistence cap must be a positive safe integer; received ${providerFileLimit}.`
    );
  }
  if (providerFileLimit > NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND) {
    throw new Error(
      `Branch file-change persistence cap ${providerFileLimit} exceeds the strictest completeness bound (${NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND} rows). Raise every bound in BRANCH_FILE_CHANGE_READ_BOUNDS before raising the cap, or a complete cache will read as truncated.`
    );
  }
  return providerFileLimit;
}
