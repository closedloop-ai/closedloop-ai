/**
 * @file transcript-sync-settle.ts
 * @description ISS-4815 (wongk, #4253): the archive lane's TERMINAL-SETTLE and
 * STRANDED-RECOVERY shapes, split out of `transcript-sync-store.ts` so that
 * hand-written module stays inside the file-size discipline in root AGENTS.md.
 *
 * Two cohesive responsibilities live here, both pure and DB-free (they build
 * Prisma `data`/`where` objects, they never execute):
 *
 *  - the settle contract — {@link TranscriptSettle} and the single
 *    {@link settleUpdateData} builder every per-file store method and the
 *    batched `recordBatchSettled` share, so a batched settle can never drift
 *    from the equivalent single write;
 *  - the recovery predicates — {@link strandedCursorWhere} and
 *    {@link strandedCloudAckWhere}, which decide whether a settled row is
 *    genuinely stranded FOR THE CURRENT COMPUTE TARGET.
 *
 * The store keeps the execution: the factory, the queries, the write turns.
 */

import { TranscriptSyncStatus } from "../../shared/transcript-sync-status-contract.js";
import { redactedArchiveCursorTargetId } from "../transcript-sync/transcript-sync-types.js";
import type { Prisma } from "./generated/client.js";

/** Server-verified state to persist after a successful `complete`. */
export type TranscriptUploadedInput = {
  externalSessionId: string;
  fileKey: string;
  syncedByteOffset: number;
  syncedSha256: string | null;
  storedEtag: string | null;
  syncedComputeTargetId: string | null;
  /** True when the synced window reached the file's current end. */
  caughtUp: boolean;
  now: string;
};

/** Failure bookkeeping for the backoff / dead-letter policy. */
export type TranscriptFailureInput = {
  externalSessionId: string;
  fileKey: string;
  retryCount: number;
  /**
   * FEA-3555: the consecutive missing-source count to persist. A missing-source
   * miss passes the incremented run length; every other (transient upload)
   * failure passes 0, breaking the run so it can't feed the `source_gone`
   * threshold. Always explicit — the caller decides whether this outcome
   * belongs to the missing-source run.
   */
  missingSourceCount: number;
  dead: boolean;
  nextAttemptAt: string | null;
  lastError: string;
  now: string;
};

/**
 * ISS-4723 PR2: a single file's TERMINAL settle mutation, captured as data so a
 * drain batch's settles can be COALESCED into ONE `prisma.write` transaction
 * (see {@link TranscriptSyncStore.recordBatchSettled}) instead of one write per
 * file through the shared db-host write queue. Each variant is exactly one of
 * the terminal transitions the per-file executor emits — `uploaded`
 * (`recordUploaded`), `idle` (`markIdle`), `cloudUploaded`
 * (`markCloudUploaded`), `dead` (`markDead`), `failure`
 * (`recordFailure`) — and carries precisely the fields that transition
 * persists, so a batched settle is byte-for-byte the same write as the
 * equivalent per-file call (the shared `settleUpdateData` builder is the SSOT).
 * This is a write-COALESCING shape, NOT a new terminal semantic. The up-front
 * `markUploading` claim is deliberately NOT a settle: it is the FEA-2827
 * growth-signal guard and stays a separate per-file write BEFORE the batch.
 */
export type TranscriptSettle =
  | ({ kind: "uploaded" } & TranscriptUploadedInput)
  | ({ kind: "failure" } & TranscriptFailureInput)
  | { kind: "idle"; externalSessionId: string; fileKey: string; now: string }
  | {
      kind: "cloudUploaded";
      externalSessionId: string;
      fileKey: string;
      now: string;
      /**
       * The compute target whose cloud gave the `uploaded` acknowledgement. The
       * ack is only a statement about THAT target's archive, so it is persisted
       * and the stranded recovery scopes its exclusion to it. `null` when the
       * target is unknown, which leaves the row eligible for recovery.
       */
      computeTargetId: string | null;
    }
  | {
      kind: "dead";
      externalSessionId: string;
      fileKey: string;
      reason: string;
      now: string;
    };

