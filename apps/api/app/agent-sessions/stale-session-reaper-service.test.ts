import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockWithDbTx, mockFindMany, mockLogError } = vi.hoisted(
  () => ({
    mockWithDb: vi.fn(),
    mockWithDbTx: vi.fn(),
    mockFindMany: vi.fn(),
    mockLogError: vi.fn(),
  })
);

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  };
});

import { SessionOrigin } from "@repo/database";
import {
  FALLBACK_STALE_SESSION_AGE_HOURS,
  staleSessionReaperService,
} from "./stale-session-reaper-service";

const { runStaleSessionSweep, getStaleSessionAgeHours } =
  staleSessionReaperService;

const NOW = new Date("2026-07-24T18:00:00.000Z");
const CUTOFF = new Date("2026-07-23T18:00:00.000Z");
const STALE_STARTED_AT = new Date("2026-07-20T10:00:00.000Z");
const STALE_ACTIVITY_AT = new Date("2026-07-21T10:00:00.000Z");
const FRESH_ACTIVITY_AT = new Date("2026-07-24T17:00:00.000Z");
const ORIGINAL_STALE_SESSION_AGE_HOURS = process.env.STALE_SESSION_AGE_HOURS;
const FAILED_SESSION_STATUS =
  SESSION_STATUS_LABELS[SESSION_STATUS.ERROR].toLowerCase();
const UNKNOWN_SESSION_STATUS = `${SESSION_STATUS.ACTIVE}-legacy`;

