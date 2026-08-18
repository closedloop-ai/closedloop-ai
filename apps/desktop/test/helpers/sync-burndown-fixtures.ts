import {
  OldestPendingBasis,
  type SyncBurndownSnapshot,
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../src/shared/sync-burndown-contract.js";

/**
 * ISS-6206: the burn-down fixtures shared by the readiness-contract suites.
 *
 * Extracted when `cloud-read-readiness-contract.test.ts` crossed the 1,000-line
 * ceiling and its lane-applicability cases moved to their own file — two copies
 * of a nineteen-field lane row is exactly the drift-by-copy this repo tracks.
 */

/** One lane, drained and quiet. Override to make it owe or stop. */
export function burndownLane(
  overrides: Partial<SyncLaneBurndown> = {}
): SyncLaneBurndown {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    readyItemsRemaining: null,
    unmeasuredRows: 0,
    bytesRemaining: 0,
    chunksRemaining: null,
    deadLetteredCount: 0,
    oldestPendingSinceIso: null,
    oldestPendingBasis: OldestPendingBasis.EnqueuedAt,
    oldestPendingAgeMs: null,
    tracksDurableCursor: true,
    durableCursorValue: null,
    durableCursorWrittenAtIso: null,
    durableCursorAgeMs: null,
    workCompletedSincePrevious: 0,
    bytesSentSincePrevious: 0,
    ...overrides,
  };
}

/** A sample carrying `lanes`, stamped at a fixed instant. */
export function burndownSnapshot(
  lanes: readonly SyncLaneBurndown[]
): SyncBurndownSnapshot {
  return { sampledAtIso: "2026-08-07T12:00:00.000Z", lanes };
}
