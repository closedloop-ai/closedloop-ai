import {
  type TranscriptCompleteRequest,
  type TranscriptCompleteResponse,
  type TranscriptSkipRequest,
  type TranscriptSkipResponse,
  type TranscriptSyncPlanRequest,
  type TranscriptSyncPlanResponse,
  type TranscriptUploadPart,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { Result } from "@repo/api/src/types/result";
import { toKnownTranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { resolveByAnyIndexKey } from "@/lib/index-key-lookup";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { resolveSkipReasonPrecedence } from "./skip-reason-precedence";
import type { TranscriptCompleteWrite } from "./transcript-complete-receipt";
import { projectedIdentityColumns } from "./transcript-index-keys";
import { decideSyncPlan, type SyncPlanDecision } from "./transcript-plan";
import {
  type TranscriptRateLimiter,
  transcriptRateLimiter,
} from "./transcript-rate-limit";
import {
  type AuthContext,
  advisoryLockKeySql,
  authorizeTranscriptRequest,
  type FileIdentity,
  identityWhere,
  lockKey,
  type ResolvedDeps,
} from "./transcript-request-context";
import {
  failAndAbort,
  isUploadedMatch,
  markFailed,
  noopResult,
  TRANSCRIPT_SYNC_ROW_SELECT,
  type TranscriptPlanRowData,
  type TranscriptSyncRow,
  upsertPlanRow,
} from "./transcript-row";
import { defaultS3Port, type TranscriptS3Port } from "./transcript-s3-port";
import {
  isStorageNotConfiguredError,
  isUpstreamS3Rejection,
} from "./transcript-s3-rejection";
import type { TranscriptSkipWrite } from "./transcript-skip-receipt";
import { TranscriptSyncErrorReason } from "./transcript-sync-error-reason";

/**
 * Transcript control-plane service (FEA-2714, PLN-1287). Orchestrates S3
 * copy-append multipart uploads and mints presigned URLs; transcript bytes
 * never transit apps/api. Server state (offset, ETag, checksums) advances only
 * on a verified `complete`, so any failed attempt recovers by re-planning from
 * the last acked state (recovery invariants).
 */

/** Abort in-flight multipart uploads older than this (staleness backstop). */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Interactive-transaction ceiling — the server-side copy is the slow step. */
const PLAN_TX_TIMEOUT_MS = 30_000;

type PlanResult = Result<TranscriptSyncPlanResponse, TranscriptSyncErrorReason>;
type CompleteResult = Result<
  TranscriptCompleteResponse,
  TranscriptSyncErrorReason
>;
type SkipResult = Result<TranscriptSkipResponse, TranscriptSyncErrorReason>;

export type TranscriptServiceDeps = {
  s3?: TranscriptS3Port;
  now?: () => number;
  rateLimiter?: TranscriptRateLimiter;
};

type PlanSyncInput = AuthContext & {
  request: TranscriptSyncPlanRequest;
  deps?: TranscriptServiceDeps;
};

type CompleteInput = AuthContext & {
  request: TranscriptCompleteRequest;
  deps?: TranscriptServiceDeps;
};

type SkipInput = AuthContext & {
  request: TranscriptSkipRequest;
  deps?: TranscriptServiceDeps;
};

/** Per-plan context derived from the stored row + request. */
type PlanContext = {
  syncedOffset: number;
  storedEtag: string | null;
  prefixConsistent: boolean;
  sessionDetailId: string | null;
};

function resolveDeps(deps?: TranscriptServiceDeps): ResolvedDeps {
  return {
    s3: deps?.s3 ?? defaultS3Port,
    now: deps?.now ?? Date.now,
    rateLimiter: deps?.rateLimiter ?? transcriptRateLimiter,
  };
}

/**
 * Run the advisory-locked write transaction shared by `planSync`, `complete`,
 * and `markPermanentlySkipped`, with the one `PLAN_TX_TIMEOUT_MS` bound and the
 * identical fail-safe tail: on any thrown error, log it (keyed by file identity
 * + a per-caller `label`) and degrade to an `UpstreamUnavailable` result rather
 * than surfacing a raw exception. The caller keeps its own pre-tx work (auth,
 * idempotency, S3) outside this wrapper.
 *
 * ISS-7097: the tail degrades to `UpstreamUnavailable` (503), NOT `StaleUpload`
 * (409) as it used to. A thrown error says the server could not answer; it says
 * nothing about the caller's state being stale, and the desktop spends per-row
 * retry budget on a 409. The deliberate 409s are the ones the callee returns
 * explicitly.
 *
 * ISS-8689: a thrown `TranscriptStorageNotConfiguredError` degrades to the
 * longer-backoff `UpstreamNotConfigured` instead — same 503 family, but only
 * an admin fixing configuration resolves it, so the retry cadence differs.
 */
async function runTranscriptTx<T>(
  identity: FileIdentity,
  label: string,
  fn: (tx: TransactionClient) => Promise<Result<T, TranscriptSyncErrorReason>>
): Promise<Result<T, TranscriptSyncErrorReason>> {
  try {
    return await withDb.tx(fn, { timeout: PLAN_TX_TIMEOUT_MS });
  } catch (error) {
    log.warn(label, {
      computeTargetId: identity.computeTargetId,
      externalSessionId: identity.externalSessionId,
      fileKey: identity.fileKey,
      error,
    });
    // ISS-7097: this arm catches whatever the transaction threw — a
    // `PLAN_TX_TIMEOUT_MS` expiry, an unreachable database, an unexpected
    // error. None of that is a statement about the CALLER's state, which is
    // what a 409 `StaleUpload` asserts, and asserting it made every such
    // failure spend one of the desktop's five per-row retry attempts. The
    // deliberate, still-409 stale cases are the ones raised explicitly below
    // (a superseded uploadId, an empty part list, a verification mismatch).
    return Result.err(
      classifyUpstreamFailure(error) ??
        TranscriptSyncErrorReason.UpstreamUnavailable
    );
  }
}

/** Resolve the SessionDetail artifact id for a session, if it exists yet. */
async function resolveSessionDetailId(
  tx: TransactionClient,
  computeTargetId: string,
  externalSessionId: string
): Promise<string | null> {
  // ISS-8069: the ingest stores this column through `projectIndexKey`, so
  // resolving it from the raw wire id would miss the row for exactly the
  // sessions whose id had to be projected — a permanently orphaned transcript
  // instead of a linked one.
  //
  // ISS-8286: the PROJECTED key alone is not enough either. The ingest
  // deliberately keeps an existing row on the key it is already stored under
  // (`findSessionDetailByAnyIndexKey` / `resolveStoredIndexKey`), so a session
  // whose id was over the budget but inside the 2704-byte btree tuple is sitting
  // under its RAW value right now. Probing only the projected key leaves plan,
  // complete and skip unable to link that session's transcript, and the orphan
  // backfill repeats the same miss. The shared probe resolves both, projected
  // first, and degenerates to the single lookup this replaced for every id
  // inside the budget — which is all of them in practice.
  const match = await resolveByAnyIndexKey(externalSessionId, (candidate) =>
    tx.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId: candidate,
        },
      },
      select: { artifactId: true },
    })
  );
  return match?.record.artifactId ?? null;
}

