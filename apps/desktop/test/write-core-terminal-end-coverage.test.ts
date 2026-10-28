/**
 * @file write-core-terminal-end-coverage.test.ts
 * @description ISS-8730 coverage for write-core-terminal-end.ts:
 * `reconcileTerminalSession`, the re-import reconciliation for an already-
 * terminal session row (ISS-5182 `ended_at` advance + FEA-4187 status heal).
 * `advanceTerminalEndedAt` and `laterParsedEnd` are private, so they are
 * exercised only through the exported `reconcileTerminalSession` — consistent
 * with the repo's "test through the public API" rule.
 *
 * `reconcileTerminalSession` takes the terminal columns it reconciles from the
 * caller (`existing`), but ISS-8871 gave it one read of its own: each arm reads
 * `sessions.updated_at` through `readSessionSyncWatermarkTarget` to pick a
 * strictly-forward watermark. So the double records the raw UPDATEs and answers
 * that one SELECT; it still needs no real SQLite fixture.
 *
 * `test/session-terminal-end-advance.test.ts` already pins the ended_at-advance
 * outcome end-to-end through the production importer; this file pins the SQL
 * call shape/order/param values directly, plus the status-heal branch and the
 * reconciledEndedAt fallback chain that suite does not exercise.
 *
 * Pins CURRENT behavior only; does not change apps/desktop source.
 */
import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import type { Prisma } from "../src/main/database/generated/client.js";
import { reconcileTerminalSession } from "../src/main/database/write-core-terminal-end.js";

type RawCall = { sql: string; args: unknown[] };

/**
 * `storedUpdatedAt` answers the watermark SELECT, one entry per read in call
 * order, with the last entry answering any further reads. It is a sequence
 * rather than a single value because the heal arm's read deliberately runs
 * AFTER the advance arm's write, so on a row both arms touch it sees an
 * `updated_at` the advance already moved — an ordering the source calls out as
 * load-bearing and a single static value could not express.
 */
function createRecordingTx(storedUpdatedAt: (string | null)[] = [null]): {
  tx: Prisma.TransactionClient;
  calls: RawCall[];
  reads: RawCall[];
} {
  const calls: RawCall[] = [];
  const reads: RawCall[] = [];
  const tx = {
    $executeRawUnsafe: (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args });
      return Promise.resolve(0);
    },
    $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
      const index = Math.min(reads.length, storedUpdatedAt.length - 1);
      reads.push({ sql, args });
      return Promise.resolve([{ updated_at: storedUpdatedAt[index] ?? null }]);
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls, reads };
}

function sessionInput(overrides: {
  sessionId?: string;
  endedAt?: string | null;
  endedOnUnrecoveredError?: boolean;
}) {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    endedAt: overrides.endedAt ?? null,
    apiErrors: [],
    endedOnUnrecoveredError: overrides.endedOnUnrecoveredError ?? false,
    messages: [],
  };
}

const MAIN_ID = "sess-1-main";
const NOW = "2026-01-02T00:00:00.000Z";
/**
 * ISS-8871: what a writer must bind when the row's stored `updated_at` already
 * sits AT `NOW` — the millisecond after it, never `NOW` itself, which would
 * leave the row where the `updated_at > $cursor` sync cursor already passed it.
 */
const NOW_PLUS_1MS = "2026-01-02T00:00:00.001Z";
/** The same step again, for the second arm's read of an already-advanced row. */
const NOW_PLUS_2MS = "2026-01-02T00:00:00.002Z";
const WATERMARK_SELECT = "SELECT updated_at FROM sessions WHERE id = $1";

