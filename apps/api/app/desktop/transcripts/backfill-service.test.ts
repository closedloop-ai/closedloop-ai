import { createHash } from "node:crypto";
import { withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  hasProjectedIndexKeyShape,
  projectIndexKey,
} from "@/lib/index-key-projection";
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
/**
 * A HIGH-ENTROPY session id past the index-key budget. Entropy is load-bearing
 * everywhere in this family: a repeated-character string compresses inline and
 * never reaches a limit, so it proves nothing.
 */
function overLimitSessionId(): string {
  let digest = "iss-8125-backfill";
  let out = "";
  while (out.length < 4096) {
    digest = createHash("sha256").update(digest).digest("hex");
    out += digest;
  }
  return out.slice(0, 4096);
}

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
      sessionDetail: { findMany: vi.fn() },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);
    expect(result).toEqual({
      linked: 0,
      unresolved: 0,
      staleParent: 0,
      scanned: 0,
    });
    expect(db.sessionDetail.findMany).not.toHaveBeenCalled();
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
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    expect(db.sessionDetail.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ computeTargetId: "ct1", externalSessionId: { in: ["s1"] } }],
      },
      select: {
        artifactId: true,
        computeTargetId: true,
        externalSessionId: true,
      },
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
    expect(result).toEqual({
      linked: 1,
      unresolved: 0,
      staleParent: 0,
      scanned: 1,
    });
  });

  it("resolves a full batch of distinct identities with ONE session-detail read", async () => {
    // ISS-9118. The read half used to be a `findFirst` per identity, so a
    // saturated batch cost one serial round trip per session — measured at
    // ~55% of the batch's database time against a seeded Postgres. The write
    // half stays per-identity: each `updateMany` writes a DIFFERENT
    // sessionDetailId, so it cannot collapse.
    //
    // Seeded at the real cap so a regression to the per-identity loop is
    // unmissable, and the counts below are hand-written literals rather than
    // arithmetic over the constant they police.
    expect(TRANSCRIPT_BACKFILL_BATCH_SIZE).toBe(500);
    const orphans = Array.from({ length: 500 }, (_, i) => ({
      computeTargetId: `ct${i}`,
      externalSessionId: `s${i}`,
    }));
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue(orphans),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue(
          orphans.map((orphan, i) => ({
            artifactId: `artifact-${i}`,
            computeTargetId: orphan.computeTargetId,
            externalSessionId: orphan.externalSessionId,
          }))
        ),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    expect(db.sessionDetail.findMany).toHaveBeenCalledTimes(1);
    expect(db.sessionDetail.findFirst).not.toHaveBeenCalled();
    expect(db.sessionDetail.findMany.mock.calls[0]?.[0].where.OR).toHaveLength(
      500
    );
    expect(db.sessionTranscript.updateMany).toHaveBeenCalledTimes(500);
    expect(result).toEqual({
      linked: 500,
      unresolved: 0,
      staleParent: 0,
      scanned: 500,
    });
  });

  it("gives each identity its OWN sessionDetailId, never another identity's", async () => {
    // The starvation/mix-up guard on the batched read: one read now answers for
    // every identity, so a lookup keyed wrongly would still produce 500 writes
    // and a matching `linked` — only the pairing catches it.
    const orphans = Array.from({ length: 3 }, (_, i) => ({
      computeTargetId: `ct${i}`,
      externalSessionId: `s${i}`,
    }));
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue(orphans),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          // Returned in an order that does not match the scan order, because
          // the database is under no obligation to preserve it.
          {
            artifactId: "artifact-2",
            computeTargetId: "ct2",
            externalSessionId: "s2",
          },
          {
            artifactId: "artifact-0",
            computeTargetId: "ct0",
            externalSessionId: "s0",
          },
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
      },
    };
    await backfillOrphanTranscriptsBatch(db as never);

    expect(
      db.sessionTranscript.updateMany.mock.calls.map((call) => [
        call[0].where.externalSessionId,
        call[0].data.sessionDetailId,
      ])
    ).toEqual([
      ["s0", "artifact-0"],
      ["s1", "artifact-1"],
      ["s2", "artifact-2"],
    ]);
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
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    expect(db.sessionDetail.findMany.mock.calls[0]?.[0].where.OR).toHaveLength(
      1
    );
    expect(db.sessionTranscript.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      linked: 2,
      unresolved: 0,
      staleParent: 0,
      scanned: 2,
    });
  });

  it("asks for a PROJECTED stored id as itself, never re-projected", async () => {
    // ISS-8125 (operator review) — the landmine this call site carried. The
    // orphan's `externalSessionId` comes OUT of an indexed column, so it is
    // already whatever this repo stores. `projectIndexKey` is deliberately not
    // idempotent (ISS-8254 reserved the marker), so re-projecting it digests the
    // PROJECTION rather than the original session id and lands on a key no
    // `SessionDetail` holds. Nothing throws: the orphan is counted `unresolved`
    // — "awaiting session metadata" — and never links, on this run or any later
    // one.
    const storedKey = projectIndexKey(overLimitSessionId()).value;
    expect(hasProjectedIndexKeyShape(storedKey)).toBe(true);
    const db = {
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computeTargetId: "ct1", externalSessionId: storedKey },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: storedKey,
          },
        ]),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    const arm = db.sessionDetail.findMany.mock.calls[0]?.[0].where.OR[0];
    // Asserted on the `where` the production path issues, not on the return
    // value: the mock answers whatever it is asked, so a result-only assertion
    // stays green with the re-projection restored.
    expect(arm.externalSessionId).toEqual({ in: [storedKey] });
    expect(arm.externalSessionId.in).not.toContain(
      projectIndexKey(storedKey).value
    );
    expect(result).toEqual({
      linked: 1,
      unresolved: 0,
      staleParent: 0,
      scanned: 1,
    });
  });

  it("also offers the projected key for a transcript still stored under its raw id", async () => {
    // The legacy half, and why the stored value alone is not enough: a
    // transcript row written before this ticket projected the column holds the
    // RAW id, while its `SessionDetail` was already stored projected (ISS-8069).
    const rawKey = overLimitSessionId();
    const db = {
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computeTargetId: "ct1", externalSessionId: rawKey },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: projectIndexKey(rawKey).value,
          },
        ]),
      },
    };
    await backfillOrphanTranscriptsBatch(db as never);

    const arm = db.sessionDetail.findMany.mock.calls[0]?.[0].where.OR[0];
    expect(arm.externalSessionId).toEqual({
      in: [rawKey, projectIndexKey(rawKey).value],
    });
  });

  it("defers to the original per-identity read when a SessionDetail exists under BOTH candidate keys", async () => {
    // `SessionDetail` is unique on (computeTargetId, externalSessionId), so the
    // raw key and its projected sibling are two DIFFERENT rows and both can
    // exist. The replaced per-identity `findFirst` had no `orderBy` and picked
    // between them arbitrarily. Ranking the candidates here would decide that
    // selection — a behavior change inside a performance change — so the batch
    // read must hand a genuine multi-match back to the SAME query, unchanged.
    const rawKey = overLimitSessionId();
    const projectedKey = projectIndexKey(rawKey).value;
    const db = {
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computeTargetId: "ct1", externalSessionId: rawKey },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-projected",
            computeTargetId: "ct1",
            externalSessionId: projectedKey,
          },
          {
            artifactId: "artifact-raw",
            computeTargetId: "ct1",
            externalSessionId: rawKey,
          },
        ]),
        // Whatever this returns is what gets linked: the point is that the
        // module does not substitute a ranking of its own for it.
        findFirst: vi.fn().mockResolvedValue({ artifactId: "artifact-chosen" }),
      },
    };
    await backfillOrphanTranscriptsBatch(db as never);

    expect(db.sessionDetail.findFirst).toHaveBeenCalledWith({
      where: {
        computeTargetId: "ct1",
        externalSessionId: { in: [rawKey, projectedKey] },
      },
      select: { artifactId: true },
    });
    expect(db.sessionTranscript.updateMany).toHaveBeenCalledWith({
      where: {
        computeTargetId: "ct1",
        externalSessionId: rawKey,
        sessionDetailId: null,
      },
      data: { sessionDetailId: "artifact-chosen" },
    });
  });

  it("skips an identity whose SessionDetail was deleted after the batch read, and still links the rest", async () => {
    // The read-to-write window the batched read opens: a retention/phantom
    // sweep drops the SessionDetail after it is resolved, and a transcript row
    // for the same identity is (re-)created orphaned before the write lands, so
    // there IS a still-orphaned row to match and the FK names a deleted parent.
    // That must cost one identity, not the rest of the batch.
    const foreignKeyViolation = Object.assign(new Error("FK violation"), {
      code: "P2003",
    });
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          { computeTargetId: "ct1", externalSessionId: "gone" },
          { computeTargetId: "ct1", externalSessionId: "alive" },
        ]),
        updateMany: vi
          .fn()
          .mockRejectedValueOnce(foreignKeyViolation)
          .mockResolvedValue({ count: 3 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-gone",
            computeTargetId: "ct1",
            externalSessionId: "gone",
          },
          {
            artifactId: "artifact-alive",
            computeTargetId: "ct1",
            externalSessionId: "alive",
          },
        ]),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);

    expect(result).toEqual({
      linked: 3,
      unresolved: 0,
      staleParent: 1,
      scanned: 2,
    });
    expect(db.sessionTranscript.updateMany).toHaveBeenCalledTimes(2);
  });

  it("still propagates a write failure that is NOT a foreign-key violation", async () => {
    // Only the vanished-parent race is absorbed. A connection drop or a
    // constraint the sweep does not understand must still fail the run.
    const db = {
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computeTargetId: "ct1", externalSessionId: "s1" },
          ]),
        updateMany: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("connection lost"), { code: "P1017" })
          ),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
      },
    };
    await expect(backfillOrphanTranscriptsBatch(db as never)).rejects.toThrow(
      "connection lost"
    );
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
      sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);
    expect(db.sessionTranscript.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      linked: 0,
      unresolved: 1,
      staleParent: 0,
      scanned: 1,
    });
  });

  it("counts only the identities the batch read missed as unresolved", async () => {
    // A partially-answered batch: the single read returns rows for two of three
    // identities, so `unresolved` must be 1 — not 0 (every identity treated as
    // resolved) and not 3 (the read treated as all-or-nothing).
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          { computeTargetId: "ct1", externalSessionId: "s1" },
          { computeTargetId: "ct1", externalSessionId: "s2" },
          { computeTargetId: "ct1", externalSessionId: "s3" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
          {
            artifactId: "artifact-3",
            computeTargetId: "ct1",
            externalSessionId: "s3",
          },
        ]),
      },
    };
    const result = await backfillOrphanTranscriptsBatch(db as never);
    expect(result).toEqual({
      linked: 2,
      unresolved: 1,
      staleParent: 0,
      scanned: 3,
    });
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
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
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
      sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    stubWithDb(db);
    const result = await transcriptBackfillService.runBackfill();
    expect(result.exitCode).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.unresolved).toBe(TRANSCRIPT_BACKFILL_BATCH_SIZE);
    // Exactly one scan — linked === 0 breaks the loop immediately.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("reports a session deleted mid-run without failing the sweep or losing the links it committed", async () => {
    // The whole point of absorbing the FK race: the run stays green, the work
    // that did commit is still counted, and the skipped identity is visible
    // rather than folded into `unresolved` (which means "metadata not here
    // yet", not "session gone").
    const foreignKeyViolation = Object.assign(new Error("FK violation"), {
      code: "P2003",
    });
    const db = {
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          { computeTargetId: "ct1", externalSessionId: "gone" },
          { computeTargetId: "ct1", externalSessionId: "alive" },
        ]),
        updateMany: vi
          .fn()
          .mockRejectedValueOnce(foreignKeyViolation)
          .mockResolvedValue({ count: 2 }),
      },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "artifact-gone",
            computeTargetId: "ct1",
            externalSessionId: "gone",
          },
          {
            artifactId: "artifact-alive",
            computeTargetId: "ct1",
            externalSessionId: "alive",
          },
        ]),
      },
    };
    stubWithDb(db);
    const result = await transcriptBackfillService.runBackfill();
    expect(result.exitCode).toBe(0);
    expect(result.linked).toBe(2);
    expect(result.unresolved).toBe(0);
    expect(result.staleParent).toBe(1);
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
