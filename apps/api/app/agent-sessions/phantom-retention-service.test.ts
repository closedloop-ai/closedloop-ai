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

vi.mock("@repo/aws", () => ({
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

  it("requires idle AND aged AND no-PR AND desktop-sync origin (no data loss)", () => {
    const where = phantomSessionWhere(cutoff, null);
    // Origin gate: LOOP-materialized sessions are never swept here.
    expect(where.origin).toBe(SessionOrigin.DESKTOP_SYNC);
    // The idle SSOT predicate is ANDed verbatim — purge/read/sync agree on
    // "phantom".
    expect(where.AND).toContainEqual(SESSION_IDLE_WHERE);
    // The no-PR guard is the NEGATION of the has-PR predicate: a session that
    // produced a PR is spared even if its rollup reads zero.
    expect(where.AND).toContainEqual({ NOT: SESSION_HAS_PR_WHERE });
    // The age (late-chunk) guard: last activity older than the cutoff, with the
    // sessionStartedAt fallback for pre-backfill rows.
    expect(where.AND).toContainEqual({
      OR: [
        { lastActivityAt: { lt: cutoff } },
        { lastActivityAt: null, sessionStartedAt: { lt: cutoff } },
      ],
    });
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
    expect(result).toEqual({ deleted: 0, transcriptKeys: [] });
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
      deleted: 2,
      transcriptKeys: ["transcripts/a1/main"],
    });
    // The selection uses the full phantom predicate — the safety gates travel
    // with every batch.
    expect(db.sessionDetail.findMany).toHaveBeenCalledWith({
      where: phantomSessionWhere(cutoff, null),
      select: {
        artifactId: true,
        computeTargetId: true,
        externalSessionId: true,
      },
      take: 10,
    });
    const identityWhere = {
      OR: [
        { computeTargetId: "ct1", externalSessionId: "s1" },
        { computeTargetId: "ct2", externalSessionId: "s2" },
      ],
    };
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: identityWhere,
    });
    expect(db.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] } },
    });
    // Transcript rows are removed before the artifacts (SetNull FK still points
    // at the SessionDetail rows).
    expect(
      db.sessionTranscript.deleteMany.mock.invocationCallOrder[0]
    ).toBeLessThan(db.artifact.deleteMany.mock.invocationCallOrder[0]);
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
      // Two finds: the full batch, then the empty re-find that stops the loop.
      expect(db.sessionDetail.findMany).toHaveBeenCalledTimes(2);
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
      expect(result.summary).toContain("Phantom session sweep failed");
    } finally {
      txSpy.mockRestore();
    }
  });
});