/**
 * ISS-4815: clear BOTH halves of a cloud acknowledgement. Every settle that
 * supersedes a prior ack spreads this, so the timestamp and the target that gave
 * it can never drift out of sync (a stale target with a null timestamp, or the
 * reverse, would make the stranded-recovery predicate read a row wrong).
 */
export const CLEARED_CLOUD_ACK = {
  cloudUploadedAt: null,
  cloudUploadedComputeTargetId: null,
} as const;

export function revivedRowData(
  now: string
): Prisma.TranscriptSyncStateUpdateManyMutationInput {
  return {
    status: TranscriptSyncStatus.Queued,
    retryCount: 0,
    missingSourceCount: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: now,
    // ISS-4815: a revived row is about to be re-attempted from scratch, so any
    // prior cloud acknowledgement no longer describes what the lane will do.
    ...CLEARED_CLOUD_ACK,
  };
}

/** Compound-key `where` for the single `(externalSessionId, fileKey)` row. */
export function transcriptRowWhere(
  externalSessionId: string,
  fileKey: string
): Prisma.TranscriptSyncStateWhereUniqueInput {
  return { externalSessionId_fileKey: { externalSessionId, fileKey } };
}

/**
 * ISS-4723 PR2: the canonical `data` payload for each TERMINAL settle
 * transition, keyed off the settle kind. This is the SINGLE SOURCE OF TRUTH for
 * what "uploaded / idle / dead / failure" persists, shared by BOTH the per-file
 * store methods (`recordUploaded`/`markIdle`/`markDead`/`recordFailure`) and the
 * batched {@link TranscriptSyncStore.recordBatchSettled}, so a batched settle
 * can never drift from the equivalent single write. Typed as the Prisma update
 * input so a schema rename fails typecheck here. The exhaustive switch means a
 * new `TranscriptSettle` variant fails to compile until it is mapped.
 *
 * ISS-4815: `cloudUploadedAt` is written by EVERY transition, not just the one
 * that sets it — `cloudUploaded` stamps it and every other settle clears it. A
 * settle is the row's new truth, so a stale acknowledgement from an earlier
 * cycle must never survive into a state it no longer describes (which would
 * silently exclude a genuinely stranded row from recovery).
 */
export function settleUpdateData(
  settle: TranscriptSettle
): Prisma.TranscriptSyncStateUpdateInput {
  switch (settle.kind) {
    case "uploaded":
      return {
        status: settle.caughtUp
          ? TranscriptSyncStatus.Idle
          : TranscriptSyncStatus.Queued,
        syncedByteOffset: BigInt(Math.trunc(settle.syncedByteOffset)),
        syncedSha256: settle.syncedSha256,
        storedEtag: settle.storedEtag,
        syncedComputeTargetId: settle.syncedComputeTargetId,
        retryCount: 0,
        // FEA-3555: a successful upload/noop breaks the missing-source run.
        missingSourceCount: 0,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
      };
    case "idle":
      return {
        status: TranscriptSyncStatus.Idle,
        // FEA-3555: idling is a non-missing outcome; break the missing run.
        missingSourceCount: 0,
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
      };
    case "cloudUploaded":
      return {
        // ISS-4815: the queue state is honestly `idle` — nothing is left to
        // upload — and `cloudUploadedAt` records the authoritative cloud
        // acknowledgement that makes it idle, so the stranded-blob recovery
        // leaves it settled instead of re-arming it every launch.
        status: TranscriptSyncStatus.Idle,
        missingSourceCount: 0,
        nextAttemptAt: null,
        // wongk (#4253): this is a SUCCESSFUL settle, so it must retire the
        // failure ladder the same way `uploaded` does. `getStatusSnapshot`
        // forwards `lastError` verbatim, so leaving the retry count and the
        // last attempt's message attached would surface an authoritative
        // "the cloud already holds it" row as idle-with-a-stale-upload-error.
        retryCount: 0,
        lastError: null,
        updatedAt: settle.now,
        cloudUploadedAt: settle.now,
        // Scope the acknowledgement to the target that gave it, so a later
        // switch to a different compute target re-arms the row instead of
        // treating another cloud's archive as proof this one holds the file.
        cloudUploadedComputeTargetId: settle.computeTargetId,
      };
    case "dead":
      return {
        status: TranscriptSyncStatus.Dead,
        nextAttemptAt: null,
        lastError: settle.reason,
        // FEA-3555: terminal row; the missing run is over.
        missingSourceCount: 0,
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
      };
    case "failure":
      return {
        status: settle.dead
          ? TranscriptSyncStatus.Dead
          : TranscriptSyncStatus.Failed,
        retryCount: settle.retryCount,
        missingSourceCount: settle.missingSourceCount,
        nextAttemptAt: settle.nextAttemptAt,
        lastError: settle.lastError,
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
      };
    default: {
      const exhaustive: never = settle;
      return exhaustive;
    }
  }
}

