import type { CloudReadReadinessSnapshot } from "../../src/shared/cloud-read-readiness-contract.js";
import { projectCloudReadReadiness } from "../../src/shared/cloud-read-readiness-contract.js";
import {
  OldestPendingBasis,
  type SyncBurndownSnapshot,
  type SyncLaneBurndown,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
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
    resumeBlocked: false,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    readyItemsRemaining: null,
    unmeasuredRows: 0,
    bytesRemaining: 0,
    chunksRemaining: null,
    deadLetteredCount: 0,
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    remainderBasis: SyncLaneRemainderBasis.Counted,
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

/**
 * The projection a suite takes when the consent axis is not what it is testing.
 *
 * ISS-6972 removed the consent tier from the readiness payload — the read source
 * asks the consent IPC directly — so this is now a plain pass-through. Kept as
 * the named entry point the ~40 call sites across two files already use.
 */
export function projectConsentedReadiness(
  input: Parameters<typeof projectCloudReadReadiness>[0]
): CloudReadReadinessSnapshot {
  return projectCloudReadReadiness(input);
}
