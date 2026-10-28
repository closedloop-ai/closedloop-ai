import type {
  TranscriptCompleteRequest,
  TranscriptSyncPlanRequest,
} from "@repo/api/src/types/desktop-transcripts";
import { TRANSCRIPT_UPLOAD_PART_BYTES } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Legacy single-arg hashtext() advisory lock (32-bit key), still emitted
// alongside the new 64-bit hashtextextended() lock during the deploy window.
const LEGACY_HASHTEXT_LOCK_RE = /pg_advisory_xact_lock\(hashtext\([^,)]*\)\)/;

const mocks = vi.hoisted(() => {
  const db = {
    sessionTranscript: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    sessionDetail: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const withDb = Object.assign(
    vi.fn((fn: (client: typeof db) => unknown) => fn(db)),
    { tx: vi.fn((fn: (client: typeof db) => unknown) => fn(db)) }
  );
  // Minimal Prisma.sql stand-in: joins the static fragments so tests can assert
  // the emitted advisory-lock SQL (the service builds it via Prisma.sql`...`).
  const Prisma = {
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
      text: strings.join(""),
    }),
  };
  return { db, withDb, Prisma, findOwnedById: vi.fn() };
});

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));
vi.mock("@repo/aws/transcript-storage", () => ({
  createTranscriptMultipartUpload: vi.fn(),
  copyTranscriptPart: vi.fn(),
  presignTranscriptUploadPart: vi.fn(),
  presignTranscriptPutObject: vi.fn(),
  listTranscriptParts: vi.fn(),
  completeTranscriptMultipartUpload: vi.fn(),
  headTranscriptObject: vi.fn(),
  abortTranscriptMultipartUpload: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: mocks.findOwnedById },
}));

// Shared with skip-service.test.ts (the markPermanentlySkipped suite lives
// there so neither file exceeds the file-size ceiling); only pure builders are
// shared — the vi.hoisted/vi.mock header above stays per-module by necessity.
import {
  auth,
  baseDeps,
  CT,
  NOW,
  SID,
  STORED_SHA,
  s3Port,
  transcriptRow,
} from "@/__tests__/support/desktop/transcripts/service.test-fixtures";
import { transcriptSyncService } from "./service";
import { TranscriptRateLimiter } from "./transcript-rate-limit";
import { TranscriptSyncErrorReason } from "./transcript-sync-error-reason";

const NEW_SHA = "b".repeat(64);
const BIG_OFFSET = 6 * 1024 * 1024; // >= S3 5 MiB min, so append is legal