async function loadPlanContext(
  tx: TransactionClient,
  request: TranscriptSyncPlanRequest,
  row: TranscriptSyncRow | null
): Promise<PlanContext> {
  const syncedOffset = row ? Number(row.syncedByteOffset) : 0;
  const storedEtag = row?.storedEtag ?? null;
  const storedObjectSha = row?.rawSha256 ?? null;
  const sessionDetailId =
    row?.sessionDetailId ??
    (await resolveSessionDetailId(
      tx,
      request.computeTargetId,
      request.externalSessionId
    ));
  // Prefix is trustworthy for append only when the client's prefix hash matches
  // the stored object hash (i.e. no compaction/rewrite happened).
  const prefixConsistent =
    request.prefixSha256 != null &&
    storedObjectSha != null &&
    storedEtag != null &&
    request.prefixSha256 === storedObjectSha &&
    request.planEndOffset >= syncedOffset;
  return { syncedOffset, storedEtag, prefixConsistent, sessionDetailId };
}

function planResponseSyncedOffset(
  decision: SyncPlanDecision,
  ctx: PlanContext
): number {
  // Append reuses the copied prefix; a full re-upload starts from zero.
  return decision.mode === "multipartAppend" ? ctx.syncedOffset : 0;
}

/**
 * Re-sign the still-missing parts of an in-flight multipart upload. Returns
 * `null` when the already-uploaded parts no longer match the intended layout
 * (the file changed) — the caller then aborts and re-plans from scratch.
 */
