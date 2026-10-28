import { SessionOrigin, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_PHANTOM_SESSION_AGE_HOURS,
  getPhantomSessionAgeHours,
  phantomCutoff,
  phantomRetentionService,
  phantomSessionWhere,
  purgePhantomSessionsBatch,
} from "./phantom-retention-service";
import {
  SESSION_HAS_PR_WHERE,
  SESSION_IDLE_WHERE,
} from "./service/query-builder";

const mocks = vi.hoisted(() => ({
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: mocks.deleteTranscriptObjects,
}));

describe("getPhantomSessionAgeHours", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back when unset", () => {
    vi.stubEnv("PHANTOM_SESSION_AGE_HOURS", undefined);
    expect(getPhantomSessionAgeHours()).toBe(
      FALLBACK_PHANTOM_SESSION_AGE_HOURS
    );
  });

  it("falls back on empty, non-numeric, or non-positive values", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      vi.stubEnv("PHANTOM_SESSION_AGE_HOURS", raw);
      expect(getPhantomSessionAgeHours()).toBe(
        FALLBACK_PHANTOM_SESSION_AGE_HOURS
      );
    }
  });

  it("uses a positive numeric override", () => {
    vi.stubEnv("PHANTOM_SESSION_AGE_HOURS", "6");
    expect(getPhantomSessionAgeHours()).toBe(6);
  });
});

describe("phantomCutoff", () => {
  it("subtracts the window in hours from now", () => {
    const now = new Date("2026-06-26T12:00:00.000Z");
    expect(phantomCutoff(now, 24).toISOString()).toBe(
      "2026-06-25T12:00:00.000Z"
    );
  });
});

describe("phantomSessionWhere", () => {
  const cutoff = new Date("2026-06-01T00:00:00.000Z");

  it("requires idle AND aged AND no-PR AND no pending chunk AND desktop-sync origin", () => {
    const where = phantomSessionWhere(cutoff, null);
    // Origin gate: LOOP-materialized sessions are never swept here.
    expect(where.origin).toBe(SessionOrigin.DESKTOP_SYNC);
    // The idle SSOT predicate is ANDed verbatim — purge/read/sync agree on
    // "phantom".
    expect(where.AND).toContainEqual(SESSION_IDLE_WHERE);
    // The no-PR guard is the NEGATION of the has-PR predicate: a session that
    // produced a PR is spared even if its rollup reads zero.
    expect(where.AND).toContainEqual({ NOT: SESSION_HAS_PR_WHERE });
    // The age guard: last activity older than the cutoff. ISS-6463
    // made `lastActivityAt` NOT NULL, so this is one comparison on the anchor
    // column rather than a disjunction with a `sessionStartedAt` fallback.
    expect(where.AND).toContainEqual({ lastActivityAt: { lt: cutoff } });
    // A session being rebuilt across chunk transactions can transiently look
    // idle even when it is real. The open-sequence marker keeps it out of the
    // destructive sweep until the final chunk clears the marker.
    expect(where.AND).toContainEqual({ pendingChunkRevision: null });
    // ISS-5801: a STAGED (not-yet-active) invocation generation keeps
    // component_invocation_count at 0, so the idle predicate cannot see the
    // in-flight work — any generation row spares its parent from the sweep.
    expect(where.AND).toContainEqual({ invocationGenerations: { none: {} } });
    // No org scope when orgId is null.
    expect(where.artifact).toBeUndefined();
  });

  it("adds an org scope when orgId is provided", () => {
    const where = phantomSessionWhere(cutoff, "org-1");
    expect(where.artifact).toEqual({ is: { organizationId: "org-1" } });
  });
});