function planRequest(
  overrides: Partial<TranscriptSyncPlanRequest> = {}
): TranscriptSyncPlanRequest {
  return {
    computeTargetId: CT,
    externalSessionId: SID,
    fileKey: "main",
    sourceHarness: "claude_code",
    sourcePathHash: "path-hash",
    planEndOffset: 1000,
    sha256: NEW_SHA,
    crc64nvme: "crc-1",
    sourceMtime: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function completeRequest(
  overrides: Partial<TranscriptCompleteRequest> = {}
): TranscriptCompleteRequest {
  return {
    computeTargetId: CT,
    externalSessionId: SID,
    fileKey: "main",
    mode: "multipart",
    uploadId: "u",
    planEndOffset: 1000,
    sha256: NEW_SHA,
    crc64nvme: "crc-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOwnedById.mockResolvedValue({ id: CT });
  mocks.db.sessionTranscript.findUnique.mockResolvedValue(null);
  mocks.db.sessionDetail.findUnique.mockResolvedValue(null);
  mocks.db.sessionTranscript.upsert.mockResolvedValue({});
  mocks.db.sessionTranscript.update.mockResolvedValue({});
  mocks.db.$executeRaw.mockResolvedValue(0);
});

describe("transcriptSyncService.planSync", () => {
  it("rejects a non-owned compute target", async () => {
    mocks.findOwnedById.mockResolvedValue(null);
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.Forbidden,
    });
  });

  it("rate-limits per compute target", async () => {
    const rateLimiter = new TranscriptRateLimiter({ maxRequests: 1 });
    rateLimiter.attempt(CT, NOW);
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest(),
      deps: { s3: s3Port(), now: () => NOW, rateLimiter },
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.RateLimited,
    });
  });

  it("returns noop for identical already-uploaded content (idempotency)", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "uploaded",
        rawSha256: NEW_SHA,
        syncedByteOffset: 1000n,
        storedEtag: "etag-x",
      })
    );
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ sha256: NEW_SHA }),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: true,
      value: { mode: "noop", syncedByteOffset: 1000, storedEtag: "etag-x" },
    });
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
  });

  it("plans a single presigned PutObject for a small fresh file", async () => {
    const s3 = s3Port();
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000 }),
      deps: baseDeps(s3),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("fullPut");
    }
    expect(s3.presignPutObject).toHaveBeenCalledTimes(1);
    // The concrete checksum must be threaded to the presigner so S3 signs the
    // desktop's `x-amz-checksum-crc64nvme` header (otherwise a 403 at PUT time).
    expect(s3.presignPutObject).toHaveBeenCalledWith(
      expect.objectContaining({ checksumCrc64Nvme: "crc-1" })
    );
    expect(s3.createMultipartUpload).not.toHaveBeenCalled();
    expect(mocks.db.sessionTranscript.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          uploadStatus: "uploading",
          pendingUploadId: null,
        }),
        // ISS-6318: `upsertPlanRow` returns its promise to callers that bare-
        // `await` it, so the row is discarded and an absent `select` would
        // RETURNING all ~24 of this row's scalars — a per-cell cost paid for a
        // value nobody reads. Written literally so removing the production
        // `select` reddens here.
        select: { id: true },
      })
    );
  });

  // ISS-8735: a degraded resend must not null a previously stored good mtime.
  it("sourceMtime: degraded -> create null, update key omitted; valid -> Date on both", async () => {
    const s3 = s3Port();
    await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000, sourceMtime: undefined }),
      deps: baseDeps(s3),
    });
    const degraded = mocks.db.sessionTranscript.upsert.mock.calls[0][0];
    expect(degraded.create.sourceMtime).toBeNull();
    expect(degraded.update).not.toHaveProperty("sourceMtime");
    const mtime = new Date(NOW).toISOString();
    await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000, sourceMtime: mtime }),
      deps: baseDeps(s3Port()),
    });
    const valid = mocks.db.sessionTranscript.upsert.mock.calls[1][0];
    expect(valid.create.sourceMtime).toEqual(new Date(mtime));
    expect(valid.update.sourceMtime).toEqual(new Date(mtime));
  });

  it("plans a from-scratch multipart upload for a large fresh file", async () => {
    const s3 = s3Port();
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({
        planEndOffset: TRANSCRIPT_UPLOAD_PART_BYTES + 10,
      }),
      deps: baseDeps(s3),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.mode === "multipart") {
      expect(result.value.uploadId).toBe("up-new");
      expect(result.value.copiedPartEtag).toBeUndefined();
      expect(result.value.parts).toHaveLength(2);
    }
    expect(s3.copyPart).not.toHaveBeenCalled();
  });

  it("copy-appends onto an existing object when the prefix is consistent", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "uploaded",
        rawSha256: STORED_SHA,
        syncedByteOffset: BigInt(BIG_OFFSET),
        storedEtag: "prev-etag",
      })
    );
    const s3 = s3Port();
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({
        sha256: NEW_SHA,
        prefixSha256: STORED_SHA,
        planEndOffset: BIG_OFFSET + 100,
      }),
      deps: baseDeps(s3),
    });
    expect(s3.copyPart).toHaveBeenCalledWith(
      expect.objectContaining({ partNumber: 1, ifMatchEtag: "prev-etag" })
    );
    if (result.ok && result.value.mode === "multipart") {
      expect(result.value.copiedPartEtag).toBe("copy-etag");
      expect(result.value.syncedByteOffset).toBe(BIG_OFFSET);
    }
  });

  it("resumes an in-flight upload, re-signing only the missing parts", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "uploading",
        rawSha256: STORED_SHA,
        syncedByteOffset: BigInt(BIG_OFFSET),
        storedEtag: "prev-etag",
        pendingUploadId: "up-9",
        pendingUploadStartedAt: new Date(NOW - 1000),
      })
    );
    const planEndOffset = BIG_OFFSET + TRANSCRIPT_UPLOAD_PART_BYTES + 50;
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([
        { partNumber: 1, etag: "c1", size: BIG_OFFSET },
        { partNumber: 2, etag: "p2", size: TRANSCRIPT_UPLOAD_PART_BYTES },
      ]),
    });
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({
        sha256: NEW_SHA,
        prefixSha256: STORED_SHA,
        planEndOffset,
      }),
      deps: baseDeps(s3),
    });
    expect(s3.abortMultipartUpload).not.toHaveBeenCalled();
    expect(s3.createMultipartUpload).not.toHaveBeenCalled();
    if (result.ok && result.value.mode === "multipart") {
      expect(result.value.uploadId).toBe("up-9");
      expect(result.value.copiedPartEtag).toBe("c1");
      expect(result.value.parts.map((p) => p.partNumber)).toEqual([3]);
    }
  });

  it("aborts a stale in-flight upload and re-plans", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        pendingUploadId: "up-old",
        pendingUploadStartedAt: new Date(NOW - 25 * 60 * 60 * 1000),
        syncedByteOffset: BigInt(BIG_OFFSET),
      })
    );
    const s3 = s3Port();
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000 }), // no prefixSha256 -> full upload
      deps: baseDeps(s3),
    });
    expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "up-old" })
    );
    if (result.ok) {
      expect(result.value.mode).toBe("fullPut");
    }
  });

  it("aborts and re-plans when the resumed parts have diverged", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "uploading",
        rawSha256: STORED_SHA,
        syncedByteOffset: BigInt(BIG_OFFSET),
        storedEtag: "prev-etag",
        pendingUploadId: "up-x",
        pendingUploadStartedAt: new Date(NOW - 1000),
      })
    );
    const s3 = s3Port({
      // Intended delta part 2 is 100 bytes; the uploaded part reports 999 -> diverged.
      listParts: vi
        .fn()
        .mockResolvedValue([{ partNumber: 2, etag: "p2", size: 999 }]),
    });
    await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({
        sha256: NEW_SHA,
        prefixSha256: STORED_SHA,
        planEndOffset: BIG_OFFSET + 100,
      }),
      deps: baseDeps(s3),
    });
    expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "up-x" })
    );
    expect(s3.createMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("recovers to a fresh plan when the in-flight upload is gone (S3 throws)", async () => {
    // The MPU was reclaimed by the 7-day lifecycle rule: listParts/abort throw.
    // This must NOT unwind the transaction and strand pendingUploadId forever.
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        pendingUploadId: "up-dead",
        pendingUploadStartedAt: new Date(NOW - 1000),
        syncedByteOffset: BigInt(BIG_OFFSET),
      })
    );
    const s3 = s3Port({
      listParts: vi.fn().mockRejectedValue(new Error("NoSuchUpload")),
      abortMultipartUpload: vi
        .fn()
        .mockRejectedValue(new Error("NoSuchUpload")),
    });
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000 }), // no prefixSha256 -> fresh
      deps: baseDeps(s3),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("fullPut");
    }
    // The fresh plan cleared the dead uploadId (pendingUploadId: null).
    expect(mocks.db.sessionTranscript.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ pendingUploadId: null }),
      })
    );
  });

  it("FEA-3489: re-opening a previously-skipped row clears permanentFailureReason", async () => {
    // The desktop force-archive override drives a `plan` on a row that the
    // automatic lane earlier marked `skipped` with `too_large`. Moving it back
    // into `uploading` MUST clear that terminal reason, or a later `complete`
    // would leave the descriptor `available` WITH a stale `permanentFailureReason`.
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "skipped",
        permanentFailureReason: TranscriptSkipReason.TooLarge,
      })
    );
    const result = await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000 }),
      deps: baseDeps(s3Port()),
    });
    expect(result.ok).toBe(true);
    expect(mocks.db.sessionTranscript.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          uploadStatus: "uploading",
          permanentFailureReason: null,
        }),
      })
    );
  });
});