async function resumeMultipart(params: {
  s3: TranscriptS3Port;
  objectKey: string;
  uploadId: string;
  decision: SyncPlanDecision;
  storedEtag: string | null;
}): Promise<{ copiedPartEtag?: string; parts: TranscriptUploadPart[] } | null> {
  const { s3, objectKey, uploadId, decision, storedEtag } = params;
  if (decision.mode === "fullPut") {
    return null;
  }

  const intended = new Map<
    number,
    { byteLength: number; offset: number; kind: "copy" | "put" }
  >();
  if (decision.mode === "multipartAppend") {
    intended.set(1, {
      byteLength: decision.copyByteLength,
      offset: 0,
      kind: "copy",
    });
  }
  for (const part of decision.parts) {
    intended.set(part.partNumber, {
      byteLength: part.byteLength,
      offset: part.offset,
      kind: "put",
    });
  }

  const uploaded = await s3.listParts({ key: objectKey, uploadId });
  const uploadedByNumber = new Map(
    uploaded.map((part) => [part.partNumber, part])
  );
  for (const part of uploaded) {
    const match = intended.get(part.partNumber);
    if (!match || (part.size != null && part.size !== match.byteLength)) {
      return null;
    }
  }

  let copiedPartEtag: string | undefined;
  const missing: TranscriptUploadPart[] = [];
  for (const [partNumber, part] of intended) {
    const already = uploadedByNumber.get(partNumber);
    if (part.kind === "copy") {
      if (already) {
        copiedPartEtag = already.etag;
        continue;
      }
      if (!storedEtag) {
        return null;
      }
      const copy = await s3.copyPart({
        key: objectKey,
        uploadId,
        partNumber,
        sourceKey: objectKey,
        ifMatchEtag: storedEtag,
      });
      copiedPartEtag = copy.etag;
      continue;
    }
    if (!already) {
      const url = await s3.presignUploadPart({
        key: objectKey,
        uploadId,
        partNumber,
      });
      missing.push({
        partNumber,
        offset: part.offset,
        byteLength: part.byteLength,
        url,
      });
    }
  }
  return { copiedPartEtag, parts: missing };
}

/** Presign the PUT parts of a decision (part numbers already assigned). */
function presignParts(
  s3: TranscriptS3Port,
  objectKey: string,
  uploadId: string,
  decision: Extract<
    SyncPlanDecision,
    { mode: "multipartFresh" | "multipartAppend" }
  >
): Promise<TranscriptUploadPart[]> {
  return Promise.all(
    decision.parts.map(async (part) => ({
      partNumber: part.partNumber,
      offset: part.offset,
      byteLength: part.byteLength,
      url: await s3.presignUploadPart({
        key: objectKey,
        uploadId,
        partNumber: part.partNumber,
      }),
    }))
  );
}

/**
 * Try to resume the row's in-flight multipart upload. Returns a plan response
 * on success, or `null` after aborting a stale / diverged upload so the caller
 * builds a fresh plan.
 */
