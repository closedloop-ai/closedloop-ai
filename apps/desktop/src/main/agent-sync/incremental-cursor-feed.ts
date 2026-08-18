/**
 * @file incremental-cursor-feed.ts
 * @description ISS-4807: the incremental cursor/queue POLICY for the desktop
 * session sync lane — which rows returned by a keyset cursor scan actually earn a
 * slot on the incremental queue, and how the tied-top watermark advances over
 * them. Extracted out of the grandfathered `agent-session-sync-service.ts` (over
 * the 1,000-line ceiling) into a cohesive, directly unit-testable sibling —
 * mirroring the `backfill-queue-feed` / `injectIdsIntoLiveQueue` extractions
 * — so the service keeps only a thin delegate that hands its own fields through.
 *
 * WATERMARK ADVANCE. `nextTopUpdatedAt` tracks the highest `updated_at` seen in
 * this scan and `nextTopIds` the ids sharing exactly that timestamp; a strictly
 * greater timestamp RESETS the tied set. Callers persist the pair so a restart
 * resumes from the same keyset position and same-timestamp siblings are still
 * excluded rather than re-walked.
 *
 * ADMISSION. A row is queued only when it is genuinely new work for this lane:
 * - a row at the previous top timestamp that was already observed is skipped (the
 *   belt-and-suspenders JS filter behind the query's `id NOT IN (...)` term, which
 *   an over-cap persisted cursor drops — see `MAX_OBSERVED_TOP_IDS`);
 * - a row already on the incremental queue is skipped (plain dedup);
 * - ISS-4712: a row already tracked in the BACKFILL lane is skipped. During a
 *   DATA_REVISION rebuild every re-derived session's `updated_at` is bumped, so it
 *   re-enters this cursor scan. Enqueuing those rebuild-churned ids into the
 *   high-priority incremental lane keeps that lane perpetually non-empty and
 *   starves the historical backfill drain (the incremental-first gate only
 *   advances backfill when the incremental batch is empty). Backfill will sync the
 *   session anyway — with fresher data — so the id stays in `backfillQueuedIds`
 *   and is simply not also enqueued here.
 *
 * The fold is otherwise pure: it mutates only the queue/dedup fields it is handed
 * and returns the advance for the caller to apply, so no durable write, telemetry,
 * or scheduling decision is made here.
 */

import type { SessionCursorRow } from "./agent-session-read-model.js";

/**
 * The mutable in-memory incremental-lane state the feed appends to. Matches the
 * private `incrementalQueue` array and the dedup-tracking sets on the sync
 * service, so the service passes its own fields straight through.
 */
export type IncrementalQueueFeedState = {
  /** The live incremental queue drained by the sync tick. Newly-admitted ids are appended. */
  incrementalQueue: string[];
  /** Ids already on the incremental queue (dedup guard). */
  incrementalQueuedIds: Set<string>;
  /** Ids already tracked by the backfill lane (ISS-4712 starvation guard). */
  backfillQueuedIds: Set<string>;
};

/**
 * The cursor advance produced by one incremental scan. `newlyQueued` is exactly
 * the ids appended to the queue this pass (the set the caller durably records in
 * the outbox); `nextTopUpdatedAt` / `nextTopIds` are the advanced tied-top
 * watermark the caller adopts.
 */
export type IncrementalCursorAdvance = {
  newlyQueued: string[];
  nextTopUpdatedAt: string;
  nextTopIds: Set<string>;
};

/**
 * Fold one page of keyset cursor rows into the incremental queue, returning the
 * advanced tied-top watermark. Rows are expected in the cursor's own order;
 * `previousTopUpdatedAt` / `previousTopIds` are the watermark the scan was issued
 * against.
 */
export function feedIncrementalCursorRows(
  state: IncrementalQueueFeedState,
  rows: readonly SessionCursorRow[],
  previousTopUpdatedAt: string,
  previousTopIds: ReadonlySet<string>
): IncrementalCursorAdvance {
  let nextTopUpdatedAt = previousTopUpdatedAt;
  let nextTopIds = new Set(previousTopIds);
  const newlyQueued: string[] = [];

  for (const row of rows) {
    if (row.updated_at > nextTopUpdatedAt) {
      nextTopUpdatedAt = row.updated_at;
      nextTopIds = new Set<string>();
    }
    if (row.updated_at === nextTopUpdatedAt) {
      nextTopIds.add(row.id);
    }
    if (
      !admitsIncrementalRow(state, row, previousTopUpdatedAt, previousTopIds)
    ) {
      continue;
    }
    state.incrementalQueuedIds.add(row.id);
    state.incrementalQueue.push(row.id);
    newlyQueued.push(row.id);
  }

  return { newlyQueued, nextTopUpdatedAt, nextTopIds };
}

/**
 * Whether one scanned row is genuinely new work for the incremental lane. See the
 * ADMISSION notes in the file header for why each skip exists.
 */
function admitsIncrementalRow(
  state: IncrementalQueueFeedState,
  row: SessionCursorRow,
  previousTopUpdatedAt: string,
  previousTopIds: ReadonlySet<string>
): boolean {
  if (row.updated_at === previousTopUpdatedAt && previousTopIds.has(row.id)) {
    return false;
  }
  if (state.incrementalQueuedIds.has(row.id)) {
    return false;
  }
  return !state.backfillQueuedIds.has(row.id);
}
