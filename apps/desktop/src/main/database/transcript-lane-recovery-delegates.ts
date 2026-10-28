/**
 * @file transcript-lane-recovery-delegates.ts
 * @description ISS-9884 (PLN-1986 §4 and §5): the transcript archive lane's
 * durable LANE-RECOVERY operations, as one delegate slice of
 * `TranscriptSyncStore` — the lane's give-up stamp (read and write) and the
 * revival of the rows that give-up paused.
 *
 * A slice beside the store rather than more methods inside it, for the reason
 * `sync-cursor-state-delegates.ts` gives for its own: `transcript-sync-store.ts`
 * is past 1,100 lines, and what the lane does to RECOVER is a different
 * responsibility from the per-file protocol ledger it keeps. Every method takes
 * and returns clone-safe values, so each is reachable as
 * `agentDatabase.transcriptSync.<name>` across the db-host boundary exactly like
 * the store's own methods.
 */

import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { TranscriptSyncStatus } from "../../shared/transcript-sync-status-contract.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { syncStateContractStamps } from "./sync-cursor-state.js";
import { sqliteRecordLaneGiveUp } from "./sync-lane-run-state.js";
import {
  scopeKeepingRevivedRowData,
  TRANSCRIPT_ROW_SELECT,
} from "./transcript-sync-settle.js";

export type TranscriptLaneRecoveryStore = {
  /**
   * The lane's raw `sync_state.lane_gave_up_at` for `sourceKey`, or `null` when
   * there is no row or it has not given up. Parsing is `readLaneGiveUpStamp`'s,
   * the one reader every adopting lane shares.
   */
  loadLaneGiveUp(sourceKey: string): Promise<string | null>;
  /**
   * Stamp (`gaveUpAt`) or clear (`null`) the lane's give-up, through the same
   * single-column upsert the session and component lanes write. The first
   * give-up mints the transcript lane's first `sync_state` row, which carries no
   * cursor and invents none.
   */
  recordLaneGiveUp(sourceKey: string, gaveUpAt: string | null): Promise<void>;
  /**
   * Return every row dead-lettered on `environment_unavailable` under
   * `computeTargetId` to `queued`, through the revived reset that keeps the
   * row's upload scope (`scopeKeepingRevivedRowData`): counters, backoff, last
   * error, stall run and the reason itself all cleared, and
   * `terminalSkipComputeTargetId` KEPT. Until the row is caught up or
   * re-terminates, that column is the one target it is owed to, which
   * `listReady` and `markUploading` enforce ({@link uploadScopeWhere}): a stale
   * drain pass or a mid-attempt target switch must not upload it elsewhere.
   *
   * That reason and nothing wider. `too_large` and `source_gone` are terminal
   * for the file; `retries_exhausted` is ISS-9002's door, not this one; and a
   * NULL reason is a row that died before migration 0090 recorded why, which is
   * no evidence the environment was the cause. One atomic `updateMany`, so a
   * concurrent drain cannot lost-update it — and a `dead` row is never in flight.
   * Returns the rows revived.
   *
   * That target and nothing wider. The drain uploads a revived row under the
   * target it runs under, and a pause is a statement about the cloud that
   * acknowledged it (`terminalSkipComputeTargetId`), exactly as an `uploaded` ack
   * is (`strandedCloudAckWhere`). Unscoped, a transcript paused while another
   * account or compute target was active would upload to this one's cloud
   * (invariant 2). A row with no recorded target, paused before migration 0093,
   * is revived by no target: nothing says whose it is.
   *
   * A READ probes for such a row first, and the write happens only when one
   * exists. Every recovery door owes this call, and on a healthy install there is
   * nothing to revive: an unconditional write would put an empty,
   * checkpoint-eligible turn on the shared write queue at every launch and every
   * door (the cost ISS-4723 coalesced the drain's settles to avoid). A row that
   * dies between the probe and the write is the next door's.
   */
  reviveEnvironmentUnavailableDeadLetters(
    now: string,
    computeTargetId: string
  ): Promise<number>;
};