describe("transcriptSyncService.complete", () => {
  it("rejects a non-owned compute target", async () => {
    mocks.findOwnedById.mockResolvedValue(null);
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.Forbidden,
    });
  });

  it("rate-limits per compute target", async () => {
    const rateLimiter = new TranscriptRateLimiter({ maxRequests: 1 });
    rateLimiter.attempt(CT, NOW);
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: { s3: s3Port(), now: () => NOW, rateLimiter },
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.RateLimited,
    });
  });

  it("is stale when no prior sync-plan row exists", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(null);
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.StaleUpload,
    });
  });

  // ISS-7097: the transaction wrapper's catch-all used to degrade EVERY throw —
  // a `PLAN_TX_TIMEOUT_MS` expiry, an unreachable database — to `StaleUpload`,
  // i.e. a 409 telling the desktop its own state was stale. The desktop answers
  // a 409 by burning one of five per-row retry attempts, so a cloud-side outage
  // marched healthy transcripts toward a `retries_exhausted` skip the cloud then
  // believed. Nothing about the caller is stale here, and the reason must say so.
  it("reports an upstream failure as unavailable, not as a stale upload", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ pendingUploadId: "u" })
    );
    mocks.withDb.tx.mockImplementationOnce(() => {
      throw new Error("Transaction already closed: timeout exceeded");
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.UpstreamUnavailable,
    });
  });

  // ISS-8689 / PRD-699 Appendix A: an unset TRANSCRIPTS_BUCKET is environmental
  // (only an admin fixes it), so it must be told apart from a transient outage
  // even though both throw from inside this same transaction wrapper. The
  // discriminant is read via `isStorageNotConfiguredError`, not the message —
  // the duck-typed error below only carries the discriminant field, matching
  // what `TranscriptStorageNotConfiguredError` actually attaches.
  it("reports a storage-not-configured failure as upstream-not-configured, not as a stale upload", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ pendingUploadId: "u" })
    );
    mocks.withDb.tx.mockImplementationOnce(() => {
      throw Object.assign(new Error("TRANSCRIPTS_BUCKET is not configured"), {
        transcriptStorageNotConfigured: true,
      });
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.UpstreamNotConfigured,
    });
  });

  it("rejects a superseded uploadId without touching the row", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ pendingUploadId: "u-new" })
    );
    const s3 = s3Port();
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ uploadId: "u-old" }),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.StaleUpload,
    });
    expect(s3.listParts).not.toHaveBeenCalled();
    expect(mocks.db.sessionTranscript.update).not.toHaveBeenCalled();
  });

  it("fails when S3 returns no checksum metadata (no silent bypass)", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ pendingUploadId: "u" })
    );
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      headObject: vi.fn().mockResolvedValue({ byteSize: 1000, etag: "f" }),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ planEndOffset: 1000, crc64nvme: "crc-1" }),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.StaleUpload,
    });
    expect(s3.abortMultipartUpload).toHaveBeenCalled();
  });

  it("completes a multipart upload and advances verified state", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    mocks.db.sessionDetail.findUnique.mockResolvedValue({
      artifactId: "art-1",
    });
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      headObject: vi.fn().mockResolvedValue({
        byteSize: 1000,
        etag: "final-etag",
        checksumCrc64Nvme: "crc-1",
      }),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ planEndOffset: 1000, crc64nvme: "crc-1" }),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: "uploaded",
        syncedByteOffset: 1000,
        storedEtag: "final-etag",
        sessionDetailId: "art-1",
      },
    });
    expect(s3.completeMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumCrc64Nvme: "crc-1",
        ifMatchEtag: "prev-etag",
      })
    );
    expect(mocks.db.sessionTranscript.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uploadStatus: "uploaded",
          rawSha256: NEW_SHA,
          crc64nvme: "crc-1",
          rawByteSize: 1000n,
          syncedByteOffset: 1000n,
          sessionDetailId: "art-1",
          // FEA-3489: an `available` upload must never retain a terminal reason.
          permanentFailureReason: null,
        }),
      })
    );
  });

  it("fails and aborts when S3 rejects the multipart completion (412)", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      completeMultipartUpload: vi
        .fn()
        .mockRejectedValue(new Error("PreconditionFailed")),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.StaleUpload,
    });
    expect(s3.abortMultipartUpload).toHaveBeenCalled();
    expect(mocks.db.sessionTranscript.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadStatus: "failed" }),
        // ISS-6318: `markFailed` is declared `Promise<unknown>` and every
        // caller bare-`await`s it, so this row is discarded too.
        select: { id: true },
      })
    );
  });

  // ISS-7097: this catch RETURNS rather than throws, so it never reaches
  // `runTranscriptTx`'s reclassifying tail and has to make the same call itself.
  // S3 being down says nothing about this row being stale, and answering 409
  // spends one of the desktop's five per-row attempts on a cloud outage — the
  // exact bug this ticket exists to fix, one call path over.
  it("reports an S3 outage during completion as unavailable, not as a stale upload", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    const throttled = Object.assign(new Error("SlowDown"), {
      $metadata: { httpStatusCode: 503 },
    });
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      completeMultipartUpload: vi.fn().mockRejectedValue(throttled),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.UpstreamUnavailable,
    });
    // The abort still runs: a half-finished multipart upload is leaked storage
    // whichever family the rejection belongs to, and the client re-plans from
    // server truth either way.
    expect(s3.abortMultipartUpload).toHaveBeenCalled();
  });

  // ISS-8689: this catch RETURNS rather than throws (same reason as the S3
  // outage case above), so it has to classify config-unset itself too. A
  // `TranscriptStorageNotConfiguredError` here carries no `$metadata` at all,
  // so without this check it would fall through to `StaleUpload` and burn the
  // desktop's per-row retry budget on a config problem no retry can fix.
  it("reports a storage-not-configured failure during completion as upstream-not-configured, not as a stale upload", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    const notConfigured = Object.assign(
      new Error("TRANSCRIPTS_BUCKET is not configured"),
      { transcriptStorageNotConfigured: true }
    );
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      completeMultipartUpload: vi.fn().mockRejectedValue(notConfigured),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.UpstreamNotConfigured,
    });
    expect(s3.abortMultipartUpload).toHaveBeenCalled();
  });

  // Regression (ISS-8689): the config-unset check must not widen over a
  // genuine stale-plan S3 rejection. A real AWS SDK 4xx carries `$metadata`
  // with a status below 429/500 and no config discriminant, so it must keep
  // falling to `StaleUpload` exactly as before this ticket.
  it("still answers a genuine stale-plan S3 4xx on the complete path with stale-upload", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    const preconditionFailed = Object.assign(new Error("PreconditionFailed"), {
      $metadata: { httpStatusCode: 412 },
    });
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      completeMultipartUpload: vi.fn().mockRejectedValue(preconditionFailed),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest(),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.StaleUpload,
    });
  });

  it("fails when the stored checksum does not match the client checksum", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      headObject: vi.fn().mockResolvedValue({
        byteSize: 1000,
        etag: "final",
        checksumCrc64Nvme: "DIFFERENT",
      }),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ planEndOffset: 1000, crc64nvme: "crc-1" }),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.StaleUpload,
    });
    expect(s3.abortMultipartUpload).toHaveBeenCalled();
  });

  it("fails when the stored byte size does not match the plan window", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ pendingUploadId: "u" })
    );
    const s3 = s3Port({
      listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
      headObject: vi.fn().mockResolvedValue({ byteSize: 999, etag: "f" }),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ planEndOffset: 1000 }),
      deps: baseDeps(s3),
    });
    expect(result.ok).toBe(false);
  });

  it("verifies a fullPut without a multipart completion call", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ pendingUploadId: null })
    );
    const s3 = s3Port({
      headObject: vi.fn().mockResolvedValue({
        byteSize: 1000,
        etag: "final",
        checksumCrc64Nvme: "crc-1",
      }),
    });
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({
        mode: "fullPut",
        uploadId: undefined,
        planEndOffset: 1000,
      }),
      deps: baseDeps(s3),
    });
    expect(result.ok).toBe(true);
    expect(s3.completeMultipartUpload).not.toHaveBeenCalled();
    expect(s3.listParts).not.toHaveBeenCalled();
  });

  it("is idempotent for an already-completed upload", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "uploaded",
        rawSha256: NEW_SHA,
        syncedByteOffset: 1000n,
        storedEtag: "final",
        sessionDetailId: "art-1",
      })
    );
    const s3 = s3Port();
    const result = await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ sha256: NEW_SHA }),
      deps: baseDeps(s3),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: "uploaded",
        syncedByteOffset: 1000,
        storedEtag: "final",
        sessionDetailId: "art-1",
      },
    });
    expect(s3.listParts).not.toHaveBeenCalled();
  });
});

