import type { UploadQueueCounts } from "@repo/app/shared/components/upload-queue-view";
import type { CloudSyncProgress } from "../../hooks/use-cloud-sync-progress";

/**
 * The session work still owed across both queues, or `null` when the lane has
 * not measured it.
 *
 * Three unmeasured cases, deliberately not folded into `0`: no snapshot yet (or
 * an older main process that never sends the field), a device the lane has not
 * identified, and a sample carrying a value that cannot be a count. The last one
 * discards the WHOLE sample rather than just the bad field — one corrupt queue
 * makes the total unknowable, and a half-trusted total is a fabricated one.
 *
 * Shared by the Sessions sync banner (which renders the count) and the cloud
 * refresh bridge (which reads it as a movement signal), so the two cannot
 * disagree about what counts as a measured sample.
 */
export function pendingSessions(
  progress: CloudSyncProgress | null
): number | null {
  if (progress === null || !progress.identified) {
    return null;
  }
  const backfill = countOrNull(progress.pendingBackfillSessions);
  const incremental = countOrNull(progress.pendingIncrementalSessions);
  if (backfill === null || incremental === null) {
    return null;
  }
  return backfill + incremental;
}

/** A value we are willing to treat as a count, or `null` when it cannot be one. */
export function countOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * ISS-7099: sessions the lane has DELIVERED under this identity, counted at the
 * verified ack, or `null` when it cannot report them.
 */
export function deliveredSessions(
  progress: CloudSyncProgress | null
): number | null {
  if (progress === null || !progress.identified) {
    return null;
  }
  return optionalCountOrNull(progress.deliveredSessions);
}

/**
 * ISS-7099: the total {@link deliveredSessions} is measured against, as the LANE
 * reports it — not accumulated here.
 *
 * The denominator has to outlive this component and reset with the source
 * identity, and only the lane can do both. Held in component state it restarted
 * at zero on every mount, so a card remounted after 30 of 40 delivered with the
 * rest deferred divided 30 by a backlog that mount had never seen and rendered a
 * full bar under a still-syncing title.
 */
export function inFlightTotalSessions(
  progress: CloudSyncProgress | null
): number | null {
  if (progress === null || !progress.identified) {
    return null;
  }
  return optionalCountOrNull(progress.inFlightTotalSessions);
}

/**
 * ISS-7099: the `x / y` pair a progress surface may print, or `null` when no
 * honest pair exists yet.
 *
 * Only the lane's own numbers — delivered over delivered-plus-sendable —
 * because both halves are measurements. There used to be a DERIVED fallback,
 * departures from the owed queue over departures plus what is still owed, for a
 * main process that reported neither half; it over-credited, since a withhold
 * or a dead letter lowers the owed count with nothing uploaded. Its last
 * surface was the deleted sync banner, and the startup readiness bar refuses it
 * (ISS-11668 ruling 10), so it was removed with the two populations that named
 * its output (ISS-10658, review). With one derivation left the pair no longer
 * carries a `source`.
 *
 * A zero total is not a printable pair. It is the all-blocked case (nothing
 * delivered, nothing eligible) and the honest render is no counter and no bar,
 * not a full one.
 */
export function resolveSyncCounter(input: {
  delivered: number | null;
  total: number | null;
}): SyncCounter | null {
  // Deliberately NOT `delivered + ready`: `ready` shrinks when work is
  // DEFERRED, and a denominator that shrinks on a deferral advances the bar for
  // work that did not upload and fills it once the whole remainder is parked.
  if (input.delivered === null || input.total === null || input.total <= 0) {
    return null;
  }
  return { completed: input.delivered, total: input.total };
}

/** What the lane has delivered, over the total it measures that against. */
export type SyncCounter = {
  completed: number;
  total: number;
};

function optionalCountOrNull(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return countOrNull(value);
}

/**
 * ISS-12529: the session lane's upload queue as the upload queue view counts
 * it, or `null` when the lane has not measured it.
 *
 * Three disjoint counts out of the one snapshot every sync surface already
 * polls (AC-003), so they sum to the work the lane knows about:
 *
 *  - in flight: the sessions in the batch the lane has on the wire right now
 *    (`sendingSessions`). NOT the ready counts: ready is every queued session
 *    with no future retry deadline, never-attempted ones included, and the
 *    drain sends one capped batch of them at a time, so a first-connect
 *    backfill would read as thousands in flight (marisolashgrove, whitlockk review).
 *  - queued: the rest of the pending sessions, ready or waiting behind a retry
 *    deadline, an auth gate or a transport outage.
 *  - failed: the sessions the lane dead-lettered.
 *
 * Sessions only. Component-inventory dead-letters are a different unit and
 * stay with the History Sync cell.
 *
 * `null` follows {@link pendingSessions}: one unmeasured or corrupt count makes
 * the split unknowable, and a sending count above the pending one cannot be a
 * subset of it. Main also reports `sendingSessions` as `null` until the
 * initial history walk has enumerated this identity's sessions, so the empty
 * queues before that walk read as unmeasured, never as an empty upload queue.
 */
export function uploadQueueCounts(
  progress: CloudSyncProgress | null
): UploadQueueCounts | null {
  const pending = pendingSessions(progress);
  if (progress === null || pending === null) {
    return null;
  }
  const inFlight = optionalCountOrNull(progress.sendingSessions);
  const failed = countOrNull(progress.deadLetteredSessions);
  if (inFlight === null || failed === null || inFlight > pending) {
    return null;
  }
  return { queued: pending - inFlight, inFlight, failed };
}