async function attemptResume(params: {
  tx: TransactionClient;
  s3: TranscriptS3Port;
  now: () => number;
  request: TranscriptSyncPlanRequest;
  row: TranscriptSyncRow;
  pendingUploadId: string;
  objectKey: string;
  ctx: PlanContext;
}): Promise<PlanResult | null> {
  const { tx, s3, now, request, row, pendingUploadId, objectKey, ctx } = params;
  const ageMs = row.pendingUploadStartedAt
    ? now() - row.pendingUploadStartedAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (ageMs <= STALE_UPLOAD_MS) {
    const decision = decideSyncPlan({
      planEndOffset: request.planEndOffset,
      syncedOffset: ctx.syncedOffset,
      prefixConsistent: ctx.prefixConsistent,
    });
    // S3 errors here (transient, or the upload already reclaimed by the bucket's
    // 7-day incomplete-MPU lifecycle rule) must NOT unwind the transaction and
    // leave pendingUploadId pointing at a dead upload forever. Treat any failure
    // as "this upload is unusable" and fall through to a fresh plan.
    const resumed = await resumeMultipart({
      s3,
      objectKey,
      uploadId: pendingUploadId,
      decision,
      storedEtag: ctx.storedEtag,
    }).catch(() => null);
    if (resumed) {
      await tx.sessionTranscript.update({
        where: { id: row.id },
        data: { lastObservedAt: new Date(now()) },
        select: { id: true },
      });
      return Result.ok({
        mode: "multipart",
        uploadId: pendingUploadId,
        copiedPartEtag: resumed.copiedPartEtag,
        parts: resumed.parts,
        planEndOffset: request.planEndOffset,
        syncedByteOffset: planResponseSyncedOffset(decision, ctx),
        storedEtag: ctx.storedEtag,
      });
    }
  }

  // Abort the unusable upload but ignore errors (already gone / transient) so a
  // dead uploadId can't wedge the row — buildFreshPlan overwrites it next.
  await s3
    .abortMultipartUpload({ key: objectKey, uploadId: pendingUploadId })
    .catch(() => undefined);
  return null;
}

/** Build a fresh upload plan (fullPut or multipart) and persist the in-flight row. */
async function buildFreshPlan(params: {
  tx: TransactionClient;
  s3: TranscriptS3Port;
  now: () => number;
  organizationId: string;
  request: TranscriptSyncPlanRequest;
  objectKey: string;
  ctx: PlanContext;
}): Promise<PlanResult> {
  const { tx, s3, now, organizationId, request, objectKey, ctx } = params;
  const decision = decideSyncPlan({
    planEndOffset: request.planEndOffset,
    syncedOffset: ctx.syncedOffset,
    prefixConsistent: ctx.prefixConsistent,
  });

  // Typed so the `uploadStatus` literal is validated against the contract by the
  // field type — no `as const`/`satisfies` needed, and a typo is a compile error.
  const persistBase: Omit<
    TranscriptPlanRowData,
    "pendingUploadId" | "pendingUploadStartedAt"
  > = {
    organizationId,
    sourceHarness: request.sourceHarness,
    objectStorageKey: objectKey,
    uploadStatus: TranscriptUploadStatus.Uploading,
    sourcePathHash: request.sourcePathHash,
    sourceMtime:
      request.sourceMtime === undefined ? null : new Date(request.sourceMtime),
    lastObservedAt: new Date(now()),
    sessionDetailId: ctx.sessionDetailId,
  };

  if (decision.mode === "fullPut") {
    const url = await s3.presignPutObject({
      key: objectKey,
      checksumCrc64Nvme: request.crc64nvme,
    });
    await upsertPlanRow(tx, request, {
      ...persistBase,
      pendingUploadId: null,
      pendingUploadStartedAt: null,
    });
    return Result.ok({
      mode: "fullPut",
      url,
      planEndOffset: request.planEndOffset,
      syncedByteOffset: 0,
      storedEtag: ctx.storedEtag,
    });
  }

  const { uploadId } = await s3.createMultipartUpload(objectKey);
  let copiedPartEtag: string | undefined;
  if (decision.mode === "multipartAppend") {
    if (!ctx.storedEtag) {
      await s3.abortMultipartUpload({ key: objectKey, uploadId });
      return Result.err(TranscriptSyncErrorReason.StaleUpload);
    }
    const copy = await s3.copyPart({
      key: objectKey,
      uploadId,
      partNumber: 1,
      sourceKey: objectKey,
      ifMatchEtag: ctx.storedEtag,
    });
    copiedPartEtag = copy.etag;
  }
  const parts = await presignParts(s3, objectKey, uploadId, decision);
  await upsertPlanRow(tx, request, {
    ...persistBase,
    pendingUploadId: uploadId,
    pendingUploadStartedAt: new Date(now()),
  });
  return Result.ok({
    mode: "multipart",
    uploadId,
    copiedPartEtag,
    parts,
    planEndOffset: request.planEndOffset,
    syncedByteOffset: planResponseSyncedOffset(decision, ctx),
    storedEtag: ctx.storedEtag,
  });
}

