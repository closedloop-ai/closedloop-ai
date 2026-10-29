import type {
  OldestPendingBasis,
  SyncLaneDeadLetteredBasis,
  SyncLaneId,
  SyncLaneRemainderBasis,
} from "../../shared/sync-burndown-contract.js";

export type LaneActivity = {
  /** Units the lane was observed completing since the last sample. */
  workCompleted: number;
  /** Bytes the lane put on the wire since the last sample, or null when uncounted. */
  bytesSent: number | null;
  /** Queue rows the lane durably removed, or null when unmeasured. */
  queueRowsCleared?: number | null;
};

/** Complete measured inputs required to classify and report one sync lane. */
export type SyncBurndownLaneInput = {
  lane: SyncLaneId;
  running: boolean;
  itemsRemaining: number | null;
  itemsRemainingIsLowerBound?: boolean;
  readyItemsRemaining?: number | null;
  unmeasuredRows?: number;
  bytesRemaining: number | null;
  chunksRemaining: number | null;
  deadLetteredCount: number;
  deadLetteredBasis: SyncLaneDeadLetteredBasis;
  /** Whether the store actually queried this lane's queue in this sample. */
  remainderBasis: SyncLaneRemainderBasis;
  /** Whether the lane's once-per-identity resume read is failing. */
  resumeBlocked: boolean;
  oldestPendingSinceIso: string | null;
  oldestPendingBasis: OldestPendingBasis;
  tracksDurableCursor: boolean;
  cursorValue: string | null;
  cursorWrittenAtIso: string | null;
  cursorBoundaryValue?: string | null;
  activity: LaneActivity;
  nowMs: number;
  parkedCount?: number | null;
  withheldCount?: number | null;
};
