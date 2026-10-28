import { SessionOrigin, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expiredSessionWhere,
  FALLBACK_SESSION_RETENTION_DAYS,
  getSessionRetentionDays,
  INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE,
  INCOMPLETE_INVOCATION_GENERATION_RETENTION_HOURS,
  purgeExpiredSessionsBatch,
  purgeIncompleteInvocationGenerationsBatch,
  retentionCutoff,
  sessionRetentionService,
} from "./retention-service";

const mocks = vi.hoisted(() => ({
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: mocks.deleteTranscriptObjects,
}));

describe("getSessionRetentionDays", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back when unset", () => {
    vi.stubEnv("SESSION_RETENTION_DAYS", undefined);
    expect(getSessionRetentionDays()).toBe(FALLBACK_SESSION_RETENTION_DAYS);
  });

  it("falls back on empty, non-numeric, or non-positive values", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      vi.stubEnv("SESSION_RETENTION_DAYS", raw);
      expect(getSessionRetentionDays()).toBe(FALLBACK_SESSION_RETENTION_DAYS);
    }
  });

  it("uses a positive numeric override", () => {
    vi.stubEnv("SESSION_RETENTION_DAYS", "30");
    expect(getSessionRetentionDays()).toBe(30);
  });
});

describe("retentionCutoff", () => {
  it("subtracts the window in days from now", () => {
    const now = new Date("2026-06-26T00:00:00.000Z");
    expect(retentionCutoff(now, 10).toISOString()).toBe(
      "2026-06-16T00:00:00.000Z"
    );
  });
});

describe("expiredSessionWhere", () => {
  // ISS-6463 made `lastActivityAt` NOT NULL, so the disjunction this used to
  // assert — an activity test OR a `sessionStartedAt` fallback for a null
  // activity timestamp — is one comparison on the single anchor column.
  it("scopes to DESKTOP_SYNC and expires on lastActivityAt alone", () => {
    const cutoff = new Date("2026-06-01T00:00:00.000Z");
    expect(expiredSessionWhere(cutoff)).toEqual({
      origin: SessionOrigin.DESKTOP_SYNC,
      lastActivityAt: { lt: cutoff },
    });
  });
});