/**
 * Complete the S3 multipart upload with the full-object checksum + If-Match
 * guard. Returns a failure `Result` (already marked failed + aborted) or `null`
 * to continue to verification.
 */
async function completeMultipartStep(params: {
  tx: TransactionClient;
  s3: TranscriptS3Port;
  row: TranscriptSyncRow;
  request: TranscriptCompleteRequest;
  objectKey: string;
  /** Already bound to the row's pending upload by `multipartPlanMismatch`. */
  uploadId: string;
}): Promise<CompleteResult | null> {
  const { tx, s3, row, request, objectKey, uploadId } = params;
  const parts = await s3.listParts({ key: objectKey, uploadId });
  if (parts.length === 0) {
    await markFailed(tx, row.id);
    return Result.err(TranscriptSyncErrorReason.StaleUpload);
  }
  try {
    await s3.completeMultipartUpload({
      key: objectKey,
      uploadId,
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
        checksumCrc64Nvme: part.checksumCrc64Nvme,
      })),
      checksumCrc64Nvme: request.crc64nvme,
      // Guard against a concurrent overwrite of the object we planned against.
      ifMatchEtag: row.storedEtag ?? undefined,
    });
  } catch (error) {
    await failAndAbort(tx, row.id, s3, objectKey, uploadId);
    log.warn("transcript complete: multipart completion rejected", {
      computeTargetId: request.computeTargetId,
      externalSessionId: request.externalSessionId,
      fileKey: request.fileKey,
      error,
    });
    // ISS-7097: this catch RETURNS rather than throws, so it never reaches
    // `runTranscriptTx`'s reclassifying tail — it has to make the same call
    // itself. S3 rejects here for two unrelated families: the plan really is
    // stale (the `If-Match` etag moved, the CRC64NVME disagrees, the upload was
    // already aborted), or S3 itself is unavailable (a 5xx, a `SlowDown`
    // throttle, a network timeout). Only the first is a statement about this
    // row; folding the second into a 409 is the precise bug ISS-7097 exists to
    // fix, reproduced one call path over.
    //
    // ISS-8689: a `TranscriptStorageNotConfiguredError` here carries no
    // `$metadata` (it throws before any S3 call), so it would otherwise fall
    // through to `StaleUpload` and burn the same per-row retry budget —
    // classified first, ahead of the S3-rejection check.
    return Result.err(
      classifyUpstreamFailure(error) ?? TranscriptSyncErrorReason.StaleUpload
    );
  }
  return null;
}

/** Verify the stored object against the plan window + checksum, then persist. */
async function verifyAndPersist(params: {
  tx: TransactionClient;
  s3: TranscriptS3Port;
  now: () => number;
  row: TranscriptSyncRow;
  request: TranscriptCompleteRequest;
  objectKey: string;
}): Promise<CompleteResult> {
  const { tx, s3, now, row, request, objectKey } = params;
  const head = await s3.headObject(objectKey);
  // AC2: the object's S3-verified full-object CRC64NVME must be present AND equal
  // the client's checksum. A missing checksum is NOT accepted as success —
  // otherwise verification silently degrades to a byte-count-only check.
  const checksumOk = head?.checksumCrc64Nvme === request.crc64nvme;
  if (!head || head.byteSize !== request.planEndOffset || !checksumOk) {
    await failAndAbort(
      tx,
      row.id,
      s3,
      objectKey,
      request.mode === "multipart" ? request.uploadId : undefined
    );
    return Result.err(TranscriptSyncErrorReason.StaleUpload);
  }

  const sessionDetailId =
    row.sessionDetailId ??
    (await resolveSessionDetailId(
      tx,
      request.computeTargetId,
      request.externalSessionId
    ));

  await tx.sessionTranscript.update({
    where: { id: row.id },
    data: {
      uploadStatus: TranscriptUploadStatus.Uploaded,
      storedEtag: head.etag ?? null,
      rawSha256: request.sha256,
      // Verified equal to head.checksumCrc64Nvme by the checksumOk guard above.
      crc64nvme: request.crc64nvme,
      rawByteSize: BigInt(request.planEndOffset),
      syncedByteOffset: BigInt(request.planEndOffset),
      uploadedAt: new Date(now()),
      pendingUploadId: null,
      pendingUploadStartedAt: null,
      // FEA-3489 (review): a completed upload is `available`, so it must never
      // retain a `permanentFailureReason`. `upsertPlanRow` already clears it on
      // re-open; clearing it here too guarantees the terminal reason is gone at
      // the point availability flips, even if the row reached `complete` without
      // a fresh plan step.
      permanentFailureReason: null,
      sessionDetailId,
    },
    select: { id: true },
  });

  return Result.ok({
    status: "uploaded",
    syncedByteOffset: request.planEndOffset,
    storedEtag: head.etag ?? null,
    sessionDetailId,
  });
}