describe("per-file advisory lock derivation (PRD-536 D12)", () => {
  // The lock key is widened to 64 bits via hashtextextended(key, 0::bigint) so
  // unrelated files no longer collide in the 32-bit hashtext space and serialize
  // under load. During a rolling deploy each site ALSO takes the legacy
  // single-arg hashtext(key) lock, in a fixed old→new order, so a new-release
  // handler still mutually excludes in-flight previous-release handlers keyed on
  // the 32-bit value (transitional; see the DEPLOY-TRANSITION comment in
  // service.ts). Every transcript write path (plan/complete/skip) derives the
  // lock through the same advisoryLockKeySql() helper, so all three must emit
  // BOTH forms. We assert on the SQL captured by the mocked `Prisma.sql` (see
  // the hoisted mock above).
  function firstLockSql(): string {
    const arg = mocks.db.$executeRaw.mock.calls[0]?.[0] as
      | { text: string }
      | undefined;
    return arg?.text ?? "";
  }

  // biome-ignore-start lint/suspicious/noMisplacedAssertion: shared dual-lock assertion helper invoked from each write-path test
  function assertDualLock(sql: string) {
    expect(sql).toContain("pg_advisory_xact_lock");
    // New 64-bit form, matching integrations/github/dirty-scope-service.ts.
    expect(sql).toContain("hashtextextended");
    expect(sql).toContain("0::bigint");
    // Legacy 32-bit form is ALSO emitted (single-arg hashtext) for deploy-window
    // mutual exclusion.
    expect(sql).toMatch(LEGACY_HASHTEXT_LOCK_RE);
    // Fixed old→new ordering: the legacy 32-bit lock is acquired before the
    // 64-bit one so mixed handlers never deadlock.
    expect(sql.indexOf("hashtext(")).toBeLessThan(
      sql.indexOf("hashtextextended(")
    );
  }
  // biome-ignore-end lint/suspicious/noMisplacedAssertion: shared dual-lock assertion helper invoked from each write-path test

  it("planSync takes both the legacy 32-bit and new 64-bit per-file lock", async () => {
    await transcriptSyncService.planSync({
      ...auth,
      request: planRequest({ planEndOffset: 1000 }),
      deps: baseDeps(s3Port()),
    });
    expect(mocks.db.$executeRaw).toHaveBeenCalledTimes(1);
    assertDualLock(firstLockSql());
  });

  it("complete takes both the legacy 32-bit and new 64-bit per-file lock", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({ storedEtag: "prev-etag", pendingUploadId: "u" })
    );
    mocks.db.sessionDetail.findUnique.mockResolvedValue({
      artifactId: "art-1",
    });
    await transcriptSyncService.complete({
      ...auth,
      request: completeRequest({ planEndOffset: 1000, crc64nvme: "crc-1" }),
      deps: baseDeps(
        s3Port({
          listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: "e1" }]),
          headObject: vi.fn().mockResolvedValue({
            byteSize: 1000,
            etag: "final-etag",
            checksumCrc64Nvme: "crc-1",
          }),
        })
      ),
    });
    expect(mocks.db.$executeRaw).toHaveBeenCalledTimes(1);
    assertDualLock(firstLockSql());
  });

  it("markPermanentlySkipped takes both the legacy 32-bit and new 64-bit per-file lock", async () => {
    await transcriptSyncService.markPermanentlySkipped({
      ...auth,
      request: {
        computeTargetId: CT,
        externalSessionId: SID,
        fileKey: "main" as const,
        sourceHarness: "claude_code",
        reason: TranscriptSkipReason.TooLarge,
      },
      deps: baseDeps(s3Port()),
    });
    expect(mocks.db.$executeRaw).toHaveBeenCalledTimes(1);
    assertDualLock(firstLockSql());
  });
});
