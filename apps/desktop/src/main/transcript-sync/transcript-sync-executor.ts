/**
 * @file transcript-sync-executor.ts
 * @description Per-file sync executor for the transcript archive lane
 * (FEA-2715 / PLN-1288 task 4). For one fingerprinted file it: stats the file,
 * cuts the raw source window at the last complete newline, prepares a redacted
 * archive object window, asks the control plane for an authoritative plan
 * (`noop` | `fullPut` | `multipart`) over those redacted bytes, streams the
 * planned object ranges to S3, calls `complete`, and persists the
 * server-verified cursor. Server state is authoritative (recovery invariant 2):
 * the client re-plans from the returned offset rather than trusting local state,
 * and a resumed/compacted file just yields a different plan.
 *
 * All filesystem + checksum access is injected so the logic is unit-testable
 * without touching disk or the network.
 */
import { stat } from "node:fs/promises";
import {
  isRecoverableTranscriptSkipReason,
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { RedactedJsonlTranscriptLineTooLongError } from "@repo/lib/security/redacted-jsonl-transcript";
import type { TranscriptSettle } from "../database/transcript-sync-settle.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import {
  type DesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../transcript/desktop-transcripts-client.js";
import { findNewlineBoundary as defaultFindNewlineBoundary } from "./transcript-checksums.js";
import {
  isBatchMaterializedHarness,
  isoAfter,
  isRedactedArchiveCursorForComputeTarget,
  missingSourceAttemptLimit,
  redactedArchiveCursorTargetId,
  TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX,
  TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX,
  TRANSCRIPT_SYNC_MAX_FILE_BYTES,
  type TranscriptFileStat,
  type TranscriptFingerprint,
  transcriptCursorMatchesComputeTarget,
  transcriptRetryDelayMs,
} from "./transcript-sync-types.js";
import {
  prepareRedactedTranscriptUploadWindow as defaultPrepareUploadWindow,
  type TranscriptUploadWindow,
} from "./transcript-upload-window.js";

export type TranscriptSyncResult =
  | { kind: "uploaded"; caughtUp: boolean }
  | { kind: "noop" }
  // `permanent: true` marks a TERMINAL skip that re-uploading the same bytes can
  // never resolve (a source that is gone, or a single redacted JSONL line over
  // the per-line wire limit). The automatic drain already dead-lettered such a
  // row; the force-archive path reads this flag to surface a non-retryable
  // `permanent` result instead of inviting a pointless retry (FEA-3489 review).
  // Absent/false = a transient skip (no complete line yet, materialized source
  // not ready, a whole-file-cap skip the force override will bypass) that is fine
  // to re-attempt.
  | { kind: "skipped"; reason: string; permanent?: boolean };

/**
 * ISS-4695 (Item 1): the outcome of a `client.skip` POST, threading the
 * server's authoritative terminal `status` back to the caller instead of
 * collapsing it to a bare "acknowledged" boolean.
 *
 * `markPermanentlySkipped` returns TWO distinct terminal statuses:
 *  - `Skipped`: the server recorded the terminal skip — the cloud agrees the
 *    file is permanently absent, so the caller may mark the local row `dead`.
 *  - `Uploaded`: a verified archive already exists, so the server refused to
 *    mask it with a late skip ("a good archive must never be masked by a late
 *    skip signal"). The cloud STILL HOLDS readable bytes; marking the local row
 *    `dead` here would project `failedPermanent` for a transcript that is
 *    actually synced — a lie. The caller settles the row readable instead.
 *
 * A version-skewed server could in principle answer with any other
 * {@link TranscriptUploadStatus} (`pending`/`uploading`/`failed`); those are
 * treated as NOT a permanent skip (see the call sites), so the row stays
 * retryable rather than being dead-lettered on an ambiguous signal.
 */
export type PermanentSkipEmitResult =
  | { acked: false }
  | { acked: true; status: TranscriptUploadStatus };

/**
 * Thrown by {@link createTranscriptSyncExecutor} when the privacy gate revokes
 * transcript egress WHILE an upload is already in flight (e.g. the user lowered
 * the Data & Sync level to Off mid-upload). It is not a failure: no more bytes
 * leave the device, and the caller settles the row back to a retryable state
 * without dead-lettering or advancing the failure ladder. Distinct class so
 * `processFile` can tell a deliberate revocation apart from a transport error.
 */
export class TranscriptSyncRevokedError extends Error {
  constructor() {
    super("transcript sync revoked mid-upload");
    this.name = "TranscriptSyncRevokedError";
  }
}

export type TranscriptSyncExecutorDeps = {
  store: TranscriptSyncStore;
  client: DesktopTranscriptsClient;
  /** Current online compute target id, or null when offline. */
  getComputeTargetId: () => string | null;
  /**
   * FEA-3907: re-checked at the executor boundary (before each S3 range upload
   * and before `complete`) so a privacy-gate revocation that lands mid-upload —
   * the user lowering the Data & Sync level to Off while a large transcript is
   * streaming — stops sending immediately instead of only gating the NEXT drain
   * tick. Returns whether transcript egress is still permitted. Omitted =
   * always-permitted (legacy/tests), preserving the prior behavior.
   */
  isSyncStillPermitted?: () => boolean;
  now: () => string;
  /**
   * Optional diagnostic sink (mirrors {@link TranscriptSyncService}'s `log`).
   * Used only for the permanent-skip notification, whose failure is downgraded
   * to a logged, retryable non-ack (ISS-4621) rather than thrown.
   */
  log?: (message: string) => void;
  statFile?: (path: string) => Promise<TranscriptFileStat | null>;
  /** Prepare redacted archive object bytes from a raw complete-line window. */
  prepareUploadWindow?: (
    path: string,
    rawEndOffset: number
  ) => Promise<TranscriptUploadWindow>;
  findNewlineBoundary?: (path: string, maxOffset: number) => Promise<number>;
};

/**
 * ISS-4723 PR2: a sink for a file's TERMINAL settle mutation. The drain passes a
 * collector so a whole batch's settles COALESCE into ONE `prisma.write` (see
 * {@link TranscriptSyncStore.recordBatchSettled}); when omitted, `syncFile`
 * writes each settle immediately through the store, preserving the prior
 * per-file behavior for the force-archive path and the direct executor callers.
 * Deferring only the settle is safe: the up-front `markUploading` claim still
 * lands per-file (the FEA-2827 growth-signal guard), so a crash before the batch
 * flush leaves the row `uploading`, recovered by `requeueStale` on boot.
 */
export type TranscriptSettleCollector = (settle: TranscriptSettle) => void;

/**
 * Per-call sync options. `bypassSizeCap` (FEA-3489 / PRD-536) is set ONLY by the
 * user-initiated force-archive override so a single oversized transcript can be
 * uploaded past {@link TRANSCRIPT_SYNC_MAX_FILE_BYTES} for that one file — the
 * automatic drain never sets it, so the cap still backstops the queue. It waives
 * only the whole-FILE size gate, not the per-LINE redacted-length limit (a wire
 * constraint no override can satisfy — that path stays terminal).
 *
 * `settleCollector` (ISS-4723 PR2) redirects this call's terminal settle into a
 * batch instead of writing it inline; the automatic drain sets it to coalesce a
 * batch's settles into one write. Absent = write the settle immediately (the
 * force-archive path, which re-reads the row between windows and so needs the
 * settle durable now, and the direct executor tests).
 */
export type TranscriptSyncFileOptions = {
  bypassSizeCap?: boolean;
  settleCollector?: TranscriptSettleCollector;
};

export type TranscriptSyncExecutor = {
  syncFile(
    fingerprint: TranscriptFingerprint,
    options?: TranscriptSyncFileOptions
  ): Promise<TranscriptSyncResult>;
  /**
   * ISS-4621: tell the cloud this file is terminally skipped. Returns a
   * {@link PermanentSkipEmitResult}: `{ acked: false }` on transport failure,
   * while offline, or after a consent revocation; `{ acked: true, status }`
   * with the server's authoritative terminal status otherwise. Exposed for the
   * service's consecutive-failure dead-letter, which must not mark a row `dead`
   * until the cloud has been told — otherwise the transcript reads `syncing`
   * forever with no failure reason (the SES-78221 class). Never throws.
   *
   * ISS-4695 (Item 1): the caller inspects `status` — a `Skipped` ack is the
   * permanent dead-letter, but an `Uploaded` ack means a verified archive
   * already exists (the server refused to mask it), so the row must NOT go
   * `dead` (it would project `failedPermanent` for a synced transcript).
   *
   * `computeTargetId` pins the skip to the target the FAILED ATTEMPT ran
   * against (the caller snapshots it before the attempt). Without it, a target
   * reconnect between the attempt and this call would record the skip under the
   * NEW target's identity while dead-lettering the local row from the original
   * one — the original target's cloud row would stay `syncing`. Omitted/null
   * falls back to the live target (legacy callers).
   */
  notifyPermanentSkip(
    fingerprint: TranscriptFingerprint,
    reason: TranscriptSkipReason,
    computeTargetId?: string | null
  ): Promise<PermanentSkipEmitResult>;
};

/** Best-effort `{ size, mtimeMs }`; null on any stat error. Shared with the service. */
export async function statTranscriptFile(
  path: string
): Promise<TranscriptFileStat | null> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Cached prefix hash to send as `prefixSha256`, or undefined when it can't be
 * trusted (unknown offset, or belongs to a different compute target — the
 * server then re-plans from its own truth).
 */
function resolvePrefixSha256(
  fp: TranscriptFingerprint,
  computeTargetId: string
): string | undefined {
  if (
    isRedactedArchiveCursorForComputeTarget(
      fp.syncedComputeTargetId,
      computeTargetId
    ) &&
    fp.syncedByteOffset > 0 &&
    fp.syncedSha256
  ) {
    return fp.syncedSha256;
  }
  return undefined;
}

/**
 * ISS-4723 PR2: a per-call settle SINK for one file's terminal mutation. When a
 * batch collector is supplied (the automatic drain), the settle is deferred into
 * the batch to coalesce into one write; otherwise it is written immediately
 * through the matching store method. Both paths persist the same terminal state
 * — the store's `settleUpdateData` is the single source of truth for the `data`
 * — so this only chooses WHEN the write lands, never WHAT it writes.
 */
function makeSettleSink(
  store: TranscriptSyncStore,
  collector: TranscriptSettleCollector | undefined
): (settle: TranscriptSettle) => Promise<void> {
  if (collector) {
    return (settle) => {
      collector(settle);
      return Promise.resolve();
    };
  }
  return (settle) => applyTranscriptSettleToStore(store, settle);
}

/**
 * Apply ONE {@link TranscriptSettle} through the store's per-file terminal
 * method (the immediate, non-batched path). Kept next to the batch collector so
 * the mapping from settle kind → store method is defined once.
 */
function applyTranscriptSettleToStore(
  store: TranscriptSyncStore,
  settle: TranscriptSettle
): Promise<void> {
  switch (settle.kind) {
    case "uploaded":
      return store.recordUploaded(settle);
    case "failure":
      return store.recordFailure(settle);
    case "idle":
      return store.markIdle(
        settle.externalSessionId,
        settle.fileKey,
        settle.now
      );
    case "cloudUploaded":
      return store.markCloudUploaded(
        settle.externalSessionId,
        settle.fileKey,
        settle.now,
        settle.computeTargetId
      );
    case "dead":
      return store.markDead(
        settle.externalSessionId,
        settle.fileKey,
        settle.reason,
        settle.now
      );
    default: {
      const exhaustive: never = settle;
      return exhaustive;
    }
  }
}

export function createTranscriptSyncExecutor(
  deps: TranscriptSyncExecutorDeps
): TranscriptSyncExecutor {
  const statFile = deps.statFile ?? statTranscriptFile;
  const prepareUploadWindow =
    deps.prepareUploadWindow ?? defaultPrepareUploadWindow;
  const findNewlineBoundary =
    deps.findNewlineBoundary ?? defaultFindNewlineBoundary;
  const { store, client, getComputeTargetId, now } = deps;
  const isSyncStillPermitted = deps.isSyncStillPermitted ?? (() => true);
  const log = deps.log ?? (() => undefined);

  /**
   * Fail-closed egress guard: throw {@link TranscriptSyncRevokedError} the moment
   * the privacy gate reports transcript sync is no longer permitted, so no
   * further redacted bytes leave the device once the user lowers the level.
   */
  function assertSyncStillPermitted(): void {
    if (!isSyncStillPermitted()) {
      throw new TranscriptSyncRevokedError();
    }
  }

  /**
   * ISS-4623 (shafty023 review) — the pre-egress guard for the whole in-flight
   * request. `syncFile` samples the egress gate and compute target ONCE at entry,
   * then awaits stat / newline-scan / redacted-window preparation before the
   * first server call (`syncPlan`). A policy close, tier revocation, or account
   * switch landing in that gap must abort BEFORE any session identity / hash
   * leaves the device — and must never pair the PREVIOUS target with
   * newly-resolved credentials. So this re-checks BOTH the live egress gate and
   * that the live compute target is unchanged from the one the attempt began
   * against, throwing {@link TranscriptSyncRevokedError} (a benign,
   * non-dead-lettering abort) if either moved. Called immediately before every
   * server egress in the flow, matching the pre-upload / pre-complete guards.
   */
  function assertEgressStillPermitted(attemptComputeTargetId: string): void {
    assertSyncStillPermitted();
    if (getComputeTargetId() !== attemptComputeTargetId) {
      // The online target switched (reconnect / account switch) mid-attempt;
      // aborting settles the row retryable so the next drain re-plans against the
      // NEW target rather than crossing the two identities.
      throw new TranscriptSyncRevokedError();
    }
  }

  /**
   * FEA-3476 / PRD-536 D7: tell the cloud a transcript file is terminally,
   * non-retryably skipped (e.g. it exceeds the local size cap) so the read path
   * derives `failedPermanent` instead of a misleading `syncing`.
   *
   * NON-THROWING, ACK-GATED (ISS-4621): returns whether the server acknowledged
   * the skip and, on ack, the server's authoritative terminal status
   * (ISS-4695). Callers dead-letter ONLY on an `acked` ack whose `status` is
   * `Skipped`; on `{ acked: false }` they record a retryable failure instead,
   * so the whole terminal transition (skip + dead) is re-attempted on the next
   * drain. Before ISS-4621 the caller dead-lettered FIRST and this call was
   * fire-and-forget — a failed POST then never retried for a gone/unchanged
   * source (a `dead` row is only re-observed when the file CHANGES), leaving the
   * cloud representing the transcript as `syncing` forever. The server call is
   * idempotent on an already-skipped row, so re-attempts are safe.
   */
  async function tryEmitPermanentSkip(
    fp: TranscriptFingerprint,
    computeTargetId: string,
    reason: TranscriptSkipReason
  ): Promise<PermanentSkipEmitResult> {
    // Honor a mid-flight consent revocation here too: the skip carries no
    // transcript bytes, but it still POSTs session identity from this lane, and
    // nothing may leave the device once the tier closes. Non-ack (not a throw)
    // so the row settles on the retry ladder and the terminal transition
    // re-runs once consent reopens.
    if (!isSyncStillPermitted()) {
      return { acked: false };
    }
    try {
      const response = await client.skip({
        computeTargetId,
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        sourceHarness: fp.sourceHarness,
        reason,
      });
      // ISS-4695 (Item 1): thread the server's authoritative terminal status so
      // the caller can tell a recorded `Skipped` from an `Uploaded` (a verified
      // archive the server refused to mask) and avoid dead-lettering the latter.
      return { acked: true, status: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // ISS-4820 item 4 — VERSION SKEW. `materialized_source_unavailable` is a
      // newer member of a CLOSED server-side write enum, so an API deployed
      // before it existed rejects the whole request with a 400. Treating that as
      // merely unacknowledged put the row back on the retry ladder to resend the
      // same unsupported value forever: pending until the server upgraded, with
      // no bound. Server-first deploy ordering covers the forward path but not a
      // rollback or a staged/mismatched environment.
      //
      // Fall back to the pre-existing HARD reason the old server does accept, so
      // the row reaches an acknowledged terminal state instead of looping. This
      // is one-shot by construction: `source_gone` is not recoverable, so the
      // guard below cannot match again on the retry.
      if (
        isRecoverableTranscriptSkipReason(reason) &&
        isRejectedSkipReasonError(error)
      ) {
        log(
          `transcript ${fp.fileKey} skip reason ${reason} rejected by the server (400); falling back to ${TranscriptSkipReason.SourceGone}`
        );
        return await tryEmitPermanentSkip(
          fp,
          computeTargetId,
          TranscriptSkipReason.SourceGone
        );
      }
      log(
        `transcript ${fp.fileKey} permanent-skip notification failed (${reason}): ${message}`
      );
      return { acked: false };
    }
  }

  /**
   * Record a retryable failure for a terminal transition whose cloud skip
   * notification was NOT acknowledged, so the next drain re-attempts the whole
   * transition (the skip is idempotent server-side). Shares the normal backoff
   * ladder; `missingSourceCount` is caller-owned because only the
   * missing-source ladder advances it.
   */
  async function recordUnacknowledgedSkip(
    settle: (settle: TranscriptSettle) => Promise<void>,
    fp: TranscriptFingerprint,
    missingSourceCount: number,
    lastError: string
  ): Promise<void> {
    const nowIso = now();
    const retryAttempt = fp.retryCount + 1;
    await settle({
      kind: "failure",
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      retryCount: retryAttempt,
      missingSourceCount,
      dead: false,
      nextAttemptAt: isoAfter(nowIso, transcriptRetryDelayMs(retryAttempt)),
      lastError,
      now: nowIso,
    });
  }

  /**
   * ISS-4695 (Item 1): emit a terminal cloud skip and settle the local row on
   * the server's authoritative answer, so a permanent local dead-letter is
   * projected ONLY when the cloud actually recorded the skip. Shared by every
   * terminal call site (missing-source, redacted-line-too-long, oversize) so
   * their handling of the three outcomes cannot drift:
   *
   *  - `{ acked: false }` (transport failure / offline / consent revoked): the
   *    row was NOT told to the cloud. Record a retryable failure so the whole
   *    transition re-runs next drain (idempotent server-side). Returns
   *    `"unacknowledged"`.
   *  - `{ acked: true, status: Skipped }`: the cloud recorded the terminal skip.
   *    Dead-letter the local row. Returns `"skipped"`.
   *  - `{ acked: true, status: Uploaded }`: a verified archive already exists, so
   *    the server refused to mask it — the cloud STILL holds readable bytes.
   *    Settle the row `idle` (readable/synced), NOT `dead`; dead-lettering here
   *    would project `failedPermanent` for a transcript the cloud actually has
   *    (the ISS-4695 lie). Returns `"uploaded"`.
   *  - Any OTHER status (version-skewed server answering `pending`/`uploading`/
   *    `failed`): treat as NOT a permanent skip — record a retryable failure so
   *    the row stays on the ladder rather than dead-lettering on an ambiguous
   *    signal. Returns `"unacknowledged"`.
   */
  async function settleTerminalSkip(
    settle: (settle: TranscriptSettle) => Promise<void>,
    fp: TranscriptFingerprint,
    computeTargetId: string,
    reason: TranscriptSkipReason,
    outcomes: {
      /** `missingSourceCount` to persist on the unacknowledged/retryable path. */
      missingSourceCount: number;
      /** `lastError` to persist on the unacknowledged/retryable path. */
      unacknowledgedError: string;
      /** `reason` to persist when the row is dead-lettered. */
      deadReason: string;
    }
  ): Promise<"skipped" | "uploaded" | "unacknowledged"> {
    const emit = await tryEmitPermanentSkip(fp, computeTargetId, reason);
    if (!emit.acked) {
      await recordUnacknowledgedSkip(
        settle,
        fp,
        outcomes.missingSourceCount,
        outcomes.unacknowledgedError
      );
      return "unacknowledged";
    }
    if (emit.status === TranscriptUploadStatus.Skipped) {
      await settle({
        kind: "dead",
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        reason: outcomes.deadReason,
        now: now(),
      });
      return "skipped";
    }
    if (emit.status === TranscriptUploadStatus.Uploaded) {
      // The cloud holds a verified archive; settle readable, not dead.
      //
      // ISS-4815: settle it DURABLY (`cloudUploaded`), not as a bare `idle`. A
      // missing-source row that gets this answer still has a zero local cursor,
      // which is precisely the shape `requeueStrandedMissingBlobs` re-arms — so
      // a bare `idle` was re-armed on every launch and replayed this whole
      // ladder + skip round-trip for a transcript the cloud already holds.
      await settle({
        kind: "cloudUploaded",
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        now: now(),
        // Scope the ack to the target that gave it: it says nothing about what a
        // target the user switches to later holds, and the stranded recovery
        // must be able to re-arm this row for that new target.
        computeTargetId,
      });
      return "uploaded";
    }
    // Version-skew: an unexpected non-terminal status (`pending`/`uploading`/
    // `failed`). Not a permanent skip — stay retryable rather than dead-letter.
    await recordUnacknowledgedSkip(
      settle,
      fp,
      outcomes.missingSourceCount,
      outcomes.unacknowledgedError
    );
    return "unacknowledged";
  }

  /**
   * FEA-3555: the local transcript source is not on disk at sync time. This is
   * benign in two cases and terminal in one:
   *
   * - Already partly/fully uploaded FOR THIS COMPUTE TARGET (`syncedByteOffset >
   *   0` AND the cursor describes redacted bytes for `computeTargetId`): the
   *   cloud already holds readable bytes (availability `available`/`stale`); a
   *   vanished source just means no further appends. Settle to `idle` — the
   *   session detail already resolves. ISS-4647: the cursor check is load-bearing.
   *   A positive offset carried over from a PREVIOUS target says nothing about
   *   this target's cloud row, and idling on it left that row `missing`/`syncing`
   *   forever; such a row falls through to the bounded ladder below instead.
   * - Never uploaded and still under the miss threshold: the absence may be
   *   transient (atomic rename/rotation mid-write, a live session's
   *   not-yet-flushed `<uuid>.jsonl`, or a materialized projection the
   *   materializer has not re-written yet). Record a backoff failure so
   *   `retryCount` climbs and the file re-attempts; a reappearance re-queues it
   *   via `planObservation` and resets the count.
   * - Never uploaded and the miss threshold is reached: the source crossed the
   *   consecutive-miss cap. The reason emitted to the cloud depends on whether the
   *   source is REGENERABLE (ISS-4695 item 3, Option A):
   *   - A raw Claude/Codex rollout (`~/.codex`/`~/.claude`) that vanished before
   *     any bytes synced is treated as permanently gone (old-session case —
   *     re-deriving from point-in-time local FS state can never recover it). Emit
   *     the terminal `source_gone` skip → the cloud derives a HARD
   *     `failedPermanent`.
   *   - A BATCH-MATERIALIZED (OpenCode) source is a desktop-generated projection
   *     re-created deterministically every sweep from the foreign `opencode.db`
   *     (see {@link isBatchMaterializedHarness}). It CAN be regenerated, so a
   *     `source_gone` HARD terminal on the cloud would hide that recovery is still
   *     possible. Instead emit `materialized_source_unavailable` → the cloud maps
   *     it to a RECOVERABLE (non-`failedPermanent`) disposition so redrive stays
   *     possible; a later re-materialize (a file change) re-queues the local row.
   *   Once the cloud acknowledged the skip (ISS-4621) the row is dead-lettered
   *   locally, so the cloud stops representing the transcript as `syncing` forever
   *   (parity with the `too_large` terminal path / FEA-3476).
   *
   * ISS-4647: a BATCH-MATERIALIZED harness (OpenCode) walks the SAME ladder, just
   * with the longer {@link missingSourceAttemptLimit} bound. FEA-3932 gave it an
   * unconditional `markIdle` instead — no ladder, no bound — so once the
   * stranded-blob recovery started re-queuing those rows they cycled
   * idle→queued→idle forever and the cloud never left `missing`/`syncing`.
   * Recovery is unaffected: the FEA-3932 one-shot OpenCode redrive revives this
   * dead-letter family on the next start.
   */
  async function handleMissingSource(
    settle: (settle: TranscriptSettle) => Promise<void>,
    fp: TranscriptFingerprint,
    computeTargetId: string
  ): Promise<TranscriptSyncResult> {
    const nowIso = now();
    if (
      fp.syncedByteOffset > 0 &&
      transcriptCursorMatchesComputeTarget(
        fp.syncedComputeTargetId,
        computeTargetId
      )
    ) {
      // This target's cloud already holds readable bytes; a gone source is not a
      // data loss. A stale-domain / previous-target cursor does NOT qualify
      // (ISS-4647) — it falls through to the bounded missing-source ladder so the
      // current target's cloud row reaches an honest terminal state.
      await settle({
        kind: "idle",
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        now: nowIso,
      });
      return { kind: "skipped", reason: "file missing" };
    }
    // FEA-3932: a batch-materialized harness (OpenCode) source is a
    // desktop-generated projection re-created deterministically every sweep from
    // the foreign store (`opencode.db`), so a transiently-absent materialized
    // file is usually just waiting on its own producer. That earns it the LONGER
    // bound below (several materialize passes), not an exemption from the ladder.
    const { reason: missingReason, lastError: missingLastError } =
      missingSourceDescriptor(fp.sourceHarness);
    // `fp.missingSourceCount` counts ONLY prior consecutive missing-source
    // observations (isolated from `retryCount`, which also counts transient
    // upload failures), so an unrelated failure run can never contribute to this
    // terminal threshold. This observation is the next consecutive miss.
    const missingAttempt = fp.missingSourceCount + 1;
    // ISS-4647: the terminal cap is per-harness — a batch-materialized OpenCode
    // projection walks the SAME ladder but with the LONGER
    // {@link missingSourceAttemptLimit} bound (several materialize passes) before
    // it terminates, so a slow re-materialize is not mistaken for a gone source.
    if (missingAttempt >= missingSourceAttemptLimit(fp.sourceHarness)) {
      // ISS-4695 item 3 (Option A): pick the terminal reason by whether the
      // source is regenerable. A batch-materialized OpenCode projection can
      // re-materialize, so it emits the RECOVERABLE
      // `materialized_source_unavailable` (cloud → non-permanent disposition);
      // a raw Claude/Codex rollout emits the HARD `source_gone`.
      const materialized = isBatchMaterializedHarness(fp.sourceHarness);
      const reason = materialized
        ? TranscriptSkipReason.MaterializedSourceUnavailable
        : TranscriptSkipReason.SourceGone;
      // ISS-4621: ack-gated terminal — the cloud skip goes FIRST, and the row is
      // dead-lettered only once the server RECORDED the skip. A missing source
      // is never re-observed unless the file changes (`planObservation` re-queues
      // only on change), so a dead row whose skip POST failed would leave the
      // cloud on `syncing` forever with no failure reason. On a failed skip the
      // row stays on the retry ladder (missingSourceCount holds at the threshold)
      // and the whole transition re-runs next drain; the skip is idempotent
      // server-side. ISS-4695 (Item 1): an `uploaded` answer means the cloud
      // already holds a verified archive (it refused to mask it), so the row
      // settles readable, not dead.
      const outcome = await settleTerminalSkip(
        settle,
        fp,
        computeTargetId,
        reason,
        {
          missingSourceCount: missingAttempt,
          unacknowledgedError: `${missingLastError}; terminal skip not yet acknowledged`,
          deadReason: `${TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX} after ${missingAttempt} attempt(s) (${reason})`,
        }
      );
      if (outcome === "skipped") {
        return {
          kind: "skipped",
          reason: materialized
            ? "materialized source unavailable"
            : "source gone",
          permanent: true,
        };
      }
      // `uploaded` (cloud has readable bytes) or `unacknowledged`/version-skew:
      // NOT a permanent local failure — settled readable or left retryable, so
      // the row keeps the non-terminal missing-source descriptor.
      return { kind: "skipped", reason: missingReason };
    }
    // Under threshold: treat as a retryable miss so the row backs off and
    // re-attempts (a transient rotation/flush race, or a materialized projection
    // the materializer will regenerate on the next sweep). The backoff delay
    // still climbs off the shared `retryCount` ladder, while `missingSourceCount`
    // advances the isolated terminal counter. ISS-4647: settling as `failed`
    // rather than `idle` is what keeps a batch-materialized row VISIBLE to
    // `listReady`, so it converges on the bound instead of cycling
    // idle→queued→idle against the stranded-blob recovery.
    const retryAttempt = fp.retryCount + 1;
    await settle({
      kind: "failure",
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      retryCount: retryAttempt,
      missingSourceCount: missingAttempt,
      dead: false,
      nextAttemptAt: isoAfter(nowIso, transcriptRetryDelayMs(retryAttempt)),
      lastError: missingLastError,
      now: nowIso,
    });
    return { kind: "skipped", reason: missingReason };
  }

  async function handleRedactedLineTooLong(
    settle: (settle: TranscriptSettle) => Promise<void>,
    fp: TranscriptFingerprint,
    computeTargetId: string,
    error: RedactedJsonlTranscriptLineTooLongError
  ): Promise<TranscriptSyncResult> {
    // ISS-4621: ack-gated terminal (see handleMissingSource) — the oversized
    // line is deterministic, so an unchanged-on-disk file would never re-observe
    // a dead row and a lost skip POST would strand the cloud on `syncing`.
    // ISS-4695: an `uploaded` answer settles the row readable, not dead.
    const outcome = await settleTerminalSkip(
      settle,
      fp,
      computeTargetId,
      TranscriptSkipReason.TooLarge,
      {
        missingSourceCount: 0,
        unacknowledgedError:
          "redacted transcript line exceeds maximum byte length; terminal skip not yet acknowledged",
        deadReason: `skipped: redacted transcript line exceeds maximum byte length (${error.message})`,
      }
    );
    if (outcome === "skipped") {
      return {
        kind: "skipped",
        reason: "redacted line too large",
        permanent: true,
      };
    }
    // `uploaded` (cloud holds readable bytes) or `unacknowledged`/version-skew.
    return { kind: "skipped", reason: "redacted line too large" };
  }

  async function disposeUploadWindow(
    fp: TranscriptFingerprint,
    uploadWindow: TranscriptUploadWindow
  ): Promise<void> {
    try {
      await uploadWindow.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `transcript ${fp.fileKey} redacted upload temp cleanup failed: ${message}`
      );
    }
  }

  async function uploadPlanBytes(
    plan: Extract<
      Awaited<ReturnType<typeof client.syncPlan>>,
      { mode: "fullPut" | "multipart" }
    >,
    uploadWindow: TranscriptUploadWindow,
    crc64NvmeBase64: string,
    computeTargetId: string
  ): Promise<void> {
    if (plan.mode === "fullPut") {
      // Full rewrite from 0 — the checksum header is the whole-window CRC64NVME.
      // Stream redacted archive bytes to S3 instead of buffering them in memory.
      // Re-check the egress gate + live target right before egress so a mid-upload
      // revocation or account switch stops the bytes from ever leaving the device
      // (FEA-3907 / ISS-4623).
      assertEgressStillPermitted(computeTargetId);
      const body = uploadWindow.openRangeStream(0, plan.planEndOffset);
      await client.uploadPut(
        plan.url,
        body,
        plan.planEndOffset,
        crc64NvmeBase64
      );
      return;
    }
    // Append (or from-scratch multipart): stream each redacted object range,
    // re-checking the egress gate + live target before EVERY part so a revocation
    // or account switch aborts the remaining parts, not just the next drain tick
    // (FEA-3907 / ISS-4623).
    for (const part of plan.parts) {
      assertEgressStillPermitted(computeTargetId);
      const body = uploadWindow.openRangeStream(
        part.offset,
        part.offset + part.byteLength
      );
      await client.uploadPart(part.url, body, part.byteLength);
    }
  }

  async function applyPlan(
    settle: (settle: TranscriptSettle) => Promise<void>,
    fp: TranscriptFingerprint,
    plan: Awaited<ReturnType<typeof client.syncPlan>>,
    computeTargetId: string,
    uploadWindow: TranscriptUploadWindow
  ): Promise<TranscriptSyncResult> {
    const { checksums: windowChecksums, planEndOffset } = uploadWindow;
    if (plan.mode === "noop") {
      const caughtUp = plan.syncedByteOffset >= planEndOffset;
      await settle({
        kind: "uploaded",
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        syncedByteOffset: plan.syncedByteOffset,
        syncedSha256: caughtUp ? windowChecksums.sha256Hex : fp.syncedSha256,
        storedEtag: plan.storedEtag,
        syncedComputeTargetId: redactedArchiveCursorTargetId(computeTargetId),
        caughtUp,
        now: now(),
      });
      return { kind: "noop" };
    }

    await uploadPlanBytes(
      plan,
      uploadWindow,
      windowChecksums.crc64NvmeBase64,
      computeTargetId
    );

    // Last gate before finalizing the object server-side: a revocation OR an
    // account/target switch between the final part and `complete` must still
    // abort (the uploaded parts are not yet a readable object until completed,
    // and `complete` must not finalize under a different target) (FEA-3907 /
    // ISS-4623).
    assertEgressStillPermitted(computeTargetId);
    const completed = await client.complete({
      computeTargetId,
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      mode: plan.mode,
      uploadId: plan.mode === "multipart" ? plan.uploadId : undefined,
      planEndOffset,
      sha256: windowChecksums.sha256Hex,
      crc64nvme: windowChecksums.crc64NvmeBase64,
    });

    const caughtUp = completed.syncedByteOffset >= planEndOffset;
    await settle({
      kind: "uploaded",
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      syncedByteOffset: completed.syncedByteOffset,
      // The window checksum covers `[0, planEndOffset)`; only adopt it as the new
      // prefix hash when the server confirms it caught up to that end. When the
      // server acked a smaller `syncedByteOffset`, that hash describes a wider
      // range than the cursor, so keep the prior prefix hash (mirroring the
      // `noop` branch) — otherwise the next sync sends a `prefixSha256` for the
      // wrong byte range and the compaction/rewrite guard forces a full
      // re-upload from offset 0.
      syncedSha256: caughtUp ? windowChecksums.sha256Hex : fp.syncedSha256,
      storedEtag: completed.storedEtag,
      syncedComputeTargetId: redactedArchiveCursorTargetId(computeTargetId),
      caughtUp,
      now: now(),
    });
    return { kind: "uploaded", caughtUp };
  }

  async function syncFile(
    fp: TranscriptFingerprint,
    options?: TranscriptSyncFileOptions
  ): Promise<TranscriptSyncResult> {
    const computeTargetId = getComputeTargetId();
    if (!computeTargetId) {
      // Caller only drives the executor while online; guard defensively.
      throw new Error("no online compute target");
    }

    // ISS-4723 PR2: this file's TERMINAL settle either coalesces into the drain
    // batch (collector supplied) or writes immediately (force-archive / direct
    // callers). `markUploading` below is deliberately NOT routed through it — it
    // stays a per-file up-front write (the FEA-2827 growth-signal guard).
    const settle = makeSettleSink(store, options?.settleCollector);

    // Fail-closed before we even claim the row: if the privacy gate already
    // revoked egress, abort without touching row state (FEA-3907).
    assertSyncStillPermitted();

    // Claim the row as `uploading` BEFORE any stat/redacted-window read
    // (FEA-2827). The stat + newline scan + full-window preparation below take
    // multi-seconds on a large transcript; if the row stayed `queued`, a
    // concurrent `observe` (terminal Stop hook or sweep) on a file that just
    // grew would see `status !== uploading`, treat it as changed, and advance
    // `lastMtimeMs`/`lastSize` past the appended bytes. Once this upload settled
    // to `idle`, the growth would look already-observed and the trailing bytes
    // `[planEndOffset, newSize)` would never re-queue — permanently lost if that
    // growth was the file's final size (session end). Marking `uploading` first
    // makes `planObservation` preserve the growth signal instead of consuming it.
    await store.markUploading(fp.externalSessionId, fp.fileKey, now());

    const fileStat = await statFile(fp.sourcePath);
    if (!fileStat) {
      return handleMissingSource(settle, fp, computeTargetId);
    }

    // The whole-file size cap is a backstop against STARTING a runaway upload; it
    // is waived when either (a) the caller set `bypassSizeCap` — the one-shot,
    // per-file user-initiated force-archive override (FEA-3489) — or (b) this row
    // is a RESUME IN PROGRESS (`syncedByteOffset > 0`), i.e. an earlier forced
    // window already committed part of this oversized file to the cloud. Refusing
    // to finish a resume at the cap would STRAND those committed bytes — the file
    // would read as partially-synced forever — so once any byte of an oversized
    // file has left the machine the AUTOMATIC drain must carry it to completion
    // too, not just the forced pass. (FEA-3489 review: "durable lane owns the
    // remainder" is only true if the automatic drain doesn't re-trip the cap.)
    const capWaived =
      options?.bypassSizeCap === true || fp.syncedByteOffset > 0;
    if (fileStat.size > TRANSCRIPT_SYNC_MAX_FILE_BYTES && !capWaived) {
      // FEA-3583: pathological-file backstop ONLY. The cap is now far above any
      // realistic main transcript, so large/long sessions' primary
      // `<sessionId>.jsonl` imports via the streamed newline scan + streamed
      // checksum + (multipart) upload below rather than being dropped while their
      // small subagent sidechains survive. Only a genuinely runaway file trips
      // this branch; it's dead-lettered here BEFORE redacted staging reads. A
      // later `observe` re-queues it only if it grows past the recorded size.
      // Checked after `markUploading` (harmless: an abandoned oversize file has
      // no growth signal worth preserving). The `lastError` carries the shared
      // {@link TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX} so the force-archive
      // revive predicate can distinguish this fixable reason from the two
      // non-fixable terminals (`source_gone`, redacted-line-too-long).
      // FEA-3476: emit the terminal disposition to the cloud so a finished
      // session's oversized transcript is honestly represented as permanently
      // unavailable (`failedPermanent`) rather than silently absent while
      // metadata shows "completed". ISS-4621: ack-gated — an unchanged oversized
      // file never re-observes a dead row, so a lost skip POST would strand the
      // cloud on `syncing`; dead-letter only once the server RECORDED the skip,
      // else stay on the retry ladder and re-run this transition next drain
      // (idempotent server-side). ISS-4695: an `uploaded` answer means a
      // verified archive already exists (the server refused to mask it) — settle
      // the row readable, not dead, so the projection reflects the cloud truth.
      await settleTerminalSkip(
        settle,
        fp,
        computeTargetId,
        TranscriptSkipReason.TooLarge,
        {
          missingSourceCount: 0,
          unacknowledgedError:
            "file exceeds transcript size cap; terminal skip not yet acknowledged",
          deadReason: `${TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX}: ${fileStat.size} bytes exceeds ${TRANSCRIPT_SYNC_MAX_FILE_BYTES}-byte cap`,
        }
      );
      return { kind: "skipped", reason: "file too large" };
    }

    const rawPlanEndOffset = await findNewlineBoundary(
      fp.sourcePath,
      fileStat.size
    );
    if (rawPlanEndOffset === 0) {
      // No complete JSONL line yet — nothing durable to sync.
      await settle({
        kind: "idle",
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        now: now(),
      });
      return { kind: "skipped", reason: "no complete line" };
    }

    let uploadWindow: TranscriptUploadWindow;
    try {
      uploadWindow = await prepareUploadWindow(fp.sourcePath, rawPlanEndOffset);
    } catch (error) {
      if (error instanceof RedactedJsonlTranscriptLineTooLongError) {
        return handleRedactedLineTooLong(settle, fp, computeTargetId, error);
      }
      throw error;
    }
    try {
      const { checksums: windowChecksums, planEndOffset } = uploadWindow;

      // ISS-4623 (shafty023 review): `syncPlan` is the FIRST server egress and
      // POSTs session id + content hashes. The gate + target were sampled at
      // entry, then stat / newline-scan / redacted-window preparation awaited
      // above; re-check both here so a policy close, tier revocation, or account
      // switch in that gap aborts before any identity leaves the device and never
      // pairs the previous target with newly-resolved credentials.
      assertEgressStillPermitted(computeTargetId);
      const plan = await client.syncPlan({
        computeTargetId,
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        sourceHarness: fp.sourceHarness,
        sourcePathHash: fp.sourcePathHash,
        planEndOffset,
        sha256: windowChecksums.sha256Hex,
        crc64nvme: windowChecksums.crc64NvmeBase64,
        sourceMtime: new Date(fileStat.mtimeMs).toISOString(),
        prefixSha256: resolvePrefixSha256(fp, computeTargetId),
      });

      return await applyPlan(settle, fp, plan, computeTargetId, uploadWindow);
    } finally {
      await disposeUploadWindow(fp, uploadWindow);
    }
  }

  async function notifyPermanentSkip(
    fp: TranscriptFingerprint,
    reason: TranscriptSkipReason,
    computeTargetId?: string | null
  ): Promise<PermanentSkipEmitResult> {
    // Prefer the caller's snapshot of the attempt's target (see the interface
    // doc — a reconnect between attempt and skip must not split the record
    // across two target identities); fall back to the live target.
    const target = computeTargetId ?? getComputeTargetId();
    if (!target) {
      // Offline: nothing was told to the cloud, so the caller must not treat
      // the terminal transition as acknowledged.
      return { acked: false };
    }
    // ISS-4695: forward the server's authoritative status so the drain-queue's
    // `recordFailure` avoids dead-lettering when the cloud already holds the
    // upload (`uploaded`).
    return await tryEmitPermanentSkip(fp, target, reason);
  }

  return { syncFile, notifyPermanentSkip };
}

/**
 * ISS-4647: the harness-specific wording for a missing-source outcome — the
 * caller-visible `skipped` reason and the `lastError` persisted on the row. Kept
 * in one place so the two can never disagree about which absence they describe
 * (a vanished raw transcript vs a materialized projection its producer has not
 * written yet). The BOUND those outcomes converge on lives in
 * {@link missingSourceAttemptLimit}; this only names the outcome.
 */
function missingSourceDescriptor(sourceHarness: string): {
  reason: string;
  lastError: string;
} {
  if (isBatchMaterializedHarness(sourceHarness)) {
    return {
      reason: "materialized source not ready",
      lastError: "materialized transcript source not ready",
    };
  }
  return {
    reason: "file missing",
    lastError: "local transcript source missing",
  };
}

/**
 * ISS-4820 item 4 — whether a failed skip POST is the server REJECTING the
 * reason value itself (a closed write enum that predates it), as opposed to a
 * transport, auth, or availability failure that should just be retried.
 *
 * `postControl` discards the response body on a non-2xx, so the status code is
 * the only discriminator available. A 400 on this route means the request did
 * not validate — and for a skip whose identity fields were already accepted by
 * every prior attempt, the reason is what changed. Any other failure stays on
 * the normal retry ladder, so this never converts a transient outage into a
 * premature hard terminal state.
 */
function isRejectedSkipReasonError(error: unknown): boolean {
  return error instanceof TranscriptSyncClientError && error.status === 400;
}
