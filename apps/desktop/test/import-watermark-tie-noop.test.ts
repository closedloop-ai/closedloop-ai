/**
 * @file import-watermark-tie-noop.test.ts
 * @description ISS-8871: the four import-path writers of `sessions.updated_at`
 * that ISS-8758 left assigning `now` directly — the gate's content write, the
 * gate's reactivation write, and the terminal-end reconciliation's two arms.
 *
 * When the stored value already equals the import clock, `updated_at = now` is a
 * no-op, and the incremental scan is
 * `updated_at > $cursor OR (updated_at = $cursor AND id NOT IN <observed>)` — so
 * a row already observed at the tied top timestamp is never selected again and
 * the change stays local forever.
 *
 * Each test drives the REAL ingest path (`db.importer.importSession`) and reads
 * selection back through the REAL scan (`listUpdatedSessionCursorRows`). The tie
 * is the INHERITED one the defect describes: the seed import runs on its own
 * clock, its watermark is then settled at `TIE_AT`, and the import clock is
 * pinned to that same literal. {@link seedTiedSession} asserts the stored value
 * IS `TIE_AT` and that the cursor has already delivered the row there, so the
 * writer's `now` and the stored value are proved equal before it runs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";
import {
  selectedSince,
  updatedAtOf,
} from "./session-sync-cursor-test-utils.js";

const SESSION_ID = "iss8871-session";
/** Within RECENT_ACTIVITY_MS of both clocks below, so liveness is fixture-controlled. */
const LIVE_FILE_MTIME_MS = Date.parse("2026-06-07T11:55:00.000Z");
/** The seed import's clock; its landing watermark is then settled at TIE_AT. */
const SEED_AT = "2026-06-07T11:50:00.000Z";
/** The stored watermark AND the clock every import under test runs on. */
const TIE_AT = "2026-06-07T12:00:00.000Z";
/**
 * The millisecond after TIE_AT. Written as its own literal rather than derived
 * from the clock the fix reads, so a fold that computes the successor wrongly
 * cannot compute the expectation wrongly too.
 */
const TIE_STEP_ONE = "2026-06-07T12:00:00.001Z";
/** Two steps: the rebuild's own follow-up bump lands after a writer already stepped. */
const TIE_STEP_TWO = "2026-06-07T12:00:00.002Z";
/**
 * The last millisecond `toISOString`'s four-digit-year form can express, so it has
 * no successor that sorts after it and `sessionSyncWatermarkTarget` DECLINES. That
 * decline is the only reason these writers bind `COALESCE($n, updated_at)` instead
 * of `$n`, so it needs its own coverage: binding the clock back in would write a
 * lexically-REGRESSING value over this stamp rather than leave it alone.
 */
const UNADVANCEABLE_AT = "9999-12-31T23:59:59.999Z";
const SEEDED_ENDED_AT = "2026-06-07T11:00:00.000Z";
/** Strictly later than SEEDED_ENDED_AT, so the fresh parse outruns the frozen end. */
const RESUMED_ENDED_AT = "2026-06-07T11:30:00.000Z";
const APPENDED_TURN_AT = "2026-06-07T10:02:00.000Z";
const RENAMED = "Renamed by a later parse";
const EVENTS = "events";

type Db = SqliteAgentDatabase;
type SetClock = (at: string) => void;

/** A live session: recent file activity keeps it out of the terminal branches. */
function liveSession(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    fileModifiedAt: LIVE_FILE_MTIME_MS,
    endedAt: SEEDED_ENDED_AT,
  });
}

/** The same session with no recent file activity, so it imports terminal. */
function terminalSession(): NormalizedSession {
  return { ...liveSession(), fileModifiedAt: null };
}

