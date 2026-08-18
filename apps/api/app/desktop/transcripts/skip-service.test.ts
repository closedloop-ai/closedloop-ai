import type { TranscriptSkipRequest } from "@repo/api/src/types/desktop-transcripts";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {
    sessionTranscript: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    sessionDetail: { findUnique: vi.fn() },
    // FEA-4169: the default org-policy gate reads Organization via withDb.
    organization: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const withDb = Object.assign(
    vi.fn((fn: (client: typeof db) => unknown) => fn(db)),
    { tx: vi.fn((fn: (client: typeof db) => unknown) => fn(db)) }
  );
  // Minimal Prisma.sql stand-in (see service.test.ts, which asserts the SQL).
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
  auth,
  baseDeps,
  CT,
  SID,
  STORED_SHA,
  s3Port,
  transcriptRow,
} from "@/__tests__/support/desktop/transcripts/service.test-fixtures";
import { TranscriptSyncErrorReason, transcriptSyncService } from "./service";

/**
 * `markPermanentlySkipped` behavior (FEA-3476 / ISS-4621). Split out of
 * `service.test.ts` (which owns plan/complete plus the cross-path lock and
 * org-policy suites) so neither file exceeds the file-size ceiling. The
 * `vi.hoisted`/`vi.mock` header mirrors that file — vitest hoists module mocks
 * per test module, so only the pure fixtures are shared
 * (`service.test-fixtures.ts`).
 */

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOwnedById.mockResolvedValue({ id: CT });
  mocks.db.organization.findUnique.mockResolvedValue({
    sessionSyncPolicyEnabled: true,
  });
  mocks.db.sessionTranscript.findUnique.mockResolvedValue(null);
  mocks.db.sessionDetail.findUnique.mockResolvedValue(null);
  mocks.db.sessionTranscript.upsert.mockResolvedValue({});
  mocks.db.sessionTranscript.update.mockResolvedValue({});
  mocks.db.$executeRaw.mockResolvedValue(0);
});

