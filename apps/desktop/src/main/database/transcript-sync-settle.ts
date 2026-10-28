/**
 * @file transcript-sync-settle.ts
 * @description ISS-4815 (whitlockk, #4253): the archive lane's TERMINAL-SETTLE and
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

import type { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
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
  /**
   * ISS-7097: the start of the unbroken LANE-WIDE failure run this outcome
   * belongs to, or `null` when it does not belong to one. A lane-wide failure
   * (5xx/429 — the cloud is down, not this row) does not advance `retryCount`,
   * so this timestamp carries the wall-clock bound that keeps the terminal path
   * reachable in its place. A row-attributable failure passes `null`: the server
   * answered, so whatever stall was running is over.
   */
  laneStalledSince: string | null;
  /**
   * ISS-9884: the {@link TranscriptSkipReason} the cloud ACKNOWLEDGED for this
   * row's terminal skip, when `dead` is true — `null` otherwise, and ignored
   * when it is. It is the reason the server reported PERSISTING, not the one
   * requested (the two differ when the version-skew fallback fired or the
   * server's precedence rule kept a hard reason already on the row), so the
   * local column and the cloud's `permanentFailureReason` describe the same
   * terminal rather than two guesses at it. Also `null` when the cloud settled
   * it as a label this build cannot name.
   */
  terminalSkipReason: TranscriptSkipReason | null;
  /**
   * ISS-9884: the compute target whose cloud acknowledged that terminal skip,
   * when `dead` is true — `null` otherwise, and ignored when it is. The lane
   * recovery revives an `environment_unavailable` row only under this target,
   * so a pause one identity recorded is never uploaded under another.
   */
  terminalSkipComputeTargetId: string | null;
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
  | ({ kind: "dead" } & TranscriptDeadInput);

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

/**
 * ISS-7097: release the durable upload claim. EVERY settle spreads this, without
 * exception: a settle is the end of the attempt `markUploading` opened, so a
 * lease that outlives it describes an upload that is no longer running. Leaving
 * one behind would make the reclaim predicate wait a full lease window before
 * re-arming a row that was already free — the same silent-drift failure mode
 * {@link CLEARED_CLOUD_ACK} exists to prevent on the acknowledgement pair.
 */
export const CLEARED_UPLOAD_LEASE = {
  uploadingSince: null,
} as const;

/**
 * ISS-7097: end the current lane-wide stall run. Spread by every settle EXCEPT
 * `failure`, which decides for itself (a lane-wide failure carries the run
 * forward, a row-attributable one ends it — a 4xx is proof the lane answered).
 */
export const CLEARED_LANE_STALL = {
  laneStalledSince: null,
} as const;

/**
 * ISS-9884: forget WHY this row last died. Spread by every settle that is NOT
 * itself a terminal — an uploaded/idle/acknowledged row is demonstrably not
 * dead, so a reason surviving into it would let the desktop-local verdict read
 * a give-up off a row that has since recovered. `failure` decides for itself
 * (its dead arm stamps one), and `dead` is the one settle that writes one.
 *
 * The reason and the target whose cloud acknowledged it are one fact, cleared as
 * a pair for the reason {@link CLEARED_CLOUD_ACK} clears its own: a surviving
 * target would scope a revival to a terminal the row no longer has. The one
 * exception is a REVIVED pause still owed its upload: the revival keeps the
 * target as the row's upload scope, and the states between that revival and the
 * row's next idle or terminal settle (a retryable failure, a partial window, a
 * revoked attempt) keep it too — see {@link scopeKeepingRevivedRowData}.
 */
export const CLEARED_TERMINAL_SKIP_REASON = {
  terminalSkipReason: null,
  terminalSkipComputeTargetId: null,
} as const;

/**
 * The canonical `data` payload for reviving a `dead` row back to `queued` —
 * shared by `redriveDeadLettered` (FEA-3932) and `reviveForForcedSync`
 * (FEA-3489). Both mutations mean the same thing by "revived" (clear the failure
 * counters + backoff + last error and re-queue), so keeping the literal in one
 * place stops the two call sites from drifting if what "revived" means ever
 * changes (e.g. an added counter). Typed as the Prisma update input so a schema
 * rename fails typecheck at this single site.
 */