describe("reconcileTerminalSession", () => {
  test("returns null and issues no writes when the existing row is not terminal", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: { status: SESSION_STATUS.ACTIVE, endedAt: null },
      session: sessionInput({}),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });

  test("terminal row with no fresh end and unchanged status issues no writes", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: {
        status: SESSION_STATUS.INACTIVE,
        endedAt: "2026-01-01T10:00:00.000Z",
      },
      session: sessionInput({ endedAt: null }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.deepEqual(result, {
      endedAt: "2026-01-01T10:00:00.000Z",
      status: SESSION_STATUS.INACTIVE,
    });
    assert.equal(calls.length, 0);
  });

  test("advances a later parsed end and writes it to both the session and its main agent", async () => {
    // The row's watermark already sits AT the import wall clock, so ISS-8871's
    // strict-forward target is the millisecond after it. Assigning `NOW` here —
    // what this arm did before ISS-8871 — would be a no-op write that leaves the
    // corrected duration behind the sync cursor forever.
    const { tx, calls, reads } = createRecordingTx([NOW]);
    const result = await reconcileTerminalSession(tx, {
      existing: {
        status: SESSION_STATUS.INACTIVE,
        endedAt: "2026-01-01T10:00:00.000Z",
      },
      session: sessionInput({ endedAt: "2026-01-01T14:00:00.000Z" }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.deepEqual(reads, [{ sql: WATERMARK_SELECT, args: ["sess-1"] }]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      sql: "UPDATE sessions SET ended_at = $1, updated_at = COALESCE($2, updated_at) WHERE id = $3",
      args: ["2026-01-01T14:00:00.000Z", NOW_PLUS_1MS, "sess-1"],
    });
    assert.deepEqual(calls[1], {
      sql: "UPDATE agents SET ended_at = $1, updated_at = $2 WHERE id = $3 AND ended_at IS NOT NULL",
      args: ["2026-01-01T14:00:00.000Z", NOW, MAIN_ID],
    });
    assert.deepEqual(result, {
      endedAt: "2026-01-01T14:00:00.000Z",
      status: SESSION_STATUS.INACTIVE,
    });
  });

  test("never back-dates: an earlier parsed end issues no advance write", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: {
        status: SESSION_STATUS.INACTIVE,
        endedAt: "2026-01-01T10:00:00.000Z",
      },
      session: sessionInput({ endedAt: "2026-01-01T05:00:00.000Z" }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      endedAt: "2026-01-01T10:00:00.000Z",
      status: SESSION_STATUS.INACTIVE,
    });
  });

  test("an unparseable stored end is treated as no evidence, not an advance", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: { status: SESSION_STATUS.INACTIVE, endedAt: "not-a-timestamp" },
      session: sessionInput({ endedAt: "2026-01-01T14:00:00.000Z" }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      endedAt: "not-a-timestamp",
      status: SESSION_STATUS.INACTIVE,
    });
  });

  test("heals inactive to error and advances ended_at together, preferring the just-advanced end for the heal write", async () => {
    // Both arms write, so both read: the advance sees the row tied at `NOW` and
    // moves it to NOW+1ms, and the heal's read then sees that advanced value and
    // must step past it again rather than settling back onto `NOW`.
    const { tx, calls, reads } = createRecordingTx([NOW, NOW_PLUS_1MS]);
    const result = await reconcileTerminalSession(tx, {
      existing: {
        status: SESSION_STATUS.INACTIVE,
        endedAt: "2026-01-01T10:00:00.000Z",
      },
      session: sessionInput({
        endedAt: "2026-01-01T14:00:00.000Z",
        endedOnUnrecoveredError: true,
      }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.equal(reads.length, 2);
    assert.equal(calls.length, 4);
    // calls[0..1] are the advance; calls[2..3] are the status heal, and the
    // heal's COALESCE fallback param must be the value the advance JUST wrote,
    // not the pre-advance `existing.endedAt` — the source comment calls this
    // out explicitly as load-bearing ordering.
    assert.deepEqual(calls[2], {
      sql: "UPDATE sessions SET status = $1, ended_at = COALESCE(ended_at, $2), updated_at = COALESCE($3, updated_at), ends_with_error = $4 WHERE id = $5",
      args: [
        SESSION_STATUS.ERROR,
        "2026-01-01T14:00:00.000Z",
        NOW_PLUS_2MS,
        1,
        "sess-1",
      ],
    });
    assert.deepEqual(calls[3], {
      sql: "UPDATE agents SET status = $1, ended_at = COALESCE(ended_at, $2), updated_at = $3 WHERE id = $4",
      args: ["error", "2026-01-01T14:00:00.000Z", NOW, MAIN_ID],
    });
    assert.deepEqual(result, {
      endedAt: "2026-01-01T14:00:00.000Z",
      status: SESSION_STATUS.ERROR,
    });
  });

  test("heals error back to inactive, clearing ends_with_error and mapping the agent to completed", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: {
        status: SESSION_STATUS.ERROR,
        endedAt: "2026-01-01T10:00:00.000Z",
      },
      session: sessionInput({ endedAt: null, endedOnUnrecoveredError: false }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.equal(calls.length, 2);
    // A row whose stored watermark is NULL (the double's default) sorts below
    // every stamp, so the strict-forward target is plain `NOW`.
    assert.deepEqual(calls[0], {
      sql: "UPDATE sessions SET status = $1, ended_at = COALESCE(ended_at, $2), updated_at = COALESCE($3, updated_at), ends_with_error = $4 WHERE id = $5",
      args: [
        SESSION_STATUS.INACTIVE,
        "2026-01-01T10:00:00.000Z",
        NOW,
        0,
        "sess-1",
      ],
    });
    assert.deepEqual(calls[1], {
      sql: "UPDATE agents SET status = $1, ended_at = COALESCE(ended_at, $2), updated_at = $3 WHERE id = $4",
      args: ["completed", "2026-01-01T10:00:00.000Z", NOW, MAIN_ID],
    });
    assert.deepEqual(result, {
      endedAt: "2026-01-01T10:00:00.000Z",
      status: SESSION_STATUS.INACTIVE,
    });
  });

  test("reconciledEndedAt SQL param falls back to the parsed end when the stored end is null, but the returned endedAt does not adopt it", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: { status: SESSION_STATUS.INACTIVE, endedAt: null },
      session: sessionInput({
        endedAt: "2026-01-01T14:00:00.000Z",
        endedOnUnrecoveredError: true,
      }),
      mainId: MAIN_ID,
      now: NOW,
    });
    // Advance is impossible (the stored end is null), so only the 2 heal calls
    // run.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[1], "2026-01-01T14:00:00.000Z");
    // The RETURNED endedAt is `advancedEndedAt ?? existing.endedAt` — the
    // parsed session end is never a candidate for IT, even though the SQL
    // write above just used it as the COALESCE fallback. Pinning this
    // documented asymmetry between the write and the return value.
    assert.deepEqual(result, { endedAt: null, status: SESSION_STATUS.ERROR });
  });

  test("reconciledEndedAt SQL param falls back to the import wall clock when both stored and parsed ends are null", async () => {
    const { tx, calls } = createRecordingTx();
    const result = await reconcileTerminalSession(tx, {
      existing: { status: SESSION_STATUS.INACTIVE, endedAt: null },
      session: sessionInput({ endedAt: null, endedOnUnrecoveredError: true }),
      mainId: MAIN_ID,
      now: NOW,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[1], NOW);
    assert.deepEqual(result, { endedAt: null, status: SESSION_STATUS.ERROR });
  });
});
