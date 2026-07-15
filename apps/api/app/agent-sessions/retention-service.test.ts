import { SessionOrigin, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expiredSessionWhere,
  FALLBACK_SESSION_RETENTION_DAYS,
  getSessionRetentionDays,
  purgeExpiredSessionsBatch,
  retentionCutoff,
  sessionRetentionService,
} from "./retention-service";

const mocks = vi.hoisted(() => ({
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/aws", () => ({
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
  it("scopes to DESKTOP_SYNC and uses lastActivityAt with sessionStartedAt fallback", () => {
    const cutoff = new Date("2026-06-01T00:00:00.000Z");
    expect(expiredSessionWhere(cutoff)).toEqual({
      origin: SessionOrigin.DESKTOP_SYNC,
      OR: [
        { lastActivityAt: { lt: cutoff } },
        { lastActivityAt: null, sessionStartedAt: { lt: cutoff } },
      ],
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
    expect(result).toEqual({ deleted: 0, transcriptKeys: [] });
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.findMany).not.toHaveBeenCalled();
    expect(db.sessionTranscript.deleteMany).not.toHaveBeenCalled();
  });

  it("purges the expiring sessions' transcript rows before the artifacts and returns their storage keys", async () => {
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
      take: 10,
    });
    // Transcripts are matched by session identity (computeTargetId,
    // externalSessionId), not the nullable sessionDetailId FK, so rows uploaded
    // before the metadata lane resolved their link are still reclaimed.
    const identityWhere = {
      OR: [
        { computeTargetId: "ct1", externalSessionId: "s1" },
        { computeTargetId: "ct2", externalSessionId: "s2" },
      ],
    };
    expect(db.sessionTranscript.findMany).toHaveBeenCalledWith({
      where: identityWhere,
      select: { objectStorageKey: true },
    });
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: identityWhere,
    });
    expect(db.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] } },
    });
    // Transcript rows must be removed before the artifacts, while their
    // SetNull FK still points at the SessionDetail rows.
    expect(
      db.sessionTranscript.deleteMany.mock.invocationCallOrder[0]
    ).toBeLessThan(db.artifact.deleteMany.mock.invocationCallOrder[0]);
  });

  it("reclaims transcript rows whose sessionDetailId was never linked (matched by identity)", async () => {
    // A transcript uploaded before metadata resolution keeps sessionDetailId
    // null; matching by identity still finds and purges it. The mock echoes the
    // identity where back so we prove the sweep never falls back to the FK.
    const db = {
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "a1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
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
    const identityWhere = {
      OR: [{ computeTargetId: "ct1", externalSessionId: "s1" }],
    };
    expect(db.sessionTranscript.findMany).toHaveBeenCalledWith({
      where: identityWhere,
      select: { objectStorageKey: true },
    });
    expect(db.sessionTranscript.deleteMany).toHaveBeenCalledWith({
      where: identityWhere,
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
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "a1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
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
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "a1",
            computeTargetId: "ct1",
            externalSessionId: "s1",
          },
        ]),
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
});
