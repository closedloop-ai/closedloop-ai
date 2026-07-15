import {
  type TranscriptCompleteRequest,
  type TranscriptCompleteResponse,
  type TranscriptSyncPlanRequest,
  type TranscriptSyncPlanResponse,
  type TranscriptUploadPart,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { Result, type StatusCode } from "@repo/api/src/types/result";
import {
  abortTranscriptMultipartUpload,
  completeTranscriptMultipartUpload,
  copyTranscriptPart,
  createTranscriptMultipartUpload,
  headTranscriptObject,
  listTranscriptParts,
  presignTranscriptPutObject,
  presignTranscriptUploadPart,
} from "@repo/aws";
import {
  type SessionTranscript,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  decideSyncPlan,
  resolveTranscriptObjectKey,
  type SyncPlanDecision,
} from "./transcript-plan";
import {
  type TranscriptRateLimiter,
  transcriptRateLimiter,
} from "./transcript-rate-limit";

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

/** Backend-only outcomes the routes map to HTTP responses. */
export const TranscriptSyncErrorReason = {
  Forbidden: "forbidden",
  RateLimited: "rate_limited",
  InvalidRequest: "invalid_request",
  /** ETag moved / checksum mismatch / unknown upload — client re-plans. */
  StaleUpload: "stale_upload",
  Internal: "internal",
} as const;
export type TranscriptSyncErrorReason =
  (typeof TranscriptSyncErrorReason)[keyof typeof TranscriptSyncErrorReason];

type PlanResult = Result<
  TranscriptSyncPlanResponse,
  TranscriptSyncErrorReason | StatusCode
>;
type CompleteResult = Result<
  TranscriptCompleteResponse,
  TranscriptSyncErrorReason | StatusCode
>;

/** S3 seam, injectable so unit tests run against a fake instead of real S3. */
export type TranscriptS3Port = {
  createMultipartUpload: typeof createTranscriptMultipartUpload;
  copyPart: typeof copyTranscriptPart;
  presignUploadPart: typeof presignTranscriptUploadPart;
  presignPutObject: typeof presignTranscriptPutObject;
  listParts: typeof listTranscriptParts;
  completeMultipartUpload: typeof completeTranscriptMultipartUpload;
  headObject: typeof headTranscriptObject;
  abortMultipartUpload: typeof abortTranscriptMultipartUpload;
};

const defaultS3Port: TranscriptS3Port = {
  createMultipartUpload: createTranscriptMultipartUpload,
  copyPart: copyTranscriptPart,
  presignUploadPart: presignTranscriptUploadPart,
  presignPutObject: presignTranscriptPutObject,
  listParts: listTranscriptParts,
  completeMultipartUpload: completeTranscriptMultipartUpload,
  headObject: headTranscriptObject,
  abortMultipartUpload: abortTranscriptMultipartUpload,
};

export type TranscriptServiceDeps = {
  s3?: TranscriptS3Port;
  now?: () => number;
  rateLimiter?: TranscriptRateLimiter;
};

type AuthContext = {
  organizationId: string;
  userId: string;
  clerkUserId: string | null;
};

type PlanSyncInput = AuthContext & {
  request: TranscriptSyncPlanRequest;
  deps?: TranscriptServiceDeps;
};

type CompleteInput = AuthContext & {
  request: TranscriptCompleteRequest;
  deps?: TranscriptServiceDeps;
};

type ResolvedDeps = {
  s3: TranscriptS3Port;
  now: () => number;
  rateLimiter: TranscriptRateLimiter;
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

type FileIdentity = {
  computeTargetId: string;
  externalSessionId: string;
  fileKey: string;
};

function lockKey(identity: FileIdentity): string {
  return `transcript:${identity.computeTargetId}:${identity.externalSessionId}:${identity.fileKey}`;
}

function identityWhere(identity: FileIdentity) {
  return {
    computeTargetId_externalSessionId_fileKey: {
      computeTargetId: identity.computeTargetId,
      externalSessionId: identity.externalSessionId,
      fileKey: identity.fileKey,
    },
  };
}

/**
 * Shared front door for both routes: verify compute-target ownership FIRST,
 * then rate-limit keyed on the now-verified target (so an unauthorized caller
 * can't drain another tenant's abuse-control budget), then resolve the object
 * key. Returns the object key on success or a typed error reason.
 */
async function authorizeTranscriptRequest(
  input: AuthContext & { request: FileIdentity },
  deps: ResolvedDeps
): Promise<{ objectKey: string } | { error: TranscriptSyncErrorReason }> {
  const { request } = input;
  const target = await computeTargetsService.findOwnedById(
    request.computeTargetId,
    input.organizationId,
    input.userId,
    input.clerkUserId
  );
  if (!target) {
    return { error: TranscriptSyncErrorReason.Forbidden };
  }
  if (!deps.rateLimiter.attempt(request.computeTargetId, deps.now())) {
    return { error: TranscriptSyncErrorReason.RateLimited };
  }
  const objectKey = resolveTranscriptObjectKey({
    organizationId: input.organizationId,
    computeTargetId: request.computeTargetId,
    externalSessionId: request.externalSessionId,
    fileKey: request.fileKey,
  });
  return { objectKey };
}

/** Resolve the SessionDetail artifact id for a session, if it exists yet. */
async function resolveSessionDetailId(
  tx: TransactionClient,
  computeTargetId: string,
  externalSessionId: string
): Promise<string | null> {
  const detail = await tx.sessionDetail.findUnique({
    where: {
      computeTargetId_externalSessionId: { computeTargetId, externalSessionId },
    },
    select: { artifactId: true },
  });
  return detail?.artifactId ?? null;
}

async function loadPlanContext(
  tx: TransactionClient,
  request: TranscriptSyncPlanRequest,
  row: SessionTranscript | null
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
  row: SessionTranscript;
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
    sourceMtime: new Date(request.sourceMtime),
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
  row: SessionTranscript;
  request: TranscriptCompleteRequest;
  objectKey: string;
}): Promise<CompleteResult | null> {
  const { tx, s3, row, request, objectKey } = params;
  if (!request.uploadId) {
    return Result.err(TranscriptSyncErrorReason.InvalidRequest);
  }
  // Bind completion to the plan currently on the row: if a newer sync-plan
  // superseded this uploadId, refuse — without touching the row, so the newer
  // in-flight plan's state is preserved (the stale client just re-plans).
  if (request.uploadId !== row.pendingUploadId) {
    return Result.err(TranscriptSyncErrorReason.StaleUpload);
  }
  const parts = await s3.listParts({
    key: objectKey,
    uploadId: request.uploadId,
  });
  if (parts.length === 0) {
    await markFailed(tx, row.id);
    return Result.err(TranscriptSyncErrorReason.StaleUpload);
  }
  try {
    await s3.completeMultipartUpload({
      key: objectKey,
      uploadId: request.uploadId,
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
    await failAndAbort(tx, row.id, s3, objectKey, request.uploadId);
    log.warn("transcript complete: multipart completion rejected", {
      computeTargetId: request.computeTargetId,
      externalSessionId: request.externalSessionId,
      fileKey: request.fileKey,
      error,
    });
    return Result.err(TranscriptSyncErrorReason.StaleUpload);
  }
  return null;
}

/** Verify the stored object against the plan window + checksum, then persist. */
async function verifyAndPersist(params: {
  tx: TransactionClient;
  s3: TranscriptS3Port;
  now: () => number;
  row: SessionTranscript;
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
      sessionDetailId,
    },
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
  async planSync(input: PlanSyncInput): Promise<PlanResult> {
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
      db.sessionTranscript.findUnique({ where: identityWhere(request) })
    );
    if (existing && isUploadedMatch(existing, request.sha256)) {
      return noopResult(existing);
    }

    try {
      return await withDb.tx(
        async (tx): Promise<PlanResult> => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(request)}))`;

          const row = await tx.sessionTranscript.findUnique({
            where: identityWhere(request),
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
        },
        { timeout: PLAN_TX_TIMEOUT_MS }
      );
    } catch (error) {
      log.warn("transcript sync-plan failed", {
        computeTargetId: request.computeTargetId,
        externalSessionId: request.externalSessionId,
        fileKey: request.fileKey,
        error,
      });
      return Result.err(TranscriptSyncErrorReason.StaleUpload);
    }
  },

  /**
   * Finalize a planned upload: complete the multipart upload (with the
   * full-object CRC64NVME and If-Match guard), verify byte size + checksum
   * against S3, then advance server state in one transaction (invariant 1).
   */
  async complete(input: CompleteInput): Promise<CompleteResult> {
    const { request } = input;
    const deps = resolveDeps(input.deps);
    const { s3, now } = deps;

    const authz = await authorizeTranscriptRequest(input, deps);
    if ("error" in authz) {
      return Result.err(authz.error);
    }
    const { objectKey } = authz;

    try {
      return await withDb.tx(
        async (tx): Promise<CompleteResult> => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(request)}))`;

          const row = await tx.sessionTranscript.findUnique({
            where: identityWhere(request),
          });
          if (!row) {
            return Result.err(TranscriptSyncErrorReason.StaleUpload);
          }
          // Idempotent completion (client retried a verified upload).
          if (isUploadedMatch(row, request.sha256)) {
            return Result.ok({
              status: "uploaded",
              syncedByteOffset: Number(row.syncedByteOffset),
              storedEtag: row.storedEtag,
              sessionDetailId: row.sessionDetailId,
            });
          }

          if (request.mode === "multipart") {
            const failure = await completeMultipartStep({
              tx,
              s3,
              row,
              request,
              objectKey,
            });
            if (failure) {
              return failure;
            }
          }

          return verifyAndPersist({ tx, s3, now, row, request, objectKey });
        },
        { timeout: PLAN_TX_TIMEOUT_MS }
      );
    } catch (error) {
      log.warn("transcript complete failed", {
        computeTargetId: request.computeTargetId,
        externalSessionId: request.externalSessionId,
        fileKey: request.fileKey,
        error,
      });
      return Result.err(TranscriptSyncErrorReason.StaleUpload);
    }
  },
};