export function createTranscriptLaneRecoveryDelegates(
  prisma: Pick<DesktopPrisma, "client" | "write">
): TranscriptLaneRecoveryStore {
  return {
    async loadLaneGiveUp(sourceKey) {
      const row = await prisma.client.syncState.findUnique({
        where: { sourceKey },
        select: { laneGaveUpAt: true },
      });
      return row?.laneGaveUpAt ?? null;
    },
    recordLaneGiveUp(sourceKey, gaveUpAt) {
      // PLN-2028 moved this write to the lane-run module. The transcript lane
      // records no lane-run origin, reason or producer, so it takes the
      // stamp-only alias and the default contract stamps it wrote before.
      return sqliteRecordLaneGiveUp(
        prisma,
        sourceKey,
        gaveUpAt,
        syncStateContractStamps()
      );
    },
    async reviveEnvironmentUnavailableDeadLetters(now, computeTargetId) {
      const where = pausedOnEnvironmentWhere(computeTargetId);
      const paused = await prisma.client.transcriptSyncState.findFirst({
        where,
        select: TRANSCRIPT_ROW_SELECT,
      });
      if (!paused) {
        return 0;
      }
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where,
          data: scopeKeepingRevivedRowData(now),
        })
      );
      return result.count;
    },
  };
}

/**
 * A row the lane give-up paused for `computeTargetId`: acked `dead` because the
 * environment was, by that target's cloud.
 */
function pausedOnEnvironmentWhere(
  computeTargetId: string
): Prisma.TranscriptSyncStateWhereInput {
  return {
    status: TranscriptSyncStatus.Dead,
    terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
    terminalSkipComputeTargetId: computeTargetId,
  };
}

/**
 * ISS-9884: the rows an upload under `computeTargetId` may take — the ready
 * read's half of a revived pause's upload scope. A row with no recorded target
 * is open to every target: a normal queued row, and a pause from before 0093,
 * which no door revives. A row carrying one is open only to that target, and a
 * queued or failed row carries one only as the scope its revival kept. `null`,
 * no live target, is open only to unscoped rows.
 *
 * Filtered in the query rather than after it, so rows owed to another target
 * can never fill a ready batch ahead of this target's own work.
 */
export function uploadScopeWhere(
  computeTargetId: string | null
): Prisma.TranscriptSyncStateWhereInput {
  if (computeTargetId === null) {
    return { terminalSkipComputeTargetId: null };
  }
  return {
    OR: [
      { terminalSkipComputeTargetId: null },
      { terminalSkipComputeTargetId: computeTargetId },
    ],
  };
}

/** The upload claim's half of {@link uploadScopeWhere}, over a row already read. */
export function isOpenToComputeTarget(
  recordedComputeTargetId: string | null,
  computeTargetId: string
): boolean {
  return (
    recordedComputeTargetId === null ||
    recordedComputeTargetId === computeTargetId
  );
}

/** The terminal-skip pair as a row read carries it. */
export type TerminalSkipPair = {
  terminalSkipReason: string | null;
  terminalSkipComputeTargetId: string | null;
};

/** The columns {@link isAttributedEnvironmentPause} reads, beside another select. */
export const TERMINAL_SKIP_PAIR_SELECT = {
  terminalSkipReason: true,
  terminalSkipComputeTargetId: true,
} as const satisfies Record<keyof TerminalSkipPair, true>;

/**
 * ISS-9884: {@link pausedOnEnvironmentWhere} over a row already read, for ANY
 * recorded target: a pause only that target's recovery door may end. The observe
 * planner reads it so a compute-target switch, which rewrites the cursor but is
 * no evidence about the environment, leaves such a row dead with its pair intact
 * rather than re-queuing it unscoped under whichever target observed it.
 */
export function isAttributedEnvironmentPause(
  status: string | undefined,
  pair: TerminalSkipPair | null
): boolean {
  return (
    status === TranscriptSyncStatus.Dead &&
    pair?.terminalSkipReason === TranscriptSkipReason.EnvironmentUnavailable &&
    pair.terminalSkipComputeTargetId != null
  );
}
