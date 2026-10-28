import {
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockWithDbTx,
  mockFindMany,
  mockLogError,
  mockCaptureStatus,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockFindMany: vi.fn(),
  mockLogError: vi.fn(),
  mockCaptureStatus: vi.fn(),
}));

vi.mock("@/lib/artifact-activity-recording", () => ({
  captureSystemSessionStatusChange: mockCaptureStatus,
}));

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

import {
  IndexKeyOrigin,
  indexKeyLookupCandidates,
} from "@/lib/index-key-lookup";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import {
  FALLBACK_STALE_SESSION_AGE_HOURS,
  staleSessionReaperService,
} from "./stale-session-reaper-service";

const { runStaleSessionSweep, getStaleSessionAgeHours } =
  staleSessionReaperService;

const NOW = new Date("2026-07-24T18:00:00.000Z");
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CUTOFF = new Date("2026-07-23T18:00:00.000Z");
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
          in: [SESSION_STATUS.ACTIVE],
        },
      },
      data: { status: SESSION_STATUS.INACTIVE },
    });
    // ISS-6274: the reap discards this row, so the write asks Postgres for the
    // primary key alone — the narrowest `select` Prisma accepts — instead of
    // `RETURNING *`. Widen it and this reddens.
    expect(tx.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: candidate.artifactId },
      data: {
        sessionEndedAt: STALE_ACTIVITY_AT,
        awaitingInputSince: null,
      },
      select: { artifactId: true },
    });
    expect(mockCaptureStatus).toHaveBeenCalledWith({
      tx,
      organizationId: ORGANIZATION_ID,
      artifactId: candidate.artifactId,
      before: SESSION_STATUS.ACTIVE,
      after: SESSION_STATUS.INACTIVE,
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
          in: [SESSION_STATUS.ACTIVE],
        },
      },
      data: { status: SESSION_STATUS.ERROR },
    });
    expect(mockCaptureStatus).toHaveBeenCalledWith(
      expect.objectContaining({ after: SESSION_STATUS.ERROR })
    );
  });

  it("classifies a failed activity receipt as a failed reap", async () => {
    const candidate = makeCandidate();
    const tx = makeTransaction();
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );
    mockCaptureStatus.mockRejectedValueOnce(new Error("receipt unavailable"));

    const result = await runStaleSessionSweep();

    expect(result.reaped).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("ISS-10364: does NOT reap a candidate whose re-checked status is the legacy waiting spelling — it is no longer in the reapable set", async () => {
    // Cosimo confirmed on 2026-09-23 that no row has ever stored `waiting`, which
    // is what let ISS-10364 drop it from REAPABLE_SESSION_STATUSES. Kept as a
    // counterfactual: if a row somehow still carries the spelling, the sweep
    // must leave it alone rather than silently reaping it again.
    const candidate = makeCandidate();
    const tx = makeTransaction({ status: "waiting" });
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    const result = await runStaleSessionSweep();

    expect(result.reaped).toBe(0);
    expect(result.skippedByRecheck).toBe(1);
    expect(tx.artifact.updateMany).not.toHaveBeenCalled();
    expect(tx.sessionDetail.update).not.toHaveBeenCalled();
    expect(mockCaptureStatus).not.toHaveBeenCalled();
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
        artifact: {
          is: {
            status: {
              in: [SESSION_STATUS.ACTIVE],
            },
          },
        },
        lastActivityAt: { lt: CUTOFF },
      },
      select: {
        artifactId: true,
        externalSessionId: true,
        lastActivityAt: true,
      },
      take: 500,
    });
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  // ISS-6463 deleted the null-activity fallback test that sat here. Its subject
  // — reaping a row whose `lastActivityAt` was null by falling back to
  // `sessionStartedAt` for both the scan predicate and the stamped
  // `sessionEndedAt` — is a retired contract, not an uncovered one: the column
  // is NOT NULL, so that row cannot exist. The half of it that still holds, that
  // a reap stamps `sessionEndedAt` from the activity anchor, is asserted by the
  // INACTIVE reap and the stale-waiting reap above — the two tests that pin
  // `sessionEndedAt: STALE_ACTIVITY_AT`. (The ERROR reap asserts the status fold
  // only, so it is not one of them.)

  it("ISS-11129: scans every origin, with no origin filter", async () => {
    // Operator ruling, 2026-09-24: every origin is reaped at the same cutoff.
    // A mutation that scoped the scan back to one origin fails this.
    await runStaleSessionSweep();

    const query = mockFindMany.mock.calls[0]?.[0];
    expect(query.where).not.toHaveProperty("origin");
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

  it("counts the adapter-pg envelope as contention without relying on the message", async () => {
    // ISS-8804: the shape a raw statement actually raises on 7.10 — Prisma's own
    // P2010 on `code`, the driver SQLSTATE under driverAdapterError. The message
    // deliberately does NOT contain "lock timeout", so this case can only pass
    // through the structured read. Both pre-existing contention tests pass via
    // the regex, so without this one the whole structured read is deletable
    // with nothing going red.
    mockFindMany.mockResolvedValue([makeCandidate()]);
    mockWithDbTx.mockRejectedValueOnce(
      Object.assign(new Error("could not obtain lock on relation"), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      })
    );

    const result = await runStaleSessionSweep();

    expect(result.skippedByContention).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("counts an EXTERNAL statement cancel as failed, not contention", async () => {
    // 57014 is deliberately NOT accepted here. `reapCandidate` sets only
    // `lock_timeout`, so it cannot have caused this cancel — it is a session or
    // role timeout, a pooler, or an operator. Counting it as contention would
    // suppress the log.error that is the only signal such a reap exists.
    mockFindMany.mockResolvedValue([makeCandidate()]);
    mockWithDbTx.mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "57014" } } },
      })
    );

    const result = await runStaleSessionSweep();

    expect(result.skippedByContention).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockLogError).toHaveBeenCalled();
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
          lastActivityAt: {
            lt: new Date("2026-07-24T12:00:00.000Z"),
          },
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

  /**
   * ISS-8200 (review): the sweep locks a session it READ OUT of the column, so
   * its identity is a STORED key. The case above cannot see this — `session-1`
   * is inside the byte budget, so it has one candidate whichever origin the
   * caller passes, and both origins produce identical SQL.
   *
   * A re-keyed session is where they diverge. `projectIndexKey` is deliberately
   * not idempotent, so sending a stored PROJECTED key down the wire path
   * projects it AGAIN into a third value that no writer anywhere holds: the
   * sweep would take a slot of its own while the ingest holds the real one, and
   * the mutual exclusion this lock exists for would be gone precisely for the
   * sessions ISS-8069 re-keyed.
   */
  it("locks a re-keyed session under its STORED key, on a slot the ingest also takes", async () => {
    const rawSessionId = "s".repeat(INDEX_KEY_MAX_BYTES + 1);
    const storedSessionId = projectIndexKey(rawSessionId).value;
    const candidate = makeCandidate({ externalSessionId: storedSessionId });
    const tx = makeTransaction();
    mockFindMany.mockResolvedValue([candidate]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(tx)
    );

    await runStaleSessionSweep();

    // The stored key VERBATIM. Re-projecting it yields a different string, so
    // this assertion is what fails if the sweep ever takes the wire path again.
    const lockedIdentities = tx.$executeRaw.mock.calls
      .slice(1)
      .map((call) => call[1] as string);
    expect(lockedIdentities).toEqual([storedSessionId, storedSessionId]);
    expect(lockedIdentities).not.toContain(
      projectIndexKey(storedSessionId).value
    );

    // And the property that actually matters: the ingest, which holds the RAW
    // wire id for this same session, locks a set that OVERLAPS the sweep's.
    const ingestKeys = indexKeyLookupCandidates(
      rawSessionId,
      IndexKeyOrigin.Wire
    );
    expect(ingestKeys).toContain(storedSessionId);
  });
});

