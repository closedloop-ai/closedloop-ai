import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { importPhaseDerivedRollups } from "../src/main/database/write-core-import-phases-rollups.js";
import { ClaudeCodeOtelSignalType } from "../src/main/otel/claude-code-otel-signal-contract.js";
import { persistClaudeCodeOtelSignals } from "../src/main/otel/claude-code-persistence.js";
import { makeSession } from "./normalized-session-test-utils.js";

/**
 * ISS-7229: `sessions.authoritative_cost_usd` is Claude's OWN reported cost,
 * summed from the `claude_code_cost_event` rows Claude Code exports over OTel.
 *
 * Driven through the REAL persister against a REAL SQLite database, not through
 * the rollup statement alone. Two things only this arrangement can prove: that
 * production actually invokes the rollup (deleting the call site reddens here,
 * which asserting the SQL directly would not), and that SQLite's own `SUM`
 * semantics are what the null-vs-zero contract is resting on — the whole
 * distinction lives in the engine's behaviour over an empty set, so a test that
 * reimplemented it in JS would be asserting its own arithmetic.
 */

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-08-31T12:00:00.000Z";
/** Strictly after {@link NOW}, so a stamped cursor is distinguishable. */
const LATER_NOW = "2026-08-31T13:00:00.000Z";
let opened: { db: SqliteDb; dir: string } | null = null;

async function openDb(): Promise<SqliteDb> {
  if (!opened) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7229-auth-cost-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => NOW,
    });
    opened = { db, dir };
  }
  return opened.db;
}