function isUploadedMatch(row: SessionTranscript, sha256: string): boolean {
  return (
    row.uploadStatus === TranscriptUploadStatus.Uploaded &&
    row.rawSha256 === sha256
  );
}

function noopResult(row: SessionTranscript): PlanResult {
  return Result.ok({
    mode: "noop",
    syncedByteOffset: Number(row.syncedByteOffset),
    storedEtag: row.storedEtag,
  });
}

type TranscriptPlanRowData = {
  organizationId: string;
  sourceHarness: string;
  objectStorageKey: string;
  uploadStatus: TranscriptUploadStatus;
  sourcePathHash: string;
  sourceMtime: Date;
  lastObservedAt: Date;
  sessionDetailId: string | null;
  pendingUploadId: string | null;
  pendingUploadStartedAt: Date | null;
};

/** Upsert the in-flight row: create with lifecycle timestamps, or update the
 * mutable planning columns without touching verified state. */
function upsertPlanRow(
  tx: TransactionClient,
  request: TranscriptSyncPlanRequest,
  data: TranscriptPlanRowData
): Promise<unknown> {
  return tx.sessionTranscript.upsert({
    where: identityWhere(request),
    create: {
      organizationId: data.organizationId,
      computeTargetId: request.computeTargetId,
      externalSessionId: request.externalSessionId,
      fileKey: request.fileKey,
      sourceHarness: data.sourceHarness,
      objectStorageKey: data.objectStorageKey,
      uploadStatus: data.uploadStatus,
      sourcePathHash: data.sourcePathHash,
      sourceMtime: data.sourceMtime,
      lastObservedAt: data.lastObservedAt,
      sessionDetailId: data.sessionDetailId,
      pendingUploadId: data.pendingUploadId,
      pendingUploadStartedAt: data.pendingUploadStartedAt,
    },
    update: {
      sourceHarness: data.sourceHarness,
      objectStorageKey: data.objectStorageKey,
      uploadStatus: data.uploadStatus,
      sourcePathHash: data.sourcePathHash,
      sourceMtime: data.sourceMtime,
      lastObservedAt: data.lastObservedAt,
      pendingUploadId: data.pendingUploadId,
      pendingUploadStartedAt: data.pendingUploadStartedAt,
      ...(data.sessionDetailId
        ? { sessionDetailId: data.sessionDetailId }
        : {}),
    },
  });
}

function markFailed(tx: TransactionClient, id: string): Promise<unknown> {
  return tx.sessionTranscript.update({
    where: { id },
    data: {
      uploadStatus: TranscriptUploadStatus.Failed,
      pendingUploadId: null,
      pendingUploadStartedAt: null,
    },
  });
}

async function failAndAbort(
  tx: TransactionClient,
  id: string,
  s3: TranscriptS3Port,
  objectKey: string,
  uploadId: string | undefined
): Promise<void> {
  await markFailed(tx, id);
  if (uploadId) {
    await s3
      .abortMultipartUpload({ key: objectKey, uploadId })
      .catch(() => undefined);
  }
}