function makeCandidate(
  overrides: Partial<StaleSessionCandidate> = {}
): StaleSessionCandidate {
  return {
    artifactId: "artifact-1",
    externalSessionId: "session-1",
    lastActivityAt: STALE_ACTIVITY_AT,
    ...overrides,
  };
}

// Mirrors the production `select` exactly (ISS-6463 dropped `sessionStartedAt`
// from it): a mock that returns a column the code no longer reads would keep a
// deleted fallback looking supported.
function makeTransaction(options: TransactionOptions = {}) {
  const current = {
    lastActivityAt: options.lastActivityAt ?? STALE_ACTIVITY_AT,
    endsWithError: options.endsWithError ?? null,
    artifact: {
      status: options.status ?? SESSION_STATUS.ACTIVE,
      organizationId: ORGANIZATION_ID,
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

// A local restatement of the service's own (unexported) candidate shape. Kept in
// step with it by hand: ISS-6463 dropped `sessionStartedAt` from the production
// `select` and made `lastActivityAt` non-null, so a copy still carrying either
// would let this file build candidates the production query can never return.
type StaleSessionCandidate = {
  artifactId: string;
  externalSessionId: string;
  lastActivityAt: Date;
};

type TransactionOptions = {
  status?: string;
  endsWithError?: boolean | null;
  lastActivityAt?: Date;
  casCount?: number;
};