export function revivedRowData(
  now: string
): Prisma.TranscriptSyncStateUpdateManyMutationInput {
  return {
    ...scopeKeepingRevivedRowData(now),
    // ISS-9884: a revived row is no longer terminal, so neither the reason it
    // died of nor the target that acknowledged it may survive into the state it
    // no longer describes — same discipline as the cleared acknowledgement.
    ...CLEARED_TERMINAL_SKIP_REASON,
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
        ...CLEARED_UPLOAD_LEASE,
        ...CLEARED_LANE_STALL,
        // ISS-9884: an upload is never a terminal, so the reason always goes.
        // The target goes only once the row is caught up: a partial window
        // leaves it queued, still owed to a revived pause's own target.
        ...(settle.caughtUp
          ? CLEARED_TERMINAL_SKIP_REASON
          : { terminalSkipReason: null }),
      };
    case "idle":
      return {
        status: TranscriptSyncStatus.Idle,
        // FEA-3555: idling is a non-missing outcome; break the missing run.
        missingSourceCount: 0,
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
        ...CLEARED_UPLOAD_LEASE,
        ...CLEARED_LANE_STALL,
        ...CLEARED_TERMINAL_SKIP_REASON,
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
        // whitlockk (#4253): this is a SUCCESSFUL settle, so it must retire the
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
        ...CLEARED_UPLOAD_LEASE,
        ...CLEARED_LANE_STALL,
        ...CLEARED_TERMINAL_SKIP_REASON,
      };
    case "dead":
      return {
        status: TranscriptSyncStatus.Dead,
        nextAttemptAt: null,
        lastError: settle.reason,
        // ISS-9884: the machine-readable half of the same terminal.
        terminalSkipReason: settle.terminalSkipReason,
        terminalSkipComputeTargetId: settle.terminalSkipComputeTargetId,
        // FEA-3555: terminal row; the missing run is over.
        missingSourceCount: 0,
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
        ...CLEARED_UPLOAD_LEASE,
        ...CLEARED_LANE_STALL,
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
        // ISS-9884: a reason is written ONLY on the arm that actually
        // dead-letters. A retryable failure is not terminal, so stamping one
        // there would make the local verdict read a give-up off a row still on
        // the ladder, and a row re-armed after an earlier terminal must not
        // carry that terminal's reason forward. The dead arm writes its target
        // with it; a retryable failure leaves the column alone, because on a
        // revived pause it is the upload scope the row is still owed under.
        terminalSkipReason: settle.dead ? settle.terminalSkipReason : null,
        ...(settle.dead
          ? { terminalSkipComputeTargetId: settle.terminalSkipComputeTargetId }
          : {}),
        updatedAt: settle.now,
        ...CLEARED_CLOUD_ACK,
        ...CLEARED_UPLOAD_LEASE,
        // ISS-7097: the ONE arm that does not blanket-clear the stall run — a
        // lane-wide failure carries it forward so the wall-clock ceiling can see
        // how long this row has been stalled. `dead` is terminal, so the run
        // ends there regardless of what the caller passed.
        laneStalledSince: settle.dead ? null : settle.laneStalledSince,
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

/**
 * A deliberate terminal skip (`markDead`). Named fields, like
 * {@link TranscriptFailureInput}, because `terminalSkipComputeTargetId` and
 * `now` are both strings a positional call could transpose without a type error.
 */
export type TranscriptDeadInput = {
  externalSessionId: string;
  fileKey: string;
  /** The free-text operator message written to `lastError`. */
  reason: string;
  /**
   * ISS-9884: the acknowledged {@link TranscriptSkipReason}, persisted so the
   * desktop-local verdict can tell an environmental give-up from a hard
   * terminal. `null` when the cloud acknowledged a terminal this build cannot
   * name, which every read maps to the conservative `failedPermanent` — the
   * same verdict the cloud derives from an unrecognized label.
   */
  terminalSkipReason: TranscriptSkipReason | null;
  /**
   * ISS-9884: the compute target whose cloud acknowledged this skip — the scope
   * the lane recovery's revival matches on. `null` when unknown, which no
   * revival matches.
   */
  terminalSkipComputeTargetId: string | null;
  now: string;
};

/**
 * ISS-9884: {@link revivedRowData} WITHOUT clearing
 * `terminalSkipComputeTargetId`, for the two re-queues whose row may be a revived
 * `environment_unavailable` pause: the lane recovery's own revival, and a revoked
 * attempt. Such a row is owed its upload only under the target whose cloud
 * acknowledged the pause, and that column is the only record of which target
 * that is, so clearing it would hand the transcript to whichever target drains
 * next.
 */
export function scopeKeepingRevivedRowData(
  now: string
): Prisma.TranscriptSyncStateUpdateManyMutationInput {
  return {
    status: TranscriptSyncStatus.Queued,
    retryCount: 0,
    missingSourceCount: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: now,
    terminalSkipReason: null,
    // ISS-4815: a revived row is about to be re-attempted from scratch, so any
    // prior cloud acknowledgement no longer describes what the lane will do.
    ...CLEARED_CLOUD_ACK,
    ...CLEARED_UPLOAD_LEASE,
    ...CLEARED_LANE_STALL,
  };
}