describe("purgeExpiredSessionsBatch", () => {
  const cutoff = new Date("2026-06-01T00:00:00.000Z");

  it("skips the delete and returns no keys when nothing is expired", async () => {
    const db = {
      sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn(), deleteMany: vi.fn() },
      artifact: { deleteMany: vi.fn() },
    };
    const result = await purgeExpiredSessionsBatch(db as never, cutoff);
    expect(result).toEqual({
      candidateCount: 0,
      deleted: 0,
      transcriptKeys: [],
    });
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.findMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.deleteMany).not.toHaveBeenCalled();
  });

  it("purges the expiring sessions' transcript rows after the artifacts and returns their storage keys", async () => {
    const db = {
      sessionDetail: {
        // ISS-10164 (review): the candidate SELECT, then the survivors probe the
        // guarded delete added. No survivors here — both rows were still expired
        // at delete time, so both are reclaimed.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              artifactId: "a1",
              computeTargetId: "ct1",
              externalSessionId: "s1",
            },
            {
              artifactId: "a2",
              computeTargetId: "ct2",
              externalSessionId: "s2",
            },
          ])
          .mockResolvedValue([]),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          { objectStorageKey: "transcripts/a1/main" },
          { objectStorageKey: "transcripts/a2/main" },
          // Empty keys (never-uploaded rows) are filtered out.
          { objectStorageKey: "" },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const result = await purgeExpiredSessionsBatch(db as never, cutoff, 10);
    expect(result).toEqual({
      candidateCount: 2,
      deleted: 2,
      transcriptKeys: ["transcripts/a1/main", "transcripts/a2/main"],
    });
    expect(db.sessionDetail.findMany).toHaveBeenCalledWith({
      where: expiredSessionWhere(cutoff),
      select: {
        artifactId: true,
        computeTargetId: true,
        externalSessionId: true,
      },
      // ISS-10164: the page is ordered oldest-expired first and terminated by
      // the primary key, so tied `lastActivityAt` rows cannot be re-served or
      // skipped between batches.
      orderBy: [{ lastActivityAt: "asc" }, { artifactId: "asc" }],
      take: 10,
    });
    // Transcripts are matched by session identity (computeTargetId,
    // externalSessionId), not the nullable sessionDetailId FK, so rows uploaded
    // before the metadata lane resolved their link are still reclaimed.
    // ISS-8200: `externalSessionId` here came OUT of `SessionDetail`, so the
    // transcript match is over every key that identity could be stored under —
    // a pre-ISS-8125 transcript row still holds the RAW value while its session
    // was re-keyed by ISS-8069. An id inside the byte budget yields exactly one
    // candidate, so the predicate is unchanged for ordinary traffic.
    const identityWhere = {
      OR: [
        { computeTargetId: "ct1", externalSessionId: { in: ["s1"] } },
        { computeTargetId: "ct2", externalSessionId: { in: ["s2"] } },
      ],
    };
    expect(db.sessionTranscript.findMany).toHaveBeenCalledWith({
      where: identityWhere,
      select: { objectStorageKey: true },
    });
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: identityWhere,
    });
    // ISS-10164 (review, whitlockk): the delete REPEATS the expiry predicate, so a
    // session that refreshed after the SELECT is spared rather than cascaded on
    // a captured id.
    expect(db.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] }, session: expiredSessionWhere(cutoff) },
    });
    // Transcript rows are removed AFTER the artifacts now, and this inverted
    // assertion is a deliberate behaviour change, not a relaxed one. The prior
    // order's stated reason — "while their SetNull FK still points at the
    // SessionDetail rows" — does not hold: the lookup is the identity tuple
    // `(computeTargetId, externalSessionId)`, which the cascade never touches,
    // and `sessionDetailId` is explicitly NOT the key. Deleting first meant a
    // spared session lost its archive metadata anyway, leaving S3 objects nobody
    // could name. Reclaiming after the delete is what makes "only the rows that
    // actually went away" knowable.
    expect(db.artifact.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.sessionTranscript.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it("reclaims transcript rows whose sessionDetailId was never linked (matched by identity)", async () => {
    // A transcript uploaded before metadata resolution keeps sessionDetailId
    // null; matching by identity still finds and purges it. The mock echoes the
    // identity where back so we prove the sweep never falls back to the FK.
    const db = {
      sessionDetail: {
        // Candidate SELECT, then the survivors probe the guarded delete added.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              artifactId: "a1",
              computeTargetId: "ct1",
              externalSessionId: "s1",
            },
          ])
          .mockResolvedValue([]),
      },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ objectStorageKey: "transcripts/a1/main" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const result = await purgeExpiredSessionsBatch(db as never, cutoff, 10);
    expect(result.transcriptKeys).toEqual(["transcripts/a1/main"]);
    // ISS-8200: `externalSessionId` here came OUT of `SessionDetail`, so the
    // transcript match is over every key that identity could be stored under —
    // a pre-ISS-8125 transcript row still holds the RAW value while its session
    // was re-keyed by ISS-8069. An id inside the byte budget yields exactly one
    // candidate, so the predicate is unchanged for ordinary traffic.
    const identityWhere = {
      OR: [{ computeTargetId: "ct1", externalSessionId: { in: ["s1"] } }],
    };
    expect(db.sessionTranscript.findMany).toHaveBeenCalledWith({
      where: identityWhere,
      select: { objectStorageKey: true },
    });
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: identityWhere,
    });
  });

  // ISS-10164 (review, whitlockk): the race this guard closes. A session that takes
  // a fresh sync between the SELECT and the DELETE is no longer expired, so the
  // delete must leave it — and its transcripts, and the S3 archives behind them
  // — alone. Modelled by the survivors probe returning that row: it still has a
  // `SessionDetail`, which is exactly what "the cascade did not take it" means.
  it("spares a session that refreshed after the SELECT and keeps its transcripts", async () => {
    const db = {
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              artifactId: "refreshed",
              computeTargetId: "ct1",
              externalSessionId: "s1",
            },
            {
              artifactId: "stale",
              computeTargetId: "ct2",
              externalSessionId: "s2",
            },
          ])
          .mockResolvedValue([{ artifactId: "refreshed" }]),
      },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ objectStorageKey: "transcripts/stale/main" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    const result = await purgeExpiredSessionsBatch(db as never, cutoff, 10);

    // The delete repeats the expiry predicate instead of trusting captured ids.
    expect(db.artifact.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["refreshed", "stale"] },
        session: expiredSessionWhere(cutoff),
      },
    });
    // Only the row that actually went away is reclaimed. Asserting the returned
    // key list alone would stay green while the spared session's archive rows
    // were deleted underneath it, so the WHERE is what this pins.
    // ISS-8200: `externalSessionId` here came OUT of `SessionDetail`, so the
    // match offers the stored key plus the key a pre-ISS-8125 raw transcript
    // row would hold — the same candidate-set shape the sibling cases above
    // assert, now narrowed to the sessions the guarded delete actually removed.
    const vanishedOnly = {
      OR: [{ computeTargetId: "ct2", externalSessionId: { in: ["s2"] } }],
    };
    expect(db.sessionTranscript.findMany).toHaveBeenCalledWith({
      where: vanishedOnly,
      select: { objectStorageKey: true },
    });
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: vanishedOnly,
    });
    expect(result).toEqual({
      candidateCount: 2,
      deleted: 1,
      transcriptKeys: ["transcripts/stale/main"],
    });
  });
});