describe("stale session reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    restoreStaleSessionAgeHours();
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ sessionDetail: { findMany: mockFindMany } })
    );
    mockFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreStaleSessionAgeHours();
  });

  it("reaps a stale active session using its last activity", async () => {
    const candidate = makeCandidate();
    const tx = makeTransaction();
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result).toEqual({
      scanned: 1,
      reaped: 1,
      skippedByRecheck: 0,
      skippedByContention: 0,
      failed: 0,
      deferred: 0,
      hasMore: false,
    });
    // ISS-4586: no ends_with_error flag → declare the orphan `inactive` (the
    // terminal-not-failed state), not the retired `abandoned`.
    expect(tx.artifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: candidate.artifactId,
        status: {
          in: [SESSION_STATUS.ACTIVE, DISPLAYED_SESSION_STATUS.WAITING],
        },
      },
      data: { status: SESSION_STATUS.INACTIVE },
    });
    expect(tx.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: candidate.artifactId },
      data: {
        sessionEndedAt: STALE_ACTIVITY_AT,
        awaitingInputSince: null,
      },
    });
  });

  it("reaps an error-ending stale session to ERROR (ISS-4586)", async () => {
    const candidate = makeCandidate();
    const tx = makeTransaction({ endsWithError: true });
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result.reaped).toBe(1);
    // The durable ends_with_error flag steers the terminal status to ERROR — the
    // web reaper mirrors the desktop reaper's flag-based classification.
    expect(tx.artifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: candidate.artifactId,
        status: {
          in: [SESSION_STATUS.ACTIVE, DISPLAYED_SESSION_STATUS.WAITING],
        },
      },
      data: { status: SESSION_STATUS.ERROR },
    });
  });

  it("reaps a stale waiting session and clears awaiting input", async () => {
    const candidate = makeCandidate();
    const tx = makeTransaction({ status: DISPLAYED_SESSION_STATUS.WAITING });
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result.reaped).toBe(1);
    expect(tx.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: candidate.artifactId },
      data: {
        sessionEndedAt: STALE_ACTIVITY_AT,
        awaitingInputSince: null,
      },
    });
  });

  it("leaves fresh sessions untouched and applies the bounded scan predicate", async () => {
    const result = await runStaleSessionSweep();

    expect(result).toEqual({
      scanned: 0,
      reaped: 0,
      skippedByRecheck: 0,
      skippedByContention: 0,
      failed: 0,
      deferred: 0,
      hasMore: false,
    });
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        origin: SessionOrigin.DESKTOP_SYNC,
        artifact: {
          is: {
            status: {
              in: [SESSION_STATUS.ACTIVE, DISPLAYED_SESSION_STATUS.WAITING],
            },
          },
        },
        OR: [
          { lastActivityAt: { lt: CUTOFF } },
          {
            lastActivityAt: null,
            sessionStartedAt: { lt: CUTOFF },
          },
        ],
      },
      select: {
        artifactId: true,
        externalSessionId: true,
        lastActivityAt: true,
        sessionStartedAt: true,
      },
      take: 500,
    });
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("uses session start as the null-activity fallback for predicate and endedAt", async () => {
    const candidate = makeCandidate({ lastActivityAt: null });
    const tx = makeTransaction({ lastActivityAt: null });
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result.reaped).toBe(1);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { lastActivityAt: { lt: CUTOFF } },
            {
              lastActivityAt: null,
              sessionStartedAt: { lt: CUTOFF },
            },
          ],
        }),
      })
    );
    expect(tx.sessionDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sessionEndedAt: STALE_STARTED_AT,
          awaitingInputSince: null,
        },
      })
    );
  });

  it("excludes loop-origin sessions in the candidate scan", async () => {
    await runStaleSessionSweep();

    const query = mockFindMany.mock.calls[0]?.[0];
    expect(query.where.origin).toBe(SessionOrigin.DESKTOP_SYNC);
    expect(query.where.origin).not.toBe(SessionOrigin.LOOP);
  });

  it("does not reap terminal, desktop-failure, or unknown statuses", async () => {
    const statuses = [
      ...TERMINAL_SESSION_STATUSES,
      FAILED_SESSION_STATUS,
      UNKNOWN_SESSION_STATUS,
    ];
    mockFindMany.mockResolvedValue(
      statuses.map((_, index) =>
        makeCandidate({
          artifactId: `artifact-${index}`,
          externalSessionId: `session-${index}`,
        })
      )
    );
    let transactionIndex = 0;
    const transactions = statuses.map((status) => makeTransaction({ status }));
    mockWithDbTx.mockImplementation(
      (callback: (client: unknown) => unknown) => {
        const tx = transactions[transactionIndex];
        transactionIndex += 1;
        return callback(tx);
      }
    );

    const result = await runStaleSessionSweep();

    expect(result).toEqual({
      scanned: statuses.length,
      reaped: 0,
      skippedByRecheck: statuses.length,
      skippedByContention: 0,
      failed: 0,
      deferred: 0,
      hasMore: false,
    });
    for (const tx of transactions) {
      expect(tx.artifact.updateMany).not.toHaveBeenCalled();
      expect(tx.sessionDetail.update).not.toHaveBeenCalled();
    }
  });

  it("skips a candidate that becomes fresh after the locks", async () => {
    const tx = makeTransaction({ lastActivityAt: FRESH_ACTIVITY_AT });
    mockFindMany.mockResolvedValue([makeCandidate()]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result.skippedByRecheck).toBe(1);
    expect(tx.artifact.updateMany).not.toHaveBeenCalled();
    expect(tx.sessionDetail.update).not.toHaveBeenCalled();
  });

  it("does not update detail when the status CAS misses", async () => {
    const tx = makeTransaction({ casCount: 0 });
    mockFindMany.mockResolvedValue([makeCandidate()]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result.skippedByRecheck).toBe(1);
    expect(tx.artifact.updateMany).toHaveBeenCalledOnce();
    expect(tx.sessionDetail.update).not.toHaveBeenCalled();
  });

  it("counts a lock-timeout error as contention and continues the sweep", async () => {
    const secondTx = makeTransaction();
    mockFindMany.mockResolvedValue([
      makeCandidate(),
      makeCandidate({
        artifactId: "artifact-2",
        externalSessionId: "session-2",
      }),
    ]);
    const lockError = Object.assign(new Error("lock timeout"), {
      code: "55P03",
    });
    mockWithDbTx
      .mockRejectedValueOnce(lockError)
      .mockImplementationOnce((callback: (client: unknown) => unknown) =>
        callback(secondTx)
      );

    const result = await runStaleSessionSweep();

    expect(result).toEqual({
      scanned: 2,
      reaped: 1,
      skippedByRecheck: 0,
      skippedByContention: 1,
      failed: 0,
      deferred: 0,
      hasMore: false,
    });
    expect(secondTx.sessionDetail.update).toHaveBeenCalledOnce();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("counts a lock-timeout message without code as contention", async () => {
    mockFindMany.mockResolvedValue([makeCandidate()]);
    mockWithDbTx.mockRejectedValueOnce(
      new Error("canceling statement due to lock timeout")
    );

    const result = await runStaleSessionSweep();

    expect(result.skippedByContention).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("counts a generic error as failed, logs it, and continues the sweep", async () => {
    const secondTx = makeTransaction();
    const genericError = new Error("connection reset");
    mockFindMany.mockResolvedValue([
      makeCandidate(),
      makeCandidate({
        artifactId: "artifact-2",
        externalSessionId: "session-2",
      }),
    ]);
    mockWithDbTx
      .mockRejectedValueOnce(genericError)
      .mockImplementationOnce((callback: (client: unknown) => unknown) =>
        callback(secondTx)
      );

    const result = await runStaleSessionSweep();

    expect(result).toEqual({
      scanned: 2,
      reaped: 1,
      skippedByRecheck: 0,
      skippedByContention: 0,
      failed: 1,
      deferred: 0,
      hasMore: false,
    });
    expect(mockLogError).toHaveBeenCalledWith(
      "[stale-session-reaper] reap failed",
      { artifactId: "artifact-1", error: genericError }
    );
    expect(secondTx.sessionDetail.update).toHaveBeenCalledOnce();
  });

  it("defers remaining candidates when the time budget expires", async () => {
    const candidates = [
      makeCandidate(),
      makeCandidate({ artifactId: "artifact-2", externalSessionId: "s-2" }),
      makeCandidate({ artifactId: "artifact-3", externalSessionId: "s-3" }),
    ];
    mockFindMany.mockResolvedValue(candidates);
    const tx = makeTransaction();
    let callCount = 0;
    mockWithDbTx.mockImplementation(
      (callback: (client: unknown) => unknown) => {
        callCount += 1;
        if (callCount === 1) {
          vi.advanceTimersByTime(250_000);
        }
        return callback(tx);
      }
    );

    const result = await runStaleSessionSweep();

    expect(result.reaped).toBe(1);
    expect(result.deferred).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(mockWithDbTx).toHaveBeenCalledOnce();
  });

  it("caps the candidate batch at 500 rows and signals hasMore when full", async () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      makeCandidate({
        artifactId: `artifact-${i}`,
        externalSessionId: `session-${i}`,
      })
    );
    mockFindMany.mockResolvedValue(candidates);
    const tx = makeTransaction();
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 })
    );
    expect(result.hasMore).toBe(true);
  });

  it("uses an environment override for the cutoff", async () => {
    process.env.STALE_SESSION_AGE_HOURS = "6";

    await runStaleSessionSweep();

    expect(getStaleSessionAgeHours()).toBe(6);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              lastActivityAt: {
                lt: new Date("2026-07-24T12:00:00.000Z"),
              },
            },
            {
              lastActivityAt: null,
              sessionStartedAt: {
                lt: new Date("2026-07-24T12:00:00.000Z"),
              },
            },
          ],
        }),
      })
    );
  });

  it("falls back for an unset or invalid environment override", () => {
    Reflect.deleteProperty(process.env, "STALE_SESSION_AGE_HOURS");
    expect(getStaleSessionAgeHours()).toBe(FALLBACK_STALE_SESSION_AGE_HOURS);

    process.env.STALE_SESSION_AGE_HOURS = "0";
    expect(getStaleSessionAgeHours()).toBe(FALLBACK_STALE_SESSION_AGE_HOURS);
  });

  it("sets lock timeout and acquires both advisory locks old to new in separate statements", async () => {
    const candidate = makeCandidate();
    const tx = makeTransaction();
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    await runStaleSessionSweep();

    expect(mockWithDbTx).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    const lockTimeoutSql = tx.$executeRaw.mock.calls[0]?.[0].join("");
    const legacyLockSql = tx.$executeRaw.mock.calls[1]?.[0].join("");
    const newLockSql = tx.$executeRaw.mock.calls[2]?.[0].join("");
    expect(lockTimeoutSql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(legacyLockSql).toContain("pg_advisory_xact_lock(hashtext(");
    expect(legacyLockSql).not.toContain("hashtextextended(");
    expect(newLockSql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(tx.$executeRaw.mock.calls[1]?.slice(1)).toEqual([
      candidate.externalSessionId,
    ]);
    expect(tx.$executeRaw.mock.calls[2]?.slice(1)).toEqual([
      candidate.externalSessionId,
    ]);
  });
});

