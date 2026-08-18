/**
 * @file data-revision-rebuild-summary-merge.ts
 * @description ISS-5808 — reconcile the summaries of a DATA_REVISION rebuild
 * that was RE-DRIVEN after the db-host child died under it.
 *
 * A re-drive is not one pass; it is several partial passes over a shrinking
 * population. `rebuildSessionFromParse` can commit a session and have the child
 * exit before its response comes back, so the write lands, the stamp advances,
 * and the attempt still rejects. The next attempt then correctly EXCLUDES that
 * row — its `data_revision` is current — which means the committed work appears
 * in no single attempt's summary and, when it was the last stale row, the final
 * summary is empty. Post-boot maintenance reads that summary to decide two
 * things, so an empty one silently skips both: the explicit sync-outbox enqueue
 * of the changed sessions (FEA-3659) and `invalidateHistoricalDetails()`, which
 * is what stops the dashboard serving pre-rebuild numbers.
 *
 * Hence this merge. It lives in its own module rather than in
 * `data-revision-rebuild.ts` because that file is already ~950 lines and the
 * repo's ceiling is 1,000.
 *
 * ## Which fields accumulate, and which do not
 *
 * COMMITTED-WORK counters (`rebuilt`, `deleted`,
 * `missingSourceRollupsRecomputed`, `changedSessionIds`) accumulate across
 * attempts. They are disjoint by construction: the rebuild is cursored on the
 * `data_revision` stamp, so a row counted by one attempt is not re-selected by
 * the next. `changedSessionIds` is de-duplicated anyway, because the ONE case
 * that could repeat an id is a write that committed without stamping.
 *
 * OBSERVATION counters (`staleTotal`, `skippedActive`, `raceSkipped`,
 * `missingSource`, `unmatchedSource`, `parseErrors`, `errors`) describe a
 * population the next attempt re-observes, so summing them would double-count.
 * They are taken from the LAST attempt — the final view of what is still stale —
 * and are diagnostic only: every attempt already logged its own line through
 * `logRebuildSummary`, and no consumer branches on these merged values.
 */
import {
  createEmptyDataRevisionRebuildSummary,
  type DataRevisionRebuildSummary,
} from "./data-revision-rebuild.js";

/**
 * Fold every attempt of one re-driven rebuild into a single summary.
 *
 * An empty list yields a zero summary, which is the correct reading of "the pass
 * never got far enough to report anything" — it commits the caller to no
 * invalidation and no enqueue, exactly as a genuinely empty pass would.
 */
export function mergeDataRevisionRebuildSummaries(
  attempts: readonly DataRevisionRebuildSummary[]
): DataRevisionRebuildSummary {
  const merged = createEmptyDataRevisionRebuildSummary();
  const changedSessionIds = new Set<string>();
  for (const attempt of attempts) {
    merged.rebuilt += attempt.rebuilt;
    merged.deleted += attempt.deleted;
    merged.missingSourceRollupsRecomputed +=
      attempt.missingSourceRollupsRecomputed;
    merged.storageReset = merged.storageReset || attempt.storageReset;
    for (const id of attempt.changedSessionIds) {
      changedSessionIds.add(id);
    }
    applyLatestObservationCounters(merged, attempt);
  }
  merged.changedSessionIds = [...changedSessionIds];
  return merged;
}

/** Overwrite the diagnostic counters with this attempt's view (see header). */
function applyLatestObservationCounters(
  merged: DataRevisionRebuildSummary,
  attempt: DataRevisionRebuildSummary
): void {
  merged.staleTotal = attempt.staleTotal;
  merged.skippedActive = attempt.skippedActive;
  merged.raceSkipped = attempt.raceSkipped;
  merged.missingSource = attempt.missingSource;
  merged.unmatchedSource = attempt.unmatchedSource;
  merged.parseErrors = attempt.parseErrors;
  merged.errors = attempt.errors;
}
