import type {
  TranscriptCompleteRequest,
  TranscriptSyncPlanRequest,
} from "@repo/api/src/types/desktop-transcripts";
import { TRANSCRIPT_UPLOAD_PART_BYTES } from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return { db, withDb, findOwnedById: vi.fn() };
});

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@repo/aws", () => ({
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

import {
  type TranscriptS3Port,
  TranscriptSyncErrorReason,
  transcriptSyncService,
} from "./service";
import { TranscriptRateLimiter } from "./transcript-rate-limit";

const NOW = 1_700_000_000_000;
const ORG = "org-1";
const USER = "user-1";
const CT = "11111111-1111-7111-8111-111111111111";
const SID = "session-abc";
const STORED_SHA = "a".repeat(64);
const NEW_SHA = "b".repeat(64);
const BIG_OFFSET = 6 * 1024 * 1024; // >= S3 5 MiB min, so append is legal

function s3Port(overrides: Partial<TranscriptS3Port> = {}): TranscriptS3Port {
  return {
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: "up-new" }),
    copyPart: vi.fn().mockResolvedValue({ partNumber: 1, etag: "copy-etag" }),
    presignUploadPart: vi.fn().mockResolvedValue("https://s3/part"),
    presignPutObject: vi.fn().mockResolvedValue("https://s3/put"),
    listParts: vi.fn().mockResolvedValue([]),
    completeMultipartUpload: vi
      .fn()
      .mockResolvedValue({ etag: "final-etag", checksumCrc64Nvme: "crc-1" }),
    headObject: vi.fn().mockResolvedValue(null),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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

function transcriptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    uploadStatus: "uploading",
    rawSha256: null,
    crc64nvme: null,
    syncedByteOffset: 0n,
    storedEtag: null,
    sessionDetailId: null,
    pendingUploadId: null,
    pendingUploadStartedAt: null,
    ...overrides,
  };
}

const auth = { organizationId: ORG, userId: USER, clerkUserId: null };

function baseDeps(s3: TranscriptS3Port) {
  return { s3, now: () => NOW, rateLimiter: new TranscriptRateLimiter() };
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
      })
    );
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
          syncedByteOffset: 1000n,
          sessionDetailId: "art-1",
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
      })
    );
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
