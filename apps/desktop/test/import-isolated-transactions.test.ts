/**
 * @file import-isolated-transactions.test.ts
 * @description The normal ingest path (`importSession`) commits each record
 * group in its OWN isolated transaction rather than wrapping the whole import in
 * one transaction. These tests pin the three behaviors that per-group commits
 * provide:
 *
 *   1. Tolerance + isolation: a mid-pipeline group failing (here: the
 *      token_events+costs group) does NOT abort the import — groups before it
 *      stay committed AND groups after it still run, and the import is flagged
 *      `incomplete` so the source is re-imported (not marked seen). A later
 *      group may legitimately *read* the failed group's table (FEA-3636: the
 *      analytics rollup's est_cost folds in a `SUM(...) FROM token_events`
 *      premium); the fault is injected as a write-blocking trigger, not a
 *      `DROP TABLE`, so that read still resolves against the intact schema
 *      table and coalesces to +0 — matching the real production failure mode.
 *   2. Gating: if the session+main-agent group (the FK parent) fails, the import
 *      is reported failed and no child rows are written.
 *   3. Idempotency: re-importing the same session is a no-op (skipped) and leaves
 *      row counts stable — each group is a delete-then-reinsert / ON CONFLICT
 *      unit, so per-group commits converge.
 *
 * The importer is electron-tainted transitively (via sqlite.ts), so like the
 * rest of the desktop node suite these run in CI, not the sandbox.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const NOW = "2026-06-16T12:00:00.000Z";

/** A minimal session that writes rows in several record groups: token usage
 *  (token_usage group), token series + their costs (token_events+costs group),
 *  and — when `activity` is true — one Stop event (events group). token_usage
 *  (before the injected fault) and session_analytics (the last group, after it)
 *  bracket the failed group. When `activity` is false the session derives no
 *  events, so `inserted === 0` and a re-import is `skipped` (idempotency). */
function makeSession(sessionId: string, activity = true): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/sandbox/project",
    model: "gpt-5",
    startedAt: NOW,
    endedAt: "2026-06-16T12:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    entrypoint: "codex",
    tokensByModel: {
      "gpt-5": { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    },
    messageTimestamps: activity ? ["2026-06-16T12:01:00.000Z"] : [],
    tokenSeries: [
      {
        timestamp: "2026-06-16T12:01:00.000Z",
        model: "gpt-5",
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
  });
}

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function countRows(db: Db, sql: string, ...params: unknown[]) {
  const rows = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
    sql,
    ...params
  );
  return Number(rows[0]?.n ?? 0);
}

async function openDb(dir: string, log?: (m: string) => void): Promise<Db> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
    log,
  });
}