describe("purgePhantomSessionsBatch", () => {
  const cutoff = new Date("2026-06-01T00:00:00.000Z");

  it("skips the delete and returns no keys when nothing is a phantom", async () => {
    const db = {
      sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn(), deleteMany: vi.fn() },
      artifact: { deleteMany: vi.fn() },
    };
    const result = await purgePhantomSessionsBatch(db as never, cutoff, null);
    expect(result).toEqual({
      candidateCount: 0,
      deleted: 0,
      deletedSessionIds: [],
      deletedSessionIdsComplete: true,
      transcriptKeys: [],
    });
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.findMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.deleteMany).not.toHaveBeenCalled();
  });

  it("selects phantoms via phantomSessionWhere, then deletes their artifacts and reclaims transcript keys", async () => {
    const db = {
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          { artifactId: "a1", computeTargetId: "ct1", externalSessionId: "s1" },
          { artifactId: "a2", computeTargetId: "ct2", externalSessionId: "s2" },
        ]),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          { objectStorageKey: "transcripts/a1/main" },
          // Empty keys (never-uploaded rows) are filtered out.
          { objectStorageKey: "" },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const result = await purgePhantomSessionsBatch(
      db as never,
      cutoff,
      null,
      10
    );
    expect(result).toEqual({
      candidateCount: 2,
      deleted: 2,
      deletedSessionIds: ["a1", "a2"],
      deletedSessionIdsComplete: true,
      transcriptKeys: ["transcripts/a1/main"],
    });
    // The selection uses the full phantom predicate — the safety gates travel
    // with every batch — and carries the ISS-10171 total ordering, so a
    // `take`-bounded page has a defined answer when rows tie on
    // `lastActivityAt`.
    expect(db.sessionDetail.findMany).toHaveBeenCalledWith({
      where: phantomSessionWhere(cutoff, null),
      select: {
        artifactId: true,
        computeTargetId: true,
        externalSessionId: true,
      },
      orderBy: [{ lastActivityAt: "asc" }, { artifactId: "asc" }],
      take: 10,
    });
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
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: identityWhere,
    });
    // The DELETE re-checks the open-sequence marker: a chunk-0 apply that
    // commits between the findMany and this statement is visible under READ
    // COMMITTED, so an id-only delete would sweep it anyway.
    expect(db.artifact.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["a1", "a2"] },
        session: { is: { pendingChunkRevision: null } },
      },
    });
    // Transcripts are reclaimed AFTER the artifact delete, because which rows
    // the delete-time recheck actually removed is not known until it returns.
    // `SessionTranscript` keeps its own identity columns, so the rows stay
    // findable once the SetNull FK clears.
    expect(
      db.sessionTranscript.deleteMany.mock.invocationCallOrder[0]
    ).toBeGreaterThan(db.artifact.deleteMany.mock.invocationCallOrder[0]);
  });

  it("reclaims transcripts only for the rows the delete actually removed", async () => {
    const phantoms = [
      { artifactId: "a1", computeTargetId: "ct1", externalSessionId: "s1" },
      { artifactId: "a2", computeTargetId: "ct2", externalSessionId: "s2" },
    ];
    const db = {
      sessionDetail: {
        findMany: vi
          .fn()
          // Selection sees both rows...
          .mockResolvedValueOnce(phantoms)
          // ...and after the delete, a2 is still present: its chunk-0 apply
          // committed in the select→delete gap, so the recheck spared it.
          .mockResolvedValueOnce([{ artifactId: "a2" }]),
      },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ objectStorageKey: "transcripts/a1/main" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    const result = await purgePhantomSessionsBatch(db as never, cutoff, null);

    expect(result).toEqual({
      candidateCount: 2,
      deleted: 1,
      deletedSessionIds: [],
      deletedSessionIdsComplete: false,
      transcriptKeys: ["transcripts/a1/main"],
    });
    // The spared session keeps its transcript row and its S3 object — only the
    // identity of the row that actually went away is purged.
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

  it("purges no transcripts when the delete removed nothing", async () => {
    const phantoms = [
      { artifactId: "a1", computeTargetId: "ct1", externalSessionId: "s1" },
    ];
    const db = {
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce(phantoms)
          .mockResolvedValueOnce([{ artifactId: "a1" }]),
      },
      sessionTranscript: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    const result = await purgePhantomSessionsBatch(db as never, cutoff, null);

    expect(result).toEqual({
      candidateCount: 1,
      deleted: 0,
      deletedSessionIds: [],
      deletedSessionIdsComplete: false,
      transcriptKeys: [],
    });
    expect(db.sessionTranscript.findMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.deleteMany).not.toHaveBeenCalled();
  });

  it("does not claim selected ids when the delete count cannot prove which rows were deleted", async () => {
    const db = {
      sessionDetail: {
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
          // A concurrent sweep took one row; which one is not observable, so the
          // batch refuses to claim either id as proven-deleted.
          .mockResolvedValueOnce([]),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    const result = await purgePhantomSessionsBatch(db as never, cutoff, null);

    expect(result).toMatchObject({
      deleted: 1,
      deletedSessionIds: [],
      deletedSessionIdsComplete: false,
    });
  });
});

describe("phantomRetentionService", () => {
  afterEach(() => {
    mocks.deleteTranscriptObjects.mockReset();
  });

  it("re-finds candidates inside each delete transaction (late-chunk safety)", async () => {
    // A session that was idle at selection but received a substantive chunk
    // before the delete transaction ran must NOT be purged. Model this by
    // returning the phantom on the first tx find and NOTHING on the second: the
    // sweep converges (deletes the still-phantom batch, then the empty re-find
    // stops the loop) and never deletes a row the second find excluded.
    const now = new Date("2026-06-26T00:00:00.000Z");
    let findCall = 0;
    const db = {
      sessionDetail: {
        findMany: vi.fn().mockImplementation(() => {
          findCall += 1;
          return Promise.resolve(
            findCall === 1
              ? Array.from({ length: 500 }, (_, i) => ({
                  artifactId: `a${i}`,
                  computeTargetId: `ct${i}`,
                  externalSessionId: `s${i}`,
                }))
              : []
          );
        }),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 500 }) },
    };
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await phantomRetentionService.runPhantomSweep(now, 24);
      expect(result.exitCode).toBe(0);
      expect(result.deleted).toBe(500);
      expect(result.deletedSessionIds).toEqual(
        Array.from({ length: 100 }, (_, i) => `a${i}`)
      );
      expect(result.deletedSessionIdsComplete).toBe(false);
      // Two finds: the full batch, then the empty re-find that stops the loop.
      expect(db.sessionDetail.findMany).toHaveBeenCalledTimes(2);
    } finally {
      txSpy.mockRestore();
    }
  });

  it("keeps sweeping when a full batch deletes short of its candidate count", async () => {
    // 500 candidates, 499 deleted: one row was spared by the delete-time marker
    // recheck (or taken by an overlapping worker). Terminating on `deleted`
    // would strand every remaining candidate until the next daily run.
    const now = new Date("2026-06-26T00:00:00.000Z");
    const db = createShortDeleteSweepDb();
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await phantomRetentionService.runPhantomSweep(now, 24);
      expect(result.exitCode).toBe(0);
      // 499 from the short batch plus the 1 the second batch reached.
      expect(result.deleted).toBe(500);
      expect(db.artifact.deleteMany).toHaveBeenCalledTimes(2);
    } finally {
      txSpy.mockRestore();
    }
  });

  it("reports spared candidates as a counted shortfall, not an inference", async () => {
    // ISS-10171: 500 selected, 499 deleted. The one the delete-time marker
    // recheck (or an overlapping sweep) kept is a REAL number an operator can
    // watch, and it is counted only from the batch whose candidates it
    // describes — the second batch deletes everything it selected and adds none.
    const now = new Date("2026-06-26T00:00:00.000Z");
    const db = createShortDeleteSweepDb();
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      );

    try {
      const result = await phantomRetentionService.runPhantomSweep(now, 24);
      expect(result.spared).toBe(1);
      expect(result.deleted).toBe(500);
    } finally {
      txSpy.mockRestore();
    }
  });

  it("purges reclaimed transcript S3 objects after a batch commits", async () => {
    const now = new Date("2026-06-26T00:00:00.000Z");
    const db = {
      sessionDetail: {
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
      const result = await phantomRetentionService.runPhantomSweep(now, 24);
      expect(result.exitCode).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.deletedSessionIds).toEqual(["a1"]);
      expect(result.deletedSessionIdsComplete).toBe(true);
      expect(mocks.deleteTranscriptObjects).toHaveBeenCalledWith([
        "transcripts/a1/main",
      ]);
    } finally {
      txSpy.mockRestore();
    }
  });

  it("returns exitCode 1 when the sweep errors", async () => {
    const now = new Date("2026-06-26T00:00:00.000Z");
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockRejectedValue(new Error("db down"));
    try {
      const result = await phantomRetentionService.runPhantomSweep(now, 24);
      expect(result.exitCode).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.deletedSessionIds).toEqual([]);
      expect(result.deletedSessionIdsComplete).toBe(true);
      expect(result.summary).toContain("Phantom session sweep failed");
    } finally {
      txSpy.mockRestore();
    }
  });

  it("preserves committed deletion evidence when a later batch errors", async () => {
    const now = new Date("2026-06-26T00:00:00.000Z");
    const db = {
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 500 }, (_, i) => ({
            artifactId: `a${i}`,
            computeTargetId: `ct${i}`,
            externalSessionId: `s${i}`,
          }))
        ),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 500 }) },
    };
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementationOnce((callback: (tx: never) => unknown) =>
        Promise.resolve(callback(db as never))
      )
      .mockRejectedValueOnce(new Error("second batch failed"));

    try {
      const result = await phantomRetentionService.runPhantomSweep(now, 24);
      expect(result.exitCode).toBe(1);
      expect(result.deleted).toBe(500);
      expect(result.deletedSessionIds).toEqual(
        Array.from({ length: 100 }, (_, i) => `a${i}`)
      );
      expect(result.deletedSessionIdsComplete).toBe(false);
      expect(result.summary).toContain("failed after deleting 500");
    } finally {
      txSpy.mockRestore();
    }
  });
});

/**
 * The 500-selected / 499-deleted sweep fixture: a full batch whose DELETE falls
 * one short — the delete-time `pendingChunkRevision` recheck spared a row, or an
 * overlapping sweep took it — followed by a second batch that drains the rest of
 * the backlog. Two cases read different facts off this one shape (that the sweep
 * keeps going, and what it counts as spared), so the shape lives here once.
 */
function createShortDeleteSweepDb() {
  const fullBatch = Array.from({ length: 500 }, (_, i) => ({
    artifactId: `a${i}`,
    computeTargetId: `ct${i}`,
    externalSessionId: `s${i}`,
  }));
  return {
    sessionDetail: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(fullBatch)
        // Survivor re-read for the short batch: a499 was spared.
        .mockResolvedValueOnce([{ artifactId: "a499" }])
        // The sweep continues into the remaining backlog.
        .mockResolvedValueOnce([
          {
            artifactId: "b1",
            computeTargetId: "ctb1",
            externalSessionId: "sb1",
          },
        ]),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifact: {
      deleteMany: vi
        .fn()
        .mockResolvedValueOnce({ count: 499 })
        .mockResolvedValueOnce({ count: 1 }),
    },
  };
}