export const transcriptSyncService = {
  /**
   * Plan a sync: authorize, decide the upload shape, orchestrate the S3
   * multipart setup, and record the in-flight state. Everything after the
   * idempotency fast-path runs under a per-file advisory lock so concurrent
   * syncs for the same file cannot create conflicting uploads.
   */
  async planSync(
    input: PlanSyncInput,
    recordWrite?: RecordWriteInTransaction<TranscriptSyncPlanResponse>
  ): Promise<PlanResult> {
    const { request } = input;
    const deps = resolveDeps(input.deps);
    const { s3, now } = deps;

    const authz = await authorizeTranscriptRequest(input, deps);
    if ("error" in authz) {
      return Result.err(authz.error);
    }
    const { objectKey } = authz;

    // Idempotency (PRD FR5): identical uploaded content is a no-op. Checked
    // before the advisory lock (fast path for the common no-change case).
    const existing = await withDb((db) =>
      db.sessionTranscript.findUnique({
        where: identityWhere(request),
        select: TRANSCRIPT_SYNC_ROW_SELECT,
      })
    );
    if (existing && isUploadedMatch(existing, request.sha256)) {
      return noopResult(existing);
    }

    return runTranscriptTx(
      request,
      "transcript sync-plan failed",
      async (tx): Promise<PlanResult> => {
        const planned = await planUnderLock(tx, { input, s3, now, objectKey });
        // ISS-12552: the receipt goes in the plan's own
        // transaction, after the S3 multipart setup. A rollback after S3
        // acted leaves at most an orphaned incomplete upload, which the
        // resume path and the bucket's incomplete-upload lifecycle rule
        // already reclaim.
        if (planned.ok) {
          await recordWrite?.(tx, planned.value);
        }
        return planned;
      }
    );
  },

  /**
   * Finalize a planned upload: complete the multipart upload (with the
   * full-object CRC64NVME and If-Match guard), verify byte size + checksum
   * against S3, then advance server state in one transaction (invariant 1).
   */
  async complete(
    input: CompleteInput,
    recordWrite?: RecordWriteInTransaction<TranscriptCompleteWrite>
  ): Promise<CompleteResult> {
    const { request } = input;
    const deps = resolveDeps(input.deps);
    const { s3, now } = deps;

    const authz = await authorizeTranscriptRequest(input, deps);
    if ("error" in authz) {
      return Result.err(authz.error);
    }
    const { objectKey } = authz;

    return runTranscriptTx(
      request,
      "transcript complete failed",
      async (tx): Promise<CompleteResult> => {
        await tx.$executeRaw(advisoryLockKeySql(lockKey(request)));

        const row = await tx.sessionTranscript.findUnique({
          where: identityWhere(request),
          select: TRANSCRIPT_SYNC_ROW_SELECT,
        });
        if (!row) {
          return Result.err(TranscriptSyncErrorReason.StaleUpload);
        }
        // Idempotent completion (client retried a verified upload).
        if (isUploadedMatch(row, request.sha256)) {
          await recordWrite?.(tx, { changed: false });
          return Result.ok({
            status: "uploaded",
            syncedByteOffset: Number(row.syncedByteOffset),
            storedEtag: row.storedEtag,
            sessionDetailId: row.sessionDetailId,
          });
        }

        const mismatch = multipartPlanMismatch(row, request);
        if (mismatch) {
          return mismatch;
        }
        // ISS-12552: the receipt goes in BEFORE any S3 call, so
        // a receipt that cannot be stored fails while nothing has acted yet.
        // From here every path either writes the row (completed, or marked
        // failed) and commits, or throws and rolls the receipt back with it,
        // so the receipt describes the row write, never the S3 outcome.
        await recordWrite?.(tx, { changed: true });

        if (request.mode === "multipart" && request.uploadId) {
          const failure = await completeMultipartStep({
            tx,
            s3,
            row,
            request,
            objectKey,
            uploadId: request.uploadId,
          });
          if (failure) {
            return failure;
          }
        }

        return verifyAndPersist({ tx, s3, now, row, request, objectKey });
      }
    );
  },

  /**
   * Record a terminal, non-retryable skip (FEA-3476 / PRD-536 D7). The desktop
   * calls this once when a file transitions to a permanent dead state (e.g. it
   * exceeds the local size cap) so the cloud stops representing it as "syncing"
   * and the read path derives `failedPermanent`. No bytes/checksums — this only
   * writes the terminal `skipped` status + reason.
   *
   * Ordering-safe: if a verified upload already exists for this file
   * (`uploadStatus = uploaded`), the skip is a NO-OP — a good archive must never
   * be masked by a late skip signal for a since-grown/replaced file. Idempotent
   * on an already-`skipped` row (re-sends just refresh the reason/timestamp).
   */
  async markPermanentlySkipped(
    input: SkipInput,
    recordWrite?: RecordWriteInTransaction<TranscriptSkipWrite>
  ): Promise<SkipResult> {
    const { request } = input;
    const deps = resolveDeps(input.deps);
    const { now } = deps;

    const authz = await authorizeTranscriptRequest(input, deps);
    if ("error" in authz) {
      return Result.err(authz.error);
    }
    const { objectKey } = authz;

    return runTranscriptTx(
      request,
      "transcript skip failed",
      async (tx): Promise<SkipResult> => {
        await tx.$executeRaw(advisoryLockKeySql(lockKey(request)));

        const existing = await tx.sessionTranscript.findUnique({
          where: identityWhere(request),
          select: TRANSCRIPT_SYNC_ROW_SELECT,
        });

        // A verified archive wins: never let a late skip hide readable bytes.
        if (
          existing &&
          existing.uploadStatus === TranscriptUploadStatus.Uploaded
        ) {
          await recordWrite?.(tx, { skipped: false });
          return Result.ok({
            status: TranscriptUploadStatus.Uploaded,
            permanentFailureReason: request.reason,
            sessionDetailId: existing.sessionDetailId,
          });
        }

        const sessionDetailId =
          existing?.sessionDetailId ??
          (await resolveSessionDetailId(
            tx,
            request.computeTargetId,
            request.externalSessionId
          ));
        const nowDate = new Date(now());
        // ISS-4820 item 2: a RECOVERABLE reason must not overwrite an existing
        // HARD terminal reason. The desktop releases its per-file lock after a
        // 30s abort, so a changed projection can requeue and settle a NEWER hard
        // reason here while a stale in-flight recoverable request is still
        // finishing. That late write used to clobber the hard reason and
        // resurrect a dead row into "syncing forever". Precedence, not
        // last-writer-wins.
        const effectiveReason = resolveSkipReasonPrecedence(
          existing?.uploadStatus,
          existing?.permanentFailureReason,
          request.reason
        );

        await tx.sessionTranscript.upsert({
          where: identityWhere(request),
          create: {
            organizationId: input.organizationId,
            computeTargetId: request.computeTargetId,
            // ISS-8125: the same projected identity `identityWhere` above
            // matched on. Storing the raw pair here would write a row this
            // request's own `where` could never find again.
            ...projectedIdentityColumns(request),
            sourceHarness: request.sourceHarness,
            objectStorageKey: objectKey,
            uploadStatus: TranscriptUploadStatus.Skipped,
            permanentFailureReason: request.reason,
            lastObservedAt: nowDate,
            sessionDetailId,
            // No in-flight upload to abort — this file is deterministically
            // skipped, so clear any planning cursor state.
            pendingUploadId: null,
            pendingUploadStartedAt: null,
          },
          update: {
            uploadStatus: TranscriptUploadStatus.Skipped,
            permanentFailureReason: effectiveReason,
            lastObservedAt: nowDate,
            pendingUploadId: null,
            pendingUploadStartedAt: null,
            ...(sessionDetailId ? { sessionDetailId } : {}),
          },
          select: { id: true },
        });
        await recordWrite?.(tx, { skipped: true });

        return Result.ok({
          // Report what was PERSISTED, not what was requested: when precedence
          // preserved the existing hard reason, echoing `request.reason` would
          // tell the desktop the row is recoverable when it is not.
          //
          // ISS-4820 (codex review): precedence can preserve a reason this build
          // does not recognize (an API rolled back behind a desktop that wrote a
          // newer label). The row keeps that label verbatim, but the WIRE echo is
          // narrowed to the shared enum — an unnameable reason degrades to `null`,
          // which every read path already classifies as the conservative HARD
          // `failedPermanent`. Never widened to a free string: a client older than
          // the label would reject the whole response and re-drive the skip.
          status: TranscriptUploadStatus.Skipped,
          permanentFailureReason: toKnownTranscriptSkipReason(effectiveReason),
          sessionDetailId,
        });
      }
    );
  },
};