function makeCandidate(
  overrides: Partial<StaleSessionCandidate> = {}
): StaleSessionCandidate {
  return {
    artifactId: "artifact-1",
    externalSessionId: "session-1",
    lastActivityAt: STALE_ACTIVITY_AT,
    sessionStartedAt: STALE_STARTED_AT,
    ...overrides,
  };
}

function makeTransaction(options: TransactionOptions = {}) {
  const current = {
    lastActivityAt:
      options.lastActivityAt === undefined
        ? STALE_ACTIVITY_AT
        : options.lastActivityAt,
    sessionStartedAt: options.sessionStartedAt ?? STALE_STARTED_AT,
    endsWithError: options.endsWithError ?? null,
    artifact: {
      status: options.status ?? SESSION_STATUS.ACTIVE,
    },
  };
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockResolvedValue({}),
    },
    artifact: {
      updateMany: vi.fn().mockResolvedValue({ count: options.casCount ?? 1 }),
    },
  };
}

function restoreStaleSessionAgeHours(): void {
  if (ORIGINAL_STALE_SESSION_AGE_HOURS === undefined) {
    Reflect.deleteProperty(process.env, "STALE_SESSION_AGE_HOURS");
    return;
  }
  process.env.STALE_SESSION_AGE_HOURS = ORIGINAL_STALE_SESSION_AGE_HOURS;
}

type StaleSessionCandidate = {
  artifactId: string;
  externalSessionId: string;
  lastActivityAt: Date | null;
  sessionStartedAt: Date;
};

type TransactionOptions = {
  status?: string;
  endsWithError?: boolean | null;
  lastActivityAt?: Date | null;
  sessionStartedAt?: Date;
  casCount?: number;
};