async function withDb(run: (db: Db, setClock: SetClock) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8871-"));
  let clock = SEED_AT;
  const db = await openTestDb(dir, { now: () => clock });
  try {
    await run(db, (at: string) => {
      clock = at;
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function sessionColumn(db: Db, column: string): Promise<string | null> {
  return db.prisma.client
    .$queryRawUnsafe<{ value: string | null }[]>(
      `SELECT ${column} AS value FROM sessions WHERE id = $1`,
      SESSION_ID
    )
    .then((rows) => rows[0]?.value ?? null);
}

function countEvents(db: Db): Promise<number> {
  return db.prisma.client
    .$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM ${EVENTS} WHERE session_id = $1`,
      SESSION_ID
    )
    .then((rows) => Number(rows[0]?.n ?? 0));
}

/**
 * Import `session`, settle its watermark at `TIE_AT`, pin the clock there, and
 * report the two facts every test asserts as its precondition: the stored
 * watermark IS the clock the writer under test will run on, and the cursor has
 * ALREADY delivered the row at that timestamp. The empty `owedToCloud` is the
 * tie's other half — it is what makes a writer that fails to move the watermark
 * permanently unselectable.
 */
/** Overwrite the stored watermark directly, for fixtures the importer cannot produce. */
function settleWatermark(db: Db, at: string): Promise<unknown> {
  return db.prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE sessions SET updated_at = $1 WHERE id = $2",
      at,
      SESSION_ID
    )
  );
}

async function seedTiedSession(
  db: Db,
  setClock: SetClock,
  session: NormalizedSession
): Promise<{ updatedAt: string; owedToCloud: string[] }> {
  await db.importer.importSession(session, "claude");
  await settleWatermark(db, TIE_AT);
  setClock(TIE_AT);
  return {
    updatedAt: await updatedAtOf(db, SESSION_ID),
    owedToCloud: await selectedSince(db, TIE_AT, [SESSION_ID]),
  };
}

const TIED_SEED = { updatedAt: TIE_AT, owedToCloud: [] };

test("ISS-8871: the gate's content write on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, liveSession()),
      TIED_SEED
    );

    await db.importer.importSession(
      { ...liveSession(), name: RENAMED },
      "claude"
    );

    assert.equal(
      await sessionColumn(db, "name"),
      RENAMED,
      "precondition: the content branch is the writer that ran"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      TIE_STEP_ONE,
      "a tied content write must step forward, not write the stored value back"
    );
    assert.deepEqual(
      await selectedSince(db, TIE_AT, [SESSION_ID]),
      [SESSION_ID],
      "the tied-top NOT IN exclusion makes an unmoved watermark permanently unselectable"
    );
  });
});

test("ISS-8871: the gate's reactivation write on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, terminalSession()),
      TIED_SEED
    );
    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.INACTIVE,
      "precondition: the seed landed terminal, so the re-import can reactivate it"
    );

    // Only `fileModifiedAt` differs, and it is in neither the metadata blob nor
    // the name, so `contentChanged` is false and reactivation is the sole writer.
    await db.importer.importSession(liveSession(), "claude");

    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.ACTIVE,
      "precondition: the reactivation branch is the writer that ran"
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), TIE_STEP_ONE);
    assert.deepEqual(
      await selectedSince(db, TIE_AT, [SESSION_ID]),
      [SESSION_ID],
      "a reactivation the cloud never learns about leaves the session shown as ended"
    );
  });
});

test("ISS-8871: the terminal status heal on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, terminalSession()),
      TIED_SEED
    );
    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.INACTIVE,
      "precondition: the seed landed inactive, so the heal has a classification to flip"
    );

    // `endedOnUnrecoveredError` steers the failed-vs-completed classifier and is
    // not in the metadata blob, so the heal arm is the sole writer.
    await db.importer.importSession(
      { ...terminalSession(), endedOnUnrecoveredError: true },
      "claude"
    );

    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.ERROR,
      "precondition: the status-heal arm is the writer that ran"
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), TIE_STEP_ONE);
    assert.deepEqual(
      await selectedSince(db, TIE_AT, [SESSION_ID]),
      [SESSION_ID],
      "a heal the cloud never learns about keeps showing the failed run as finished"
    );
  });
});

test("ISS-8871: the terminal ended_at advance on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, terminalSession()),
      TIED_SEED
    );
    assert.equal(
      await sessionColumn(db, "ended_at"),
      SEEDED_ENDED_AT,
      "precondition: the frozen end the fresh parse must outrun"
    );

    await db.importer.importSession(
      { ...terminalSession(), endedAt: RESUMED_ENDED_AT },
      "claude"
    );

    assert.equal(
      await sessionColumn(db, "ended_at"),
      RESUMED_ENDED_AT,
      "precondition: the ended_at advance is the writer that ran"
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), TIE_STEP_ONE);
    assert.deepEqual(
      await selectedSince(db, TIE_AT, [SESSION_ID]),
      [SESSION_ID],
      "ISS-5182 made ended_at authoritative for duration; a stranded advance keeps the truncated one in the cloud"
    );
  });
});

test("ISS-8871: a tied content write plus a co-occurring event change leaves the session selected on the gate's step alone", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, liveSession()),
      TIED_SEED
    );
    const eventsBefore = await countEvents(db);

    // Two independent signals in ONE pass: the name flips `contentChanged` in
    // the gate, and the appended turn adds an `events` row without touching the
    // metadata blob, so the events group observes a change of its own.
    await db.importer.importSession(
      {
        ...liveSession(),
        name: RENAMED,
        turnDurations: [{ durationMs: 4200, timestamp: APPENDED_TURN_AT }],
      },
      "claude"
    );

    assert.equal(
      await sessionColumn(db, "name"),
      RENAMED,
      "precondition: the gate's content write ran"
    );
    assert.equal(
      await countEvents(db),
      eventsBefore + 1,
      "precondition: the events group committed a change of its own"
    );
    // ONE step, not two: `advanceWatermarkIfOwed` still skips a group bump when
    // the gate reported a content change, and the ruling that keeps that skip is
    // that the gate's step is now guaranteed to move. Restoring the tie no-op on
    // the gate leaves this at TIE_AT and the session unselectable; removing the
    // skip would put it at TIE_AT + 2ms. Both are deliberate edits, and this
    // literal is what makes either one visible.
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      TIE_STEP_ONE,
      "the gate's step is what carries both signals; the events group rides it"
    );
    assert.deepEqual(
      await selectedSince(db, TIE_AT, [SESSION_ID]),
      [SESSION_ID],
      "a content change and a co-occurring event change must not strand together"
    );
  });
});

test("ISS-8871: the data-revision rebuild's own watermark bump advances past the terminal heal it follows", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, terminalSession()),
      TIED_SEED
    );

    // The rebuild shares ONE transaction with the re-import, so its follow-up
    // bump runs AFTER the status heal has already stepped the row. Binding the
    // raw clock there does not merely tie — it writes back DOWN over that step.
    const rebuilt = await db.rebuildSessionFromParse(
      { ...terminalSession(), endedOnUnrecoveredError: true },
      "claude"
    );

    assert.equal(rebuilt.rebuilt, true, "precondition: the rebuild ran");
    assert.equal(
      rebuilt.needsResync,
      true,
      "precondition: a child-row signal changed, so the rebuild owes its own bump"
    );
    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.ERROR,
      "precondition: the status heal is the writer the rebuild's bump follows"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      TIE_STEP_TWO,
      "the heal's step then the rebuild's own step — never back down to the shared clock"
    );
    assert.deepEqual(
      await selectedSince(db, TIE_AT, [SESSION_ID]),
      [SESSION_ID],
      "a rebuild that regresses the watermark strands both its own change and the heal"
    );
  });
});

test("ISS-8871: an unadvanceable watermark is LEFT ALONE by both gate writers, which still land their own columns", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, terminalSession()),
      TIED_SEED
    );
    await settleWatermark(db, UNADVANCEABLE_AT);

    // One pass, both gate writers: the fresh name takes the content branch and
    // the recent file activity reactivates the terminal row.
    await db.importer.importSession(
      { ...liveSession(), name: RENAMED },
      "claude"
    );

    assert.equal(
      await sessionColumn(db, "name"),
      RENAMED,
      "the content write still lands its own columns"
    );
    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.ACTIVE,
      "the reactivation write still lands its own columns"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      UNADVANCEABLE_AT,
      "no orderable successor exists, so the column is declined — never overwritten with a value that sorts below it"
    );
  });
});

test("ISS-8871: an unadvanceable watermark is LEFT ALONE by both terminal-end writers, which still land their own columns", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedTiedSession(db, setClock, terminalSession()),
      TIED_SEED
    );
    await settleWatermark(db, UNADVANCEABLE_AT);

    // One pass, both terminal-end writers: a later parsed end advances ended_at
    // and the unrecovered-error flag heals the classification.
    await db.importer.importSession(
      {
        ...terminalSession(),
        endedAt: RESUMED_ENDED_AT,
        endedOnUnrecoveredError: true,
      },
      "claude"
    );

    assert.equal(
      await sessionColumn(db, "ended_at"),
      RESUMED_ENDED_AT,
      "the ended_at advance still lands its own columns"
    );
    assert.equal(
      await sessionColumn(db, "status"),
      SESSION_STATUS.ERROR,
      "the status heal still lands its own columns"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      UNADVANCEABLE_AT,
      "no orderable successor exists, so the column is declined — never overwritten with a value that sorts below it"
    );
  });
});