/**
 * ISS-4647: the "the cloud holds no readable bytes for THIS compute target"
 * half of the stranded-blob predicate, shared by
 * `TranscriptSyncStore.requeueStrandedMissingBlobs`.
 *
 * `syncedByteOffset > 0` alone does not prove the current target's cloud row has
 * content: the cursor may describe bytes uploaded under a PREVIOUS compute
 * target, or a pre-FEA-3735 raw-domain cursor. `planObservation` already treats
 * such a cursor as stale (`transcriptCursorMatchesComputeTarget`), so the
 * recovery must too — otherwise a vanished source whose only bytes live on the
 * old target is excluded from the re-arm and idles forever while the current
 * target's cloud row reads `missing`/`syncing`.
 *
 * Offline (`computeTargetId === null`) the cursor's domain is unknowable, so the
 * predicate narrows back to `syncedByteOffset = 0` rather than re-arming healthy
 * rows on a guess. The explicit `null` arm is deliberate: SQL `<>` does not match
 * NULL, so a null cursor must be named rather than left to `not`.
 *
 * `redactedArchiveCursorTargetId` is the same value
 * `transcriptCursorMatchesComputeTarget` compares against, so the SQL scope and
 * the in-memory predicate cannot drift.
 */
export function strandedCursorWhere(
  computeTargetId: string | null
): Prisma.TranscriptSyncStateWhereInput {
  if (computeTargetId === null) {
    return { syncedByteOffset: 0n };
  }
  const currentCursor = redactedArchiveCursorTargetId(computeTargetId);
  return {
    OR: [
      { syncedByteOffset: 0n },
      { syncedComputeTargetId: null },
      { syncedComputeTargetId: { not: currentCursor } },
    ],
  };
}

/**
 * ISS-4815: the stranded-recovery clause that keeps a CLOUD-ACKNOWLEDGED row
 * settled — scoped to the target that gave the acknowledgement.
 *
 * An `uploaded` ack is only ever a statement about the archive held by the
 * compute target that answered. Excluding on `cloudUploadedAt` alone would make
 * one target's ack settle the row forever: after the user switches
 * accounts/compute targets the new target's cloud holds nothing, the local
 * cursor is still 0 (the desktop never uploaded a byte of a missing source), and
 * the row would be excluded from the only path that could re-arm it — so the
 * transcript would never reach the new target. Same per-target reasoning
 * ISS-4647 applied to the byte cursor in {@link strandedCursorWhere}.
 *
 * Eligible (i.e. still recoverable) when the row was never acknowledged, when
 * the ack came from a DIFFERENT target, or when it is unattributable (a null
 * target id) — the last case erring toward re-arming, because failing to reach
 * the cloud is worse than one redundant skip round-trip.
 *
 * When the CURRENT target is null (offline) the comparison is unknowable, so
 * every acknowledged row stays excluded rather than re-armed on a guess — the
 * same stance `strandedCursorWhere` takes for a null target, and a re-arm here
 * could not upload anyway.
 */
export function strandedCloudAckWhere(
  computeTargetId: string | null
): Prisma.TranscriptSyncStateWhereInput {
  if (computeTargetId === null) {
    return { cloudUploadedAt: null };
  }
  return {
    OR: [
      { cloudUploadedAt: null },
      { cloudUploadedComputeTargetId: null },
      { cloudUploadedComputeTargetId: { not: computeTargetId } },
    ],
  };
}

/**
 * `TranscriptSyncState` is keyed on the compound `@@id([externalSessionId,
 * fileKey])` and has no `id` column, so this select IS the whole primary key.
 */
export const TRANSCRIPT_ROW_SELECT = {
  externalSessionId: true,
  fileKey: true,
} as const;