/**
 * Classify a caught error into its 503 reason, or `null` when it is neither —
 * the two call sites (`runTranscriptTx`'s catch-all and `completeMultipartStep`'s
 * S3-completion catch) each keep their own default for the `null` case, since
 * an unrecognized error means something different at each site. Config-unset
 * is checked first: it throws before any request reaches S3, so it can never
 * also carry the S3-rejection shape, but ordering the check this way keeps the
 * precedence explicit rather than incidental.
 */
function classifyUpstreamFailure(
  error: unknown
): TranscriptSyncErrorReason | null {
  if (isStorageNotConfiguredError(error)) {
    return TranscriptSyncErrorReason.UpstreamNotConfigured;
  }
  if (isUpstreamS3Rejection(error)) {
    return TranscriptSyncErrorReason.UpstreamUnavailable;
  }
  return null;
}

/** The locked half of a sync plan: re-check, resume, or plan afresh. */
async function planUnderLock(
  tx: TransactionClient,
  params: {
    input: PlanSyncInput;
    s3: TranscriptS3Port;
    now: () => number;
    objectKey: string;
  }
): Promise<PlanResult> {
  const { input, s3, now, objectKey } = params;
  const { request } = input;
  await tx.$executeRaw(advisoryLockKeySql(lockKey(request)));

  const row = await tx.sessionTranscript.findUnique({
    where: identityWhere(request),
    select: TRANSCRIPT_SYNC_ROW_SELECT,
  });
  if (row && isUploadedMatch(row, request.sha256)) {
    return noopResult(row);
  }

  const ctx = await loadPlanContext(tx, request, row);

  if (row?.pendingUploadId) {
    const resumed = await attemptResume({
      tx,
      s3,
      now,
      request,
      row,
      pendingUploadId: row.pendingUploadId,
      objectKey,
      ctx,
    });
    if (resumed) {
      return resumed;
    }
  }

  return buildFreshPlan({
    tx,
    s3,
    now,
    organizationId: input.organizationId,
    request,
    objectKey,
    ctx,
  });
}

/**
 * A multipart completion that cannot proceed against the row, answered
 * without touching it: no upload id, or a newer sync-plan superseded this
 * one (the newer in-flight plan's state is preserved; the stale client just
 * re-plans). Null when the completion may proceed.
 */
function multipartPlanMismatch(
  row: TranscriptSyncRow,
  request: TranscriptCompleteRequest
): CompleteResult | null {
  if (request.mode !== "multipart") {
    return null;
  }
  if (!request.uploadId) {
    return Result.err(TranscriptSyncErrorReason.InvalidRequest);
  }
  if (request.uploadId !== row.pendingUploadId) {
    return Result.err(TranscriptSyncErrorReason.StaleUpload);
  }
  return null;
}