describe("purgeIncompleteInvocationGenerationsBatch", () => {
  it("globally deletes only stale incomplete candidates and rechecks their state", async () => {
    const cutoff = new Date("2026-07-23T12:00:00.000Z");
    const db = {
      agentComponentInvocationGeneration: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "stale-session-a" },
            { id: "stale-session-b" },
          ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const deleted = await purgeIncompleteInvocationGenerationsBatch(
      db as never,
      cutoff,
      10
    );

    expect(deleted).toEqual({ candidateCount: 2, deleted: 2 });
    const incompleteWhere = {
      activeAt: null,
      completedAt: null,
      updatedAt: { lt: cutoff },
    };
    expect(db.agentComponentInvocationGeneration.findMany).toHaveBeenCalledWith(
      {
        where: incompleteWhere,
        select: { id: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: 10,
      }
    );
    expect(
      db.agentComponentInvocationGeneration.deleteMany
    ).toHaveBeenCalledWith({
      where: {
        id: { in: ["stale-session-a", "stale-session-b"] },
        ...incompleteWhere,
      },
    });
  });
});

describe("sessionRetentionService", () => {
  afterEach(() => {
    mocks.deleteTranscriptObjects.mockReset();
  });

  it("purges reclaimed transcript S3 objects after a batch commits", async () => {
    const now = new Date("2026-06-26T00:00:00.000Z");
    const db = {
      agentComponentInvocationGeneration: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
      },
      sessionDetail: {
        // Candidate SELECT, then the survivors probe the guarded delete added.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              artifactId: "a1",
              computeTargetId: "ct1",
              externalSessionId: "s1",
            },
          ])
          .mockResolvedValue([]),
      },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ objectStorageKey: "transcripts/a1/main" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await sessionRetentionService.runRetentionSweep(now, 365);

      expect(result.exitCode).toBe(0);
      expect(result.deleted).toBe(1);
      expect(mocks.deleteTranscriptObjects).toHaveBeenCalledWith([
        "transcripts/a1/main",
      ]);
    } finally {
      txSpy.mockRestore();
    }
  });

  it("does not fail the sweep when the transcript S3 purge errors", async () => {
    const now = new Date("2026-06-26T00:00:00.000Z");
    mocks.deleteTranscriptObjects.mockRejectedValue(new Error("s3 down"));
    const db = {
      agentComponentInvocationGeneration: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
      },
      sessionDetail: {
        // Candidate SELECT, then the survivors probe the guarded delete added.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              artifactId: "a1",
              computeTargetId: "ct1",
              externalSessionId: "s1",
            },
          ])
          .mockResolvedValue([]),
      },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ objectStorageKey: "transcripts/a1/main" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await sessionRetentionService.runRetentionSweep(now, 365);

      // Best-effort: the row delete already committed, so the S3 failure is
      // logged, not surfaced as a sweep error.
      expect(result.exitCode).toBe(0);
      expect(result.deleted).toBe(1);
      expect(mocks.deleteTranscriptObjects).toHaveBeenCalledTimes(1);
    } finally {
      txSpy.mockRestore();
    }
  });

  it("runs abandoned invocation cleanup even when no sessions expire", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const cutoff = new Date(
      now.getTime() -
        INCOMPLETE_INVOCATION_GENERATION_RETENTION_HOURS * 60 * 60 * 1000
    );
    const db = {
      agentComponentInvocationGeneration: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "abandoned-other-session" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn(), deleteMany: vi.fn() },
      artifact: { deleteMany: vi.fn() },
    };
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await sessionRetentionService.runRetentionSweep(now, 365);

      expect(result.exitCode).toBe(0);
      expect(
        db.agentComponentInvocationGeneration.findMany
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            activeAt: null,
            completedAt: null,
            updatedAt: { lt: cutoff },
          },
          take: INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE,
        })
      );
      expect(result.summary).toContain("1 incomplete invocation generation(s)");
      expect(db.sessionDetail.findMany).toHaveBeenCalledOnce();
    } finally {
      txSpy.mockRestore();
    }
  });

  it("continues past a full candidate page when a concurrent completion reduces the delete count", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const firstPage = Array.from(
      { length: INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE },
      (_, index) => ({ id: `stale-${index}` })
    );
    const db = {
      agentComponentInvocationGeneration: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce(firstPage)
          .mockResolvedValueOnce([{ id: "stale-tail" }]),
        deleteMany: vi
          .fn()
          .mockResolvedValueOnce({
            count: INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE - 1,
          })
          .mockResolvedValueOnce({ count: 1 }),
      },
      sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn(), deleteMany: vi.fn() },
      artifact: { deleteMany: vi.fn() },
    };
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await sessionRetentionService.runRetentionSweep(now, 365);

      expect(result.exitCode).toBe(0);
      expect(
        db.agentComponentInvocationGeneration.findMany
      ).toHaveBeenCalledTimes(2);
      expect(result.summary).toContain(
        `${INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE} incomplete invocation generation(s)`
      );
    } finally {
      txSpy.mockRestore();
    }
  });
});