afterAll(async () => {
  if (opened) {
    const { db, dir } = opened;
    opened = null;
    // Close BEFORE removing the directory, as every sibling SQLite suite does:
    // an open handle keeps its boot-maintenance timers alive, which hangs the
    // lane with no failing assertion to point at.
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedSession(db: SqliteDb, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id)
     VALUES ($1, $1, 'inactive', $2, $2, $2, 'claude_code', NULL, NULL)`,
    sessionId,
    NOW
  );
}

/** One `claude_code.cost.usage` delta point, in the shape the normalizer emits. */
function costSignal(
  sessionId: string,
  costUsd: number,
  overrides: { model?: string; observedAt?: string } = {}
) {
  return {
    type: ClaudeCodeOtelSignalType.CostUsage,
    sessionId,
    model: overrides.model ?? "claude-opus-4-8",
    observedAt: overrides.observedAt ?? NOW,
    costUsd,
  };
}

async function persist(
  db: SqliteDb,
  events: ReturnType<typeof costSignal>[],
  // Left to the persister's real clock by default, because that is what every
  // pre-existing case here was written against. The cursor cases pass one
  // explicitly: the hazard they cover is the caller's clock landing on a value
  // the row already holds, which cannot be arranged without naming it.
  now?: string
): Promise<void> {
  const summary = await persistClaudeCodeOtelSignals(
    { prisma: db.prisma, events },
    now === undefined ? {} : { now: () => now }
  );
  // Guards the FIXTURE, not the subject: a signal the contract rejects would
  // leave the rollup with nothing to sum, and every assertion in every case
  // below would then pass for the wrong reason. Thrown rather than asserted
  // because that is what it is — a setup precondition, not a claim about the
  // code under test — and because Biome's `noMisplacedAssertion` correctly
  // refuses an assertion outside a test body.
  if (summary.rejected !== 0 || summary.accepted !== events.length) {
    throw new Error(
      `fixture signals must be admissible to the persister: accepted=${summary.accepted} rejected=${summary.rejected} of ${events.length}`
    );
  }
}

async function storedUpdatedAt(
  db: SqliteDb,
  sessionId: string
): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { updated_at: string | null }[]
  >("SELECT updated_at FROM sessions WHERE id = $1", sessionId);
  return rows[0]?.updated_at ?? null;
}

async function storedCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { authoritative_cost_usd: number | null }[]
  >("SELECT authoritative_cost_usd FROM sessions WHERE id = $1", sessionId);
  const value = rows[0]?.authoritative_cost_usd ?? null;
  return value === null ? null : Number(value);
}

/**
 * Record group 8 for one session — the production seam that rolls up a session
 * whose events are already stored.
 *
 * Every empty-set case below goes through THIS rather than the rollup statement
 * directly (marisolashgrove, #6385 review). Driving the constant proved only that
 * the SQL is right; it left the null contract unpinned at the seam someone will
 * actually break, and counterfactual 4 showed it — deleting the call site
 * reddened only the ordering case.
 */
async function runImportRollupPhase(
  db: SqliteDb,
  sessionId: string,
  // Defaults to the seed instant so existing cases are unchanged. The cursor
  // cases pass LATER_NOW: with the phase running at the same instant the row
  // was seeded at, an unconditional `updated_at = $2` writes the value already
  // there, and a no-op assertion cannot tell it from the conditional statement.
  now: string = NOW
): Promise<void> {
  await db.prisma.write((client) =>
    client.$transaction((tx) =>
      importPhaseDerivedRollups(
        tx,
        {
          session: makeSession({ sessionId }),
          now,
          log: () => undefined,
        },
        async () => {
          /* last_activity_at is a separate cursor, not part of this contract */
        }
      )
    )
  );
}

describe("sessions.authoritative_cost_usd rollup (ISS-7229)", () => {
  test("sums every captured cost event for the session", async () => {
    const db = await openDb();
    await seedSession(db, "sum-session");
    await persist(db, [
      costSignal("sum-session", 1.5),
      costSignal("sum-session", 2.25, {
        observedAt: "2026-08-31T12:05:00.000Z",
      }),
    ]);

    assert.equal(await storedCost(db, "sum-session"), 3.75);
  });

  test("sums ACROSS models rather than keeping only the last one", async () => {
    // The natural key is (session, model, observedAt, attributionKey), so a
    // multi-model session holds several rows for one instant. A rollup that
    // read one row — or grouped by model and took one group — would report a
    // fraction of the real spend as the whole of it.
    const db = await openDb();
    await seedSession(db, "multi-model-session");
    await persist(db, [
      costSignal("multi-model-session", 4, { model: "claude-opus-4-8" }),
      costSignal("multi-model-session", 0.5, { model: "claude-haiku-4-5" }),
    ]);

    assert.equal(await storedCost(db, "multi-model-session"), 4.5);
  });

  test("leaves a session with NO cost events null, never 0", async () => {
    // The defect this column exists to avoid. `COALESCE(SUM(...), 0)` would
    // stamp a confident "Claude reported $0.00" on the majority of sessions —
    // every one whose Claude process was never pointed at the local receiver —
    // and no reader could tell that from a run that genuinely cost nothing.
    //
    // Driven through the IMPORT PHASE, not the rollup statement: the persister
    // only rolls up sessions its own batch reported cost for, so the empty-set
    // branch is unreachable from there and an assertion written against it
    // passes on the column's INSERT default instead — measured, and green under
    // the exact COALESCE this case exists to forbid.
    const db = await openDb();
    await seedSession(db, "uncaptured-session");
    await runImportRollupPhase(db, "uncaptured-session");

    assert.equal(await storedCost(db, "uncaptured-session"), null);
  });

  test("clears a stale total when the session's cost events are gone", async () => {
    // The same empty-set branch reached by a CHANGE rather than an absence, so
    // the case cannot pass on the column's default. A total left behind after
    // its evidence disappeared is a figure with nothing standing behind it.
    const db = await openDb();
    await seedSession(db, "emptied-session");
    await persist(db, [costSignal("emptied-session", 5)]);
    assert.equal(await storedCost(db, "emptied-session"), 5);

    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "DELETE FROM claude_code_cost_event WHERE session_id = $1",
        "emptied-session"
      )
    );
    await runImportRollupPhase(db, "emptied-session");

    assert.equal(await storedCost(db, "emptied-session"), null);
  });

  // whitlockk on #6393. Cloud delivery selects on the `sessions.updated_at` cursor
  // (FEA-1962), so a rollup that wrote the column WITHOUT advancing that cursor
  // left an already-acked session invisible to every later sync — cost captured
  // after the first delivery never reached the cloud at all. This pair is what
  // stands between that gap and a silent return: half one proves the cursor
  // moves when the figure does, half two proves it does NOT move otherwise, so
  // the fix cannot be "bump it always" and re-queue the corpus on every import.
  test("advances the sync cursor when the rolled-up figure actually changes", async () => {
    const db = await openDb();
    await seedSession(db, "cursor-advances");
    const before = await storedUpdatedAt(db, "cursor-advances");

    await persist(db, [costSignal("cursor-advances", 7)]);

    assert.equal(await storedCost(db, "cursor-advances"), 7);
    const after = await storedUpdatedAt(db, "cursor-advances");
    assert.notEqual(after, before);
    assert.ok(
      after !== null && before !== null && after > before,
      `cursor must move forward: ${before} -> ${after}`
    );
  });

  // davetho on #6406: the cursor is SHARED, so a flat `$2` write could move it
  // backwards when the stored value is already later than the caller's clock —
  // a rolled-back host clock, or a row another writer stamped ahead. Backwards
  // is worse than stuck: the feed has already passed that position, so the
  // changed row is never selected again.
  //
  // WHAT THIS EXPECTS CHANGED, and the reason is a deliberate behaviour change
  // rather than a fixture repair. The bump now goes through
  // `advanceSessionSyncWatermark`, whose contract is STRICT forward progress and
  // not the monotonic MAX this column spelled inline — so a future-stamped row
  // whose figure moved lands on the millisecond AFTER the stored value instead
  // of holding it. That is the stronger answer for the property this case is
  // about: holding leaves a changed figure behind a cursor that has already
  // passed the row (the same stranding the tie case above covers), while a
  // strict successor makes it selectable again. Backwards is still forbidden,
  // and the assertion below pins the exact successor rather than merely "not
  // less", so a regression to a flat `$2` write reddens here too.
  test("advances the cursor forward, never back, when the stored watermark is ahead", async () => {
    const db = await openDb();
    await seedSession(db, "cursor-ahead");
    const FUTURE = "2099-01-01T00:00:00.000Z";
    // `$1` FIRST in the text: this raw helper binds by order of first
    // appearance, so the reversed spelling silently matched no rows and the
    // case passed against a row that was never seeded ahead.
    // Variadic, like `seedSession` — this helper does not take an array, and an
    // array silently binds as `$1` alone, leaving the row unseeded and the case
    // passing against a watermark that was never ahead.
    await db.run(
      "UPDATE sessions SET updated_at = $1 WHERE id = $2",
      FUTURE,
      "cursor-ahead"
    );

    await persist(db, [costSignal("cursor-ahead", 9)]);

    // The value still lands...
    assert.equal(await storedCost(db, "cursor-ahead"), 9);
    // ...and the cursor steps to the millisecond after its already-later
    // position rather than regressing to the caller's clock.
    const after = await storedUpdatedAt(db, "cursor-ahead");
    assert.equal(after, "2099-01-01T00:00:00.001Z");
    assert.ok(
      after !== null && after > FUTURE,
      `the cursor must never regress: ${FUTURE} -> ${after}`
    );
  });

  // davetho on #6406, the TIE. `importSession` captures ONE `now` for the
  // whole pass and runs its phases as separate transactions, so the session
  // group commits `updated_at = now` and this rollup then fires with that SAME
  // `now`. The sync lane ticks every few seconds and can read between the two
  // commits, acking the session at `now` and recording its id in
  // `observedIdsAtTopUpdatedAt` — after which the cursor predicate
  // `updated_at > $1 OR (updated_at = $1 AND id NOT IN (observed))` excludes the
  // row from every later scan. A monotonic MAX writes `now` back over `now` and
  // leaves it there, so the cost never leaves the machine. ISS-8758 already
  // decided this for the shared watermark: STRICT forward progress, not MAX.
  test("advances the cursor PAST a stored watermark equal to the caller's clock", async () => {
    const db = await openDb();
    await seedSession(db, "cursor-tie");
    const before = await storedUpdatedAt(db, "cursor-tie");
    assert.equal(before, NOW, "fixture: the row must start at the pass clock");

    await persist(db, [costSignal("cursor-tie", 11)], NOW);

    assert.equal(await storedCost(db, "cursor-tie"), 11);
    const after = await storedUpdatedAt(db, "cursor-tie");
    assert.ok(
      after !== null && after > NOW,
      `a changed figure must clear the tie it was written into: ${before} -> ${after}`
    );
  });

  // The other arm of the same finding: SQLite's two-argument scalar `max()`
  // returns NULL when either argument is NULL, and `sessions.updated_at` is
  // nullable. So on such a row a monotonic MAX wrote NULL back — preserving the
  // invisibility it was added to fix, and stripping the row of any watermark at
  // all. The sibling `codex-otel-writer.ts` spells the same bump NULL-safely,
  // and this PR's own heal pass already treats a NULL watermark as reachable.
  test("stamps a row whose watermark is NULL rather than writing NULL back", async () => {
    const db = await openDb();
    await seedSession(db, "cursor-null");
    await db.run(
      "UPDATE sessions SET updated_at = NULL WHERE id = $1",
      "cursor-null"
    );
    assert.equal(
      await storedUpdatedAt(db, "cursor-null"),
      null,
      "fixture: the row must start with no watermark"
    );

    await persist(db, [costSignal("cursor-null", 13)], LATER_NOW);

    assert.equal(await storedCost(db, "cursor-null"), 13);
    assert.equal(await storedUpdatedAt(db, "cursor-null"), LATER_NOW);
  });

  test("leaves the sync cursor alone when the rollup is a no-op", async () => {
    // The import phase runs this for EVERY session, including the majority with
    // no cost events at all. An unconditional bump would re-queue the whole
    // corpus for cloud delivery on every import, which is why the statement
    // tests the value rather than always stamping.
    const db = await openDb();
    await seedSession(db, "cursor-holds");
    const before = await storedUpdatedAt(db, "cursor-holds");

    await runImportRollupPhase(db, "cursor-holds", LATER_NOW);

    assert.equal(await storedCost(db, "cursor-holds"), null);
    // Compared against the SEED instant while the phase ran an hour later, so an
    // unconditional stamp is visible here rather than writing back the same
    // string. Without the later clock this case passes either way.
    assert.equal(await storedUpdatedAt(db, "cursor-holds"), before);
  });

  test("keeps a REPORTED zero as 0, distinct from uncaptured", async () => {
    // The other half of the same distinction, and the reason `null` cannot just
    // mean "falsy". A session Claude really did report $0 for is a measurement.
    const db = await openDb();
    await seedSession(db, "free-session");
    await persist(db, [costSignal("free-session", 0)]);

    assert.equal(await storedCost(db, "free-session"), 0);
  });

  test("REJECTS a cost point too large for the cloud column to hold", async () => {
    // ISS-7229 (whitlockk, #6385 review): `nonNegativeMeasurement` admits any finite
    // non-negative number, so a `1e100` point used to be summed here and then
    // synced at a magnitude the cloud's `Decimal(14,6)` column cannot hold —
    // the desktop storing a number the cloud reads back as absent.
    //
    // Rejected at the OTel read, so the signal never becomes a row: `accepted`
    // counts it out, and the session keeps NULL rather than an unstorable total.
    const db = await openDb();
    await seedSession(db, "oversized-session");

    const summary = await persistClaudeCodeOtelSignals({
      prisma: db.prisma,
      events: [costSignal("oversized-session", 1e100)],
    });

    assert.equal(summary.accepted, 0, "an unstorable point must not be kept");
    assert.equal(await storedCost(db, "oversized-session"), null);
  });

  test("keeps a large-but-storable cost", async () => {
    // The other side of the bound, so the guard cannot pass by rejecting
    // everything. Just under the shared ceiling.
    const db = await openDb();
    await seedSession(db, "large-session");
    await persist(db, [costSignal("large-session", 99_999_999)]);

    assert.equal(await storedCost(db, "large-session"), 99_999_999);
  });

  test("recomputes from scratch, so a replayed export cannot double-count", async () => {
    // The events upsert on their natural key, and the rollup re-derives the
    // whole total from the rows present. Together those make redelivery — which
    // OTLP allows at any time — cost nothing. An accumulating `+=` would
    // silently inflate every retried batch.
    const db = await openDb();
    await seedSession(db, "replay-session");
    const batch = [costSignal("replay-session", 3.5)];

    await persist(db, batch);
    assert.equal(await storedCost(db, "replay-session"), 3.5);

    await persist(db, batch);
    assert.equal(await storedCost(db, "replay-session"), 3.5);
  });

  test("the IMPORT phase rolls up events that landed before the session did", async () => {
    // The ordering the whole second call site exists for, driven through the
    // real `importPhaseDerivedRollups` rather than the statement: OTel events
    // arrive while the run is live, and the collector imports the transcript
    // afterwards. Without the call in that phase, such a session keeps a null
    // total forever even though its evidence is already stored — and no test
    // that only drives the persister can see it, because the persister rolls up
    // only sessions its own batch reported cost for.
    const db = await openDb();
    await persist(db, [costSignal("import-ordering-session", 2.5)]);
    await seedSession(db, "import-ordering-session");
    assert.equal(await storedCost(db, "import-ordering-session"), null);

    await runImportRollupPhase(db, "import-ordering-session");

    assert.equal(await storedCost(db, "import-ordering-session"), 2.5);
  });

  test("rolls up a session whose row does not exist yet without failing the batch", async () => {
    // OTel events routinely arrive before the collector has imported the
    // transcript that creates the session row. The rollup must update nothing
    // and let the events land, so the figure is recoverable once the row
    // appears — the alternative is losing the whole export.
    const db = await openDb();
    await persist(db, [costSignal("not-yet-imported", 7.25)]);

    const rows = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM claude_code_cost_event WHERE session_id = $1",
      "not-yet-imported"
    );
    assert.equal(Number(rows[0]?.n ?? 0), 1);

    // ...and once the row exists, the next rollup for that session picks the
    // already-stored events up rather than starting from zero.
    await seedSession(db, "not-yet-imported");
    await persist(db, [
      costSignal("not-yet-imported", 1, {
        observedAt: "2026-08-31T12:10:00.000Z",
      }),
    ]);
    assert.equal(await storedCost(db, "not-yet-imported"), 8.25);
  });
});
