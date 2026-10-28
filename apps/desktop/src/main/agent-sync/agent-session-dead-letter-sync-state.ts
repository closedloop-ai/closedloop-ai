/**
 * @file agent-session-dead-letter-sync-state.ts
 * @description ISS-11427: the ONE classification of a dead-lettered session
 * into the sync state its row reports — `dead_letter` (the lane will retry it)
 * or `abandoned` (no path in the running lane can reach it).
 *
 * Operator ruling (Marisol Ashgrove, 2026-10-05): "the row should know whether
 * we're abandoning a record or it's still in the dead letter. Dead letter means
 * we will retry it; abandoned means it's dead to us forever." Follow-up ruling
 * the same day (option B): keep every retry path; every dead-lettered row is a
 * dead letter, the idle revisit included, and abandoned is only a row no path
 * can reach — today, a lane started with historical backfill disabled.
 *
 * Read off the lane's own set-aside map, because that map IS the retry
 * schedule (`agent-session-sync-dead-letter-lifecycle.ts`):
 *
 * - a FINITE retry-after is recovered by `recoverExpiredDeadLetters` on its own
 *   schedule, whatever the backfill setting;
 * - an INFINITE one is revisited only by `promoteDeadLetterIfIdle`, which runs
 *   only while historical backfill is enabled.
 *
 * Abandoned means the lane will not RETRY the row. New local activity on the
 * session still reaches the incremental feed, which sends the new state; the
 * verified ack that lands it clears the set-aside marker
 * (`clearRowFailureState`), and with it this state.
 *
 * Known limit: the boot redrive (`sqliteSelectRedrivableSessionDeadLetters`)
 * can re-pend a `validation_failed` row whose revision has since healed, at the
 * NEXT launch. The running lane cannot reach that row, which is what this
 * state reports; once a later boot re-pends it, it is no longer dead-lettered.
 */
import {
  AgentSessionCloudSyncState,
  type DeadLetteredCloudSyncState,
} from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import type { DeadLetterLifecycleDeps } from "./agent-session-sync-dead-letter-lifecycle.js";

/** Reads one session's dead-letter sync state; `undefined` when it is not set aside. */
export type ReadSessionDeadLetterState = (
  externalSessionId: string
) => DeadLetteredCloudSyncState | undefined;

export function classifyDeadLetteredSession(
  externalSessionId: string,
  lane: Pick<
    DeadLetterLifecycleDeps,
    "deadLetteredIds" | "isHistoricalBackfillEnabled"
  >
): DeadLetteredCloudSyncState | undefined {
  const retryAfterMs = lane.deadLetteredIds.get(externalSessionId);
  if (retryAfterMs === undefined) {
    return;
  }
  return Number.isFinite(retryAfterMs) || lane.isHistoricalBackfillEnabled()
    ? AgentSessionCloudSyncState.DeadLetter
    : AgentSessionCloudSyncState.Abandoned;
}