test("a mid-pipeline group failure does not abort the import; earlier and later groups still commit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-isolated-tol-"));
  const logs: string[] = [];
  const db = await openDb(dir, (m) => logs.push(m));
  try {
    // Fault injection: make every INSERT into token_events raise so the
    // token_events+costs group (group 4) fails, WITHOUT dropping the table.
    // This mirrors the real production failure mode — a bad write against an
    // intact schema table — and keeps the isolation guarantee honest: a later
    // group that legitimately *reads* token_events (FEA-3636: the analytics
    // rollup's est_cost folds in the 1h cache-write TTL premium, a
    // `SUM(...) FROM token_events` correlated read) still finds the table and,
    // seeing no rows for this session, coalesces the premium to +0 and commits.
    // (Dropping the table would fault the reader's prepare step too — a mode
    // that cannot occur in production, where the schema table always exists.)
    await db.run(
      `CREATE TRIGGER _fault_block_token_events
         BEFORE INSERT ON token_events
         BEGIN SELECT RAISE(ABORT, 'fault: token_events write blocked'); END`
    );

    const result = await db.importer.importSession(
      makeSession("sess-tolerance"),
      "codex"
    );

    // Tolerated: the import is NOT reported as failed even though a group threw.
    assert.notEqual(result.failed, true, "import must not be marked failed");
    // ...but it IS flagged incomplete so the collector re-imports next pass to
    // retry the failed group rather than marking the source permanently seen.
    assert.equal(
      result.incomplete,
      true,
      "partial import is flagged incomplete"
    );

    // Gating group + an EARLIER group (token_usage, group 3) committed.
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*) AS n FROM sessions WHERE id = $1",
        "sess-tolerance"
      ),
      1,
      "session row committed (gating group)"
    );
    assert.ok(
      (await countRows(
        db,
        "SELECT COUNT(*) AS n FROM events WHERE session_id = $1",
        "sess-tolerance"
      )) >= 1,
      "events committed (group 2)"
    );
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*) AS n FROM token_usage WHERE session_id = $1",
        "sess-tolerance"
      ),
      1,
      "token_usage committed (group 3, before the failed group)"
    );

    // The KEY isolation guarantee: a group AFTER the failed one still ran.
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*) AS n FROM session_analytics WHERE session_id = $1",
        "sess-tolerance"
      ),
      1,
      "analytics rollup committed (last group, AFTER the failed group)"
    );

    // The failure was surfaced, not swallowed silently.
    assert.ok(
      logs.some((m) => m.includes("token_events") && m.includes("failed")),
      "the token_events group failure was logged"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2273: a metrics-emission failure is best-effort — the import still completes and the analytics rollup commits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-isolated-metrics-"));
  const logs: string[] = [];
  const db = await openDb(dir, (m) => logs.push(m));
  try {
    // Let the boot backfill settle, then remove the metrics table so ONLY the
    // activity-metrics emission fails — every other group is intact.
    await db.whenBootMaintenanceSettled();
    await db.run("DROP TABLE session_activity_metrics");

    const result = await db.importer.importSession(
      makeSession("sess-metrics-drop"),
      "codex"
    );

    // Best-effort: the metrics failure neither fails NOR flags the import
    // incomplete — the analytics rollup is primary and a re-import must not be
    // forced (the version-aware backfill refreshes metrics later instead).
    assert.notEqual(result.failed, true, "import must not be marked failed");
    assert.notEqual(
      result.incomplete,
      true,
      "a best-effort metrics failure must not force a re-import"
    );
    // The primary analytics rollup (last group) still committed.
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*) AS n FROM session_analytics WHERE session_id = $1",
        "sess-metrics-drop"
      ),
      1,
      "analytics rollup committed despite the metrics-emission failure"
    );
    // The failure was surfaced (best-effort log), not swallowed silently.
    assert.ok(
      logs.some(
        (m) => m.includes("activity_metrics") && m.includes("best-effort")
      ),
      `expected a best-effort metrics log, got: ${logs.join(" | ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session+main-agent (gating) group failure marks the import failed and rolls back the session row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-isolated-gate-"));
  const db = await openDb(dir);
  try {
    // Remove the agents table so the gating group's main-agent INSERT throws
    // AFTER its session INSERT. Because the gating group is itself one
    // transaction, that failure must roll the session INSERT back too — proving
    // both that the import is gated and that the gating group is atomic.
    await db.run("DROP TABLE agents");

    const result = await db.importer.importSession(
      makeSession("sess-gate"),
      "codex"
    );

    assert.equal(result.failed, true, "import reported failed");
    // The session INSERT was rolled back with the failed agent INSERT, and no
    // later group ran, so nothing for this session is persisted.
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*) AS n FROM sessions WHERE id = $1",
        "sess-gate"
      ),
      0,
      "session row rolled back (gating group is atomic)"
    );
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*) AS n FROM events WHERE session_id = $1",
        "sess-gate"
      ),
      0,
      "no events written (later groups never ran)"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("re-importing the same session is skipped and leaves row counts stable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-isolated-idem-"));
  const db = await openDb(dir);
  try {
    const first = await db.importer.importSession(
      makeSession("sess-idem", false),
      "codex"
    );
    assert.equal(first.skipped, false, "first import writes the session");

    const counts = async () => ({
      sessions: await countRows(
        db,
        "SELECT COUNT(*) AS n FROM sessions WHERE id = $1",
        "sess-idem"
      ),
      events: await countRows(
        db,
        "SELECT COUNT(*) AS n FROM events WHERE session_id = $1",
        "sess-idem"
      ),
      tokenUsage: await countRows(
        db,
        "SELECT COUNT(*) AS n FROM token_usage WHERE session_id = $1",
        "sess-idem"
      ),
      tokenEvents: await countRows(
        db,
        "SELECT COUNT(*) AS n FROM token_events WHERE session_id = $1",
        "sess-idem"
      ),
    });
    const before = await counts();

    const second = await db.importer.importSession(
      makeSession("sess-idem", false),
      "codex"
    );
    assert.equal(second.skipped, true, "re-import is a no-op (skipped)");

    assert.deepEqual(
      await counts(),
      before,
      "row counts are identical after the second import"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
