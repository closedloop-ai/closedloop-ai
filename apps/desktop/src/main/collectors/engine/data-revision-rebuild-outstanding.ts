/**
 * @file data-revision-rebuild-outstanding.ts
 * @description ISS-6241 (shafty023 review): the work the DATA_REVISION rebuild
 * has taken OUT of `pendingByHarness` but is not finished with.
 *
 * WHY IT EXISTS. `processed` is derived as `total - remaining`, and `remaining`
 * was read from the pending sets alone. Every path that removes an id from
 * `pending` therefore credited that session as PROCESSED — including the paths
 * that deliberately leave it stale for a later pass. The pass could publish
 * `N of N` with retry work still outstanding, which is the same false
 * completeness the ticket exists to remove, just relocated from the bar to the
 * bookkeeping behind it.
 *
 * The rule: an id leaves `pending` for exactly one of two destinations. Either
 * it reached a REAL terminal outcome (rebuilt, deleted, race-skipped, or
 * repaired and stamped), or it is still owed work and belongs to one of the sets
 * below until it reaches one.
 */

/** Ids that have left `pendingByHarness` while still owing the pass work. */
export type RebuildOutstanding = {
  /**
   * Ids whose re-parse threw a parser-output error. Worked by the repair tail,
   * so they are outstanding until that tail stamps them.
   */
  parserOutputFallbackIds: Set<string>;
  /**
   * Ids with no surviving source. Also worked by the repair tail, via the
   * missing-source rollup recompute.
   */
  repairPendingIds: Set<string>;
  /**
   * Ids this pass has given up on but NOT resolved: a mapped `Retry` parse, an
   * empty or unmatched parse, an unmapped source that may still own them, and
   * any session the repair tail withheld a stamp from.
   *
   * These stay stale on disk and are re-selected by a later pass, so they are
   * never drained here — not even when the repair tail completes. A pass that
   * ends with these outstanding ends honestly SHORT of its total, because it
   * did not finish the population it selected.
   */
  retryableIds: Set<string>;
};

export function createRebuildOutstanding(): RebuildOutstanding {
  return {
    parserOutputFallbackIds: new Set<string>(),
    repairPendingIds: new Set<string>(),
    retryableIds: new Set<string>(),
  };
}

/**
 * How many ids are still owed work, for the progress reporter's `remaining`.
 *
 * `repairTailComplete` retires only the two cohorts that tail actually works.
 * `retryableIds` is deliberately outside that gate: those sessions were never
 * worked to a terminal outcome by anyone, so nothing in this pass can retire
 * them.
 */
export function outstandingRemaining(
  outstanding: RebuildOutstanding,
  repairTailComplete: boolean
): number {
  const repairCohort = repairTailComplete
    ? 0
    : outstanding.repairPendingIds.size +
      outstanding.parserOutputFallbackIds.size;
  return repairCohort + outstanding.retryableIds.size;
}

/**
 * Mark an id as still-retryable.
 *
 * Idempotent, and deliberately tolerant of an id that is also in a repair
 * cohort: the reporter clamps a double-count to "no progress yet" rather than
 * to a negative numerator, and a session the repair tail withheld a stamp from
 * is legitimately in both.
 */
export function markRetryable(
  outstanding: RebuildOutstanding,
  sessionId: string
): void {
  outstanding.retryableIds.add(sessionId);
}
