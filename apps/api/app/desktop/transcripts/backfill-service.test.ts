import { withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  backfillOrphanTranscriptsBatch,
  ORPHANED_TRANSCRIPT_WHERE,
  TRANSCRIPT_BACKFILL_BATCH_SIZE,
  transcriptBackfillService,
} from "./backfill-service";

/**
 * `runBackfill` drives each pass through the non-transactional `withDb(fn)`
 * accessor (NOT `withDb.tx` — see the service doc). Route the callback at a
 * supplied fake client so the loop exercises the real batch logic against
 * mocked Prisma models.
 */
function stubWithDb(client: unknown): void {
  vi.mocked(withDb).mockImplementation((fn: (db: never) => unknown) =>
    Promise.resolve(fn(client as never))
  );
}

vi.mock("@repo/database", async (importActual) => {
  const actual = await importActual<typeof import("@repo/database")>();
  return { ...actual, withDb: vi.fn() };
});

describe("ORPHANED_TRANSCRIPT_WHERE", () => {
  it("matches only rows with a null sessionDetailId", () => {
    expect(ORPHANED_TRANSCRIPT_WHERE).toEqual({ sessionDetailId: null });
  });
});

describe("backfillOrphanTranscriptsBatch", () => {
  it("does nothing and reports empty when there are no orphans", async () => {
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      sessionDetail: { findUnique: vi.fn() },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);
    expect(result).toEqual({ linked: 0, unresolved: 0, scanned: 0 });
    expect(db.sessionDetail.findUnique).not.toHaveBeenCalled();
    expect(db.sessionTranscript.updateMany).not.toHaveBeenCalled();
  });

  it("re-links a fully-uploaded orphan to its session by identity without a new plan/complete", async () => {
    // The core AC: a transcript that finished uploading before its SessionDetail
    // arrived is orphaned (sessionDetailId null); the backfill links it purely
    // from the session identity (computeTargetId, externalSessionId).
    const db = {
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computeTargetId: "ct1", externalSessionId: "s1" },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({ artifactId: "artifact-1" }),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    expect(db.sessionDetail.findUnique).toHaveBeenCalledWith({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: "ct1",
          externalSessionId: "s1",
        },
      },
      select: { artifactId: true },
    });
    // Re-scoped to still-orphaned rows so a concurrent relink is not clobbered,
    // and matches every file of the session (parent + subagents) by identity.
    expect(db.sessionTranscript.updateMany).toHaveBeenCalledWith({
      where: {
        computeTargetId: "ct1",
        externalSessionId: "s1",
        sessionDetailId: null,
      },
      data: { sessionDetailId: "artifact-1" },
    });
    expect(result).toEqual({ linked: 1, unresolved: 0, scanned: 1 });
  });

  it("collapses a session's parent + subagent orphan rows to one identity resolution", async () => {
    // Parent (fileKey main) and a subagent share the identity; the batch resolves
    // the SessionDetail once and links both files via a single updateMany.
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          { computeTargetId: "ct1", externalSessionId: "s1" },
          { computeTargetId: "ct1", externalSessionId: "s1" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({ artifactId: "artifact-1" }),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    expect(db.sessionDetail.findUnique).toHaveBeenCalledTimes(1);
    expect(db.sessionTranscript.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ linked: 2, unresolved: 0, scanned: 2 });
  });

  it("leaves an orphan unlinked when its session metadata has not arrived yet", async () => {
    const db = {
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computeTargetId: "ct1", externalSessionId: "s1" },
          ]),
        updateMany: vi.fn(),
      },
      sessionDetail: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);
    expect(db.sessionTranscript.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ linked: 0, unresolved: 1, scanned: 1 });
  });
});

describe("transcriptBackfillService.runBackfill", () => {
  it("links an already-orphaned transcript within one cycle and reports the count", async () => {
    // The single batch finds one orphan (scanned 1 < BATCH_SIZE), so the loop
    // drains and breaks after one pass — findMany is called exactly once.
    const findMany = vi
      .fn()
      .mockResolvedValue([{ computeTargetId: "ct1", externalSessionId: "s1" }]);
    const db = {
      sessionTranscript: {
        findMany,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({ artifactId: "artifact-1" }),
      },
    };
    stubWithDb(db);
    const result = await transcriptBackfillService.runBackfill();
    expect(result.exitCode).toBe(0);
    expect(result.linked).toBe(1);
    expect(result.unresolved).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("stops (does not spin) when every remaining orphan is unresolvable", async () => {
    // A full batch of orphans with no SessionDetail must terminate the loop, not
    // re-scan the same unlinkable rows forever.
    const orphans = Array.from(
      { length: TRANSCRIPT_BACKFILL_BATCH_SIZE },
      (_, i) => ({ computeTargetId: `ct${i}`, externalSessionId: `s${i}` })
    );
    const findMany = vi.fn().mockResolvedValue(orphans);
    const db = {
      sessionTranscript: { findMany, updateMany: vi.fn() },
      sessionDetail: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    stubWithDb(db);
    const result = await transcriptBackfillService.runBackfill();
    expect(result.exitCode).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.unresolved).toBe(TRANSCRIPT_BACKFILL_BATCH_SIZE);
    // Exactly one scan — linked === 0 breaks the loop immediately.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("returns exitCode 1 and does not throw when a batch errors", async () => {
    vi.mocked(withDb).mockRejectedValue(new Error("db down"));
    const result = await transcriptBackfillService.runBackfill();
    expect(result.exitCode).toBe(1);
    expect(result.linked).toBe(0);
  });
});

// The other half of the PRD-536 G3 AC — session deletion never leaves an
// orphaned (sessionDetailId null, onDelete: SetNull) transcript row behind,
// because the retention sweep deletes transcript rows by session identity
// BEFORE deleting the artifact — is owned by retention-service.test.ts, which
// already asserts exactly this in "reclaims transcript rows whose
// sessionDetailId was never linked (matched by identity)" (identity-scoped
// deleteMany + the delete-before-artifact ordering). Not re-asserted here to
// avoid duplicating that coverage.