describe("transcriptSyncService.markPermanentlySkipped (FEA-3476)", () => {
  function skipRequest(overrides: Partial<TranscriptSkipRequest> = {}) {
    return {
      computeTargetId: CT,
      externalSessionId: SID,
      fileKey: "main" as const,
      sourceHarness: "claude_code",
      reason: TranscriptSkipReason.TooLarge,
      ...overrides,
    };
  }

  it("rejects a non-owned compute target (org scoping)", async () => {
    mocks.findOwnedById.mockResolvedValue(null);
    const result = await transcriptSyncService.markPermanentlySkipped({
      ...auth,
      request: skipRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: false,
      error: TranscriptSyncErrorReason.Forbidden,
    });
    // No DB write is attempted for an unauthorized caller.
    expect(mocks.db.sessionTranscript.upsert).not.toHaveBeenCalled();
  });

  it("persists the terminal skipped status + reason and clears any pending upload", async () => {
    mocks.db.sessionDetail.findUnique.mockResolvedValue({
      artifactId: "art-1",
    });
    const result = await transcriptSyncService.markPermanentlySkipped({
      ...auth,
      request: skipRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: "skipped",
        permanentFailureReason: TranscriptSkipReason.TooLarge,
        sessionDetailId: "art-1",
      },
    });
    const upsertArg = mocks.db.sessionTranscript.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsertArg.create).toMatchObject({
      uploadStatus: "skipped",
      permanentFailureReason: TranscriptSkipReason.TooLarge,
      pendingUploadId: null,
      pendingUploadStartedAt: null,
    });
    expect(upsertArg.update).toMatchObject({
      uploadStatus: "skipped",
      permanentFailureReason: TranscriptSkipReason.TooLarge,
      pendingUploadId: null,
      pendingUploadStartedAt: null,
    });
  });

  it("persists the retries_exhausted reason end-to-end (ISS-4621)", async () => {
    // The generic consecutive-failure dead-letter emits this reason. Pin that
    // it reaches the upsert and is echoed back, so contract drift between the
    // desktop's ack-gate and this service cannot leave exhausted rows
    // retrying forever while the desktop unit suites stay green.
    mocks.db.sessionDetail.findUnique.mockResolvedValue({
      artifactId: "art-1",
    });
    const result = await transcriptSyncService.markPermanentlySkipped({
      ...auth,
      request: skipRequest({ reason: TranscriptSkipReason.RetriesExhausted }),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: "skipped",
        permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
        sessionDetailId: "art-1",
      },
    });
    const upsertArg = mocks.db.sessionTranscript.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsertArg.create).toMatchObject({
      uploadStatus: "skipped",
      permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
    });
    expect(upsertArg.update).toMatchObject({
      uploadStatus: "skipped",
      permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
    });
  });

  it("is a NO-OP when a verified upload already exists (a good archive is never masked)", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: TranscriptUploadStatus.Uploaded,
        rawSha256: STORED_SHA,
        sessionDetailId: "art-1",
      })
    );
    const result = await transcriptSyncService.markPermanentlySkipped({
      ...auth,
      request: skipRequest(),
      deps: baseDeps(s3Port()),
    });
    // Reports the still-uploaded state; the skip does not overwrite it.
    // ISS-4695: the desktop consumer depends on THIS exact `uploaded`
    // discriminant to avoid dead-lettering a transcript the cloud still holds.
    expect(result).toEqual({
      ok: true,
      value: {
        status: TranscriptUploadStatus.Uploaded,
        permanentFailureReason: TranscriptSkipReason.TooLarge,
        sessionDetailId: "art-1",
      },
    });
    expect(mocks.db.sessionTranscript.upsert).not.toHaveBeenCalled();
  });

  it("is idempotent on an already-skipped row (re-send just refreshes the reason)", async () => {
    mocks.db.sessionTranscript.findUnique.mockResolvedValue(
      transcriptRow({
        uploadStatus: "skipped",
        permanentFailureReason: TranscriptSkipReason.TooLarge,
        sessionDetailId: "art-1",
      })
    );
    const result = await transcriptSyncService.markPermanentlySkipped({
      ...auth,
      request: skipRequest(),
      deps: baseDeps(s3Port()),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: "skipped",
        permanentFailureReason: TranscriptSkipReason.TooLarge,
        sessionDetailId: "art-1",
      },
    });
    // A skipped row is upserted (not uploaded), so the write path still runs.
    expect(mocks.db.sessionTranscript.upsert).toHaveBeenCalledTimes(1);
  });

  /**
   * ISS-4820 item 2 — reason PRECEDENCE. The desktop releases its per-file lock
   * after a 30s abort, so a changed projection can requeue and settle a NEWER
   * hard reason while a stale in-flight recoverable request is still finishing.
   * Last-writer-wins let that late write clobber the hard reason and resurrect a
   * dead row into a `syncing` disposition — "still uploading" forever, with
   * nothing on any queue.
   */
  describe("ISS-4820: hard-reason precedence", () => {
    /** A recoverable skip arriving from a materialized (opencode) source. */
    function recoverableRequest() {
      return skipRequest({
        sourceHarness: "opencode",
        reason: TranscriptSkipReason.MaterializedSourceUnavailable,
      });
    }

    it("does NOT let a late recoverable reason overwrite an existing HARD reason", async () => {
      mocks.db.sessionTranscript.findUnique.mockResolvedValue(
        transcriptRow({
          uploadStatus: TranscriptUploadStatus.Skipped,
          permanentFailureReason: TranscriptSkipReason.TooLarge,
          sessionDetailId: "art-1",
        })
      );

      const result = await transcriptSyncService.markPermanentlySkipped({
        ...auth,
        request: recoverableRequest(),
        deps: baseDeps(s3Port()),
      });

      const [call] = mocks.db.sessionTranscript.upsert.mock.calls;
      expect(call[0].update.permanentFailureReason).toBe(
        TranscriptSkipReason.TooLarge
      );
      // The response must report what was PERSISTED — echoing the requested
      // recoverable reason would tell the desktop the row can still sync.
      expect(result).toEqual({
        ok: true,
        value: {
          status: TranscriptUploadStatus.Skipped,
          permanentFailureReason: TranscriptSkipReason.TooLarge,
          sessionDetailId: "art-1",
        },
      });
    });

    it("DOES let a hard reason upgrade an existing recoverable one (the correct settle direction)", async () => {
      mocks.db.sessionTranscript.findUnique.mockResolvedValue(
        transcriptRow({
          uploadStatus: TranscriptUploadStatus.Skipped,
          permanentFailureReason:
            TranscriptSkipReason.MaterializedSourceUnavailable,
          sessionDetailId: "art-1",
        })
      );

      const result = await transcriptSyncService.markPermanentlySkipped({
        ...auth,
        request: skipRequest({ reason: TranscriptSkipReason.SourceGone }),
        deps: baseDeps(s3Port()),
      });

      const [call] = mocks.db.sessionTranscript.upsert.mock.calls;
      expect(call[0].update.permanentFailureReason).toBe(
        TranscriptSkipReason.SourceGone
      );
      expect(result).toEqual({
        ok: true,
        value: {
          status: TranscriptUploadStatus.Skipped,
          permanentFailureReason: TranscriptSkipReason.SourceGone,
          sessionDetailId: "art-1",
        },
      });
    });

    it("lets a recoverable reason refresh another recoverable one (no precedence to defend)", async () => {
      mocks.db.sessionTranscript.findUnique.mockResolvedValue(
        transcriptRow({
          uploadStatus: TranscriptUploadStatus.Skipped,
          permanentFailureReason:
            TranscriptSkipReason.MaterializedSourceUnavailable,
          sessionDetailId: "art-1",
        })
      );

      await transcriptSyncService.markPermanentlySkipped({
        ...auth,
        request: recoverableRequest(),
        deps: baseDeps(s3Port()),
      });

      const [call] = mocks.db.sessionTranscript.upsert.mock.calls;
      expect(call[0].update.permanentFailureReason).toBe(
        TranscriptSkipReason.MaterializedSourceUnavailable
      );
    });

    it("does not defend a row that is not already terminally skipped", async () => {
      // A `failed` row carrying a stale hard reason is still retryable, so the
      // recoverable reason is the newer truth and must land.
      mocks.db.sessionTranscript.findUnique.mockResolvedValue(
        transcriptRow({
          uploadStatus: TranscriptUploadStatus.Failed,
          permanentFailureReason: TranscriptSkipReason.TooLarge,
          sessionDetailId: "art-1",
        })
      );

      await transcriptSyncService.markPermanentlySkipped({
        ...auth,
        request: recoverableRequest(),
        deps: baseDeps(s3Port()),
      });

      const [call] = mocks.db.sessionTranscript.upsert.mock.calls;
      expect(call[0].update.permanentFailureReason).toBe(
        TranscriptSkipReason.MaterializedSourceUnavailable
      );
    });

    it("PRESERVES an UNKNOWN persisted reason rather than overwriting it (API rolled back behind a newer desktop)", async () => {
      // codex review: every read path normalizes an unrecognized label to `null`
      // and maps that to the HARD `failedPermanent`, so overwriting it with the
      // recoverable reason would flip a row this build treats as dead back to
      // `syncing` — the same resurrection the precedence rule exists to stop,
      // just via a label this build cannot name. Treat unknown as hard, and keep
      // the label verbatim so the newer build that wrote it can still read it.
      mocks.db.sessionTranscript.findUnique.mockResolvedValue(
        transcriptRow({
          uploadStatus: TranscriptUploadStatus.Skipped,
          permanentFailureReason: "some_future_reason",
          sessionDetailId: "art-1",
        })
      );

      const result = await transcriptSyncService.markPermanentlySkipped({
        ...auth,
        request: recoverableRequest(),
        deps: baseDeps(s3Port()),
      });

      const [call] = mocks.db.sessionTranscript.upsert.mock.calls;
      expect(call[0].update.permanentFailureReason).toBe("some_future_reason");
      // The WIRE echo is narrowed to the shared enum: an unnameable reason
      // degrades to `null` (which every read path classifies as the conservative
      // hard `failedPermanent`) rather than shipping a free string a client older
      // than the label would reject outright.
      expect(result).toEqual({
        ok: true,
        value: {
          status: TranscriptUploadStatus.Skipped,
          permanentFailureReason: null,
          sessionDetailId: "art-1",
        },
      });
    });

    it("still lets the requested reason land when NO reason was recorded at all", async () => {
      // The empty case must stay distinguishable from the unknown-label case
      // above: with nothing recorded, the requested reason is strictly more
      // information, so it wins.
      mocks.db.sessionTranscript.findUnique.mockResolvedValue(
        transcriptRow({
          uploadStatus: TranscriptUploadStatus.Skipped,
          permanentFailureReason: null,
          sessionDetailId: "art-1",
        })
      );

      const result = await transcriptSyncService.markPermanentlySkipped({
        ...auth,
        request: recoverableRequest(),
        deps: baseDeps(s3Port()),
      });

      const [call] = mocks.db.sessionTranscript.upsert.mock.calls;
      expect(call[0].update.permanentFailureReason).toBe(
        TranscriptSkipReason.MaterializedSourceUnavailable
      );
      expect(result).toEqual({
        ok: true,
        value: {
          status: TranscriptUploadStatus.Skipped,
          permanentFailureReason:
            TranscriptSkipReason.MaterializedSourceUnavailable,
          sessionDetailId: "art-1",
        },
      });
    });
  });
});
