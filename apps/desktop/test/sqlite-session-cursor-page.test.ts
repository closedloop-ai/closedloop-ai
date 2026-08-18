import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  insertSqliteEvent,
  insertSqliteSession,
} from "./sqlite-session-fixtures.js";

/**
 * The SQLite session CURSOR-PAGE suite — the SQL selection path that serves the
 * Sessions list: cursor ordering, the date window, search, the Status facet, and
 * the denormalized last-activity sort.
 *
 * Split from `sqlite-agent-dashboard-database.test.ts` (shrink-only
 * grandfathered) because these cases share one responsibility that the parent
 * suite does not: they assert what the SQL SELECTS, row-for-row, against the
 * hydrated JS path it replaces. That is the seam the whole-corpus-JS-to-SQL
 * conversion moves, so it earns its own file rather than more weight on a suite
 * already at its ceiling.
 */

// PR #1837 perf guard: a temp-b-tree filesort in an EXPLAIN QUERY PLAN means the
// last-activity sort is NOT being served by idx_sessions_last_activity.
const TEMP_BTREE_SORT_PATTERN = /TEMP B-TREE FOR ORDER BY/i;

test("SQLite sync cursor rows are ordered by update time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await insertSqliteSession(db, "newest-session-time", {
      startedAt: "2026-06-18T12:00:00.000Z",
      updatedAt: "2026-06-18T12:00:00.000Z",
    });
    await insertSqliteSession(db, "newest-update-time", {
      startedAt: "2026-06-17T12:00:00.000Z",
      updatedAt: "2026-06-19T12:00:00.000Z",
    });
    await insertSqliteSession(db, "newest-update-tie", {
      startedAt: "2026-06-16T12:00:00.000Z",
      updatedAt: "2026-06-19T12:00:00.000Z",
    });

    const rows = await db.syncSource.listAllSessionCursorRows();
    const topRows = await db.syncSource.listTopSessionCursorRows?.();

    assert.deepEqual(
      rows.map((row) => row.id),
      ["newest-update-time", "newest-update-tie", "newest-session-time"]
    );
    assert.deepEqual(
      topRows?.map((row) => row.id),
      ["newest-update-time", "newest-update-tie"]
    );

    await insertSqliteEvent(
      db,
      "newest-session-time",
      "2026-06-20T12:00:00.000Z"
    );
    const activityPage = await db.syncSource.listSessionCursorPage?.({
      limit: 2,
      offset: 0,
      sortBy: "lastActivity",
      sortDir: "desc",
    });
    assert.deepEqual(
      activityPage?.rows.map((row) => row.id),
      ["newest-session-time", "newest-update-time"]
    );
    assert.equal(activityPage?.total, 3);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite session cursor page applies date and search filters before paging", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-24T12:00:00.000Z",
  });

  try {
    await insertSqliteSession(db, "old-matching-branch", {
      startedAt: "2026-06-17T00:00:00.000Z",
      metadata: JSON.stringify({ gitBranch: "fea-2161" }),
    });
    await insertSqliteSession(db, "recent-other-branch", {
      startedAt: "2026-06-20T00:00:00.000Z",
      metadata: JSON.stringify({ gitBranch: "fea-9999" }),
    });
    await insertSqliteSession(db, "recent-matching-branch", {
      startedAt: "2026-06-21T00:00:00.000Z",
      metadata: JSON.stringify({ gitBranch: "fea-2161" }),
    });

    const page = await db.syncSource.listSessionCursorPage?.({
      limit: 25,
      offset: 0,
      sortBy: "lastActivity",
      sortDir: "desc",
      startDate: new Date("2026-06-18T00:00:00.000Z"),
      search: "fea-2161",
    });

    assert.deepEqual(
      page?.rows.map((row) => row.id),
      ["recent-matching-branch"]
    );
    assert.equal(page?.total, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Goal stage 1 (sync reliability): the Status facet renders into the cursor
// page's SQL via buildUsageStatusPredicate, so a status-filtered list read
// pages in SQL instead of hydrating the corpus. Branches exercised here avoid
// the wall-clock stale anchor (ACTIVE/STALE) so the test needs no fake timers:
// stored terminal statuses, the retired-spelling fold (ISS-4985), the Waiting
// display projection, and the multi-select OR.
test("SQLite session cursor page filters by the Status facet before paging", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-24T12:00:00.000Z",
  });

  try {
    await insertSqliteSession(db, "s-inactive", {
      status: "inactive",
      startedAt: "2026-06-21T00:00:00.000Z",
    });
    await insertSqliteSession(db, "s-error", {
      status: "error",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    // Non-terminal + awaiting input + not ended → DISPLAYS as Waiting.
    await insertSqliteSession(db, "s-waiting", {
      status: "active",
      startedAt: "2026-06-23T00:00:00.000Z",
      awaitingInputSince: "2026-06-23T01:00:00.000Z",
    });
    const pageFor = (statuses: string[]) =>
      db.syncSource.listSessionCursorPage?.({
        limit: 25,
        offset: 0,
        sortBy: "lastActivity",
        sortDir: "desc",
        statuses,
      });

    const inactive = await pageFor(["inactive"]);
    assert.deepEqual(
      inactive?.rows.map((row) => row.id),
      ["s-inactive"]
    );
    assert.equal(inactive?.total, 1);

    // ISS-5592 REVERSED this. A retired spelling used to fold onto the Inactive
    // population; it is unrecognized now, so the request matches nothing stored
    // and returns an empty page — the "confident empty page" ISS-4985 had fixed,
    // accepted here because no row can carry that spelling any more.
    const retired = await pageFor(["completed"]);
    assert.deepEqual(
      retired?.rows.map((row) => row.id),
      []
    );

    // The Waiting facet selects the display projection (awaiting + not ended),
    // not a stored literal.
    const waiting = await pageFor(["waiting"]);
    assert.deepEqual(
      waiting?.rows.map((row) => row.id),
      ["s-waiting"]
    );

    // Multi-select ORs within the facet; total reflects the filtered cohort.
    const multi = await pageFor(["inactive", "error"]);
    assert.deepEqual(
      multi?.rows.map((row) => row.id),
      ["s-error", "s-inactive"]
    );
    assert.equal(multi?.total, 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite session cursor page filters the date window by recent activity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-24T12:00:00.000Z",
  });

  try {
    await insertSqliteSession(db, "old-start-recent-activity", {
      startedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertSqliteEvent(
      db,
      "old-start-recent-activity",
      "2026-06-23T00:00:00.000Z"
    );
    await insertSqliteSession(db, "recent-start-no-events", {
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    await insertSqliteSession(db, "old-start-old-activity", {
      startedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertSqliteEvent(
      db,
      "old-start-old-activity",
      "2026-06-02T00:00:00.000Z"
    );

    const page = await db.syncSource.listSessionCursorPage?.({
      limit: 25,
      offset: 0,
      sortBy: "lastActivity",
      sortDir: "desc",
      startDate: new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.deepEqual(
      page?.rows.map((row) => row.id),
      ["old-start-recent-activity", "recent-start-no-events"]
    );
    assert.equal(page?.total, 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cursor last-activity sort uses denormalized last_activity_at and matches the old MAX(events.created_at) semantics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // "alpha": latest event is the newest activity overall.
    await insertSqliteSession(db, "alpha", {
      startedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertSqliteEvent(db, "alpha", "2026-06-02T00:00:00.000Z");
    await insertSqliteEvent(db, "alpha", "2026-06-10T00:00:00.000Z"); // MAX

    // "bravo": events present but all OLDER than alpha's MAX; activity = its MAX.
    await insertSqliteSession(db, "bravo", {
      startedAt: "2026-06-03T00:00:00.000Z",
    });
    await insertSqliteEvent(db, "bravo", "2026-06-05T00:00:00.000Z"); // MAX

    // "charlie": NO events → activity falls back to its started_at floor.
    await insertSqliteSession(db, "charlie", {
      startedAt: "2026-06-08T00:00:00.000Z",
    });

    // "delta": NO events, same started_at floor as charlie → tie broken by id.
    await insertSqliteSession(db, "delta", {
      startedAt: "2026-06-08T00:00:00.000Z",
    });

    // Expected last_activity values (the old COALESCE(MAX(events),started) key):
    //   alpha   = 2026-06-10 (event MAX)
    //   charlie = 2026-06-08 (started floor, no events)
    //   delta   = 2026-06-08 (started floor, no events)
    //   bravo   = 2026-06-05 (event MAX)
    // DESC order, id DESC tie-break between charlie/delta → delta before charlie.
    const expectedDesc = ["alpha", "delta", "charlie", "bravo"];

    const fullDesc = await db.syncSource.listSessionCursorPage?.({
      limit: 10,
      offset: 0,
      sortBy: "lastActivity",
      sortDir: "desc",
    });
    assert.deepEqual(
      fullDesc?.rows.map((row) => row.id),
      expectedDesc
    );
    assert.equal(fullDesc?.total, 4);

    // Perf regression guard (review comment, PR #1837): the whole point of the
    // denormalized NOT NULL column is that the last-activity sort can be served
    // by `idx_sessions_last_activity` directly. Ordering by the bare column (no
    // COALESCE wrapper) must let SQLite walk the index instead of materializing a
    // temp b-tree. This EXPLAIN QUERY PLAN mirrors the CTE shape that
    // listSqliteSessionCursorPage builds for the last-activity sort.
    const plan = await db.prisma.client.$queryRawUnsafe<{ detail: string }[]>(
      `EXPLAIN QUERY PLAN
         WITH activity AS (
           SELECT
             s.id,
             s.updated_at,
             s.started_at AS sort_started_at,
             s.last_activity_at AS sort_last_activity_at
           FROM sessions s
         )
         SELECT id, updated_at
         FROM activity
         ORDER BY sort_last_activity_at DESC, id DESC
         LIMIT 10 OFFSET 0`
    );
    const planText = plan.map((r) => r.detail).join("\n");
    assert.ok(
      planText.includes("idx_sessions_last_activity"),
      `last-activity sort must use idx_sessions_last_activity; plan was:\n${planText}`
    );
    assert.ok(
      !TEMP_BTREE_SORT_PATTERN.test(planText),
      `last-activity sort must not require a temp-b-tree filesort; plan was:\n${planText}`
    );

    // The denormalized column was populated for every session, so the read path
    // no longer depends on the events table at query time. Re-deriving the old
    // key directly from events/started_at must yield the same ordering.
    const recomputed = await db.prisma.client.$queryRawUnsafe<
      { id: string; key: string }[]
    >(
      `SELECT s.id AS id,
              COALESCE(
                (SELECT MAX(CASE WHEN e.created_at GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
                   THEN e.created_at ELSE NULL END)
                 FROM events e WHERE e.session_id = s.id),
                CASE WHEN s.started_at GLOB
                  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
                  THEN s.started_at ELSE '1970-01-01T00:00:00.000Z' END
              ) AS key
       FROM sessions s
       ORDER BY key DESC, s.id DESC`
    );
    assert.deepEqual(
      recomputed.map((row) => row.id),
      expectedDesc,
      "stored column ordering must equal the old per-page MAX(events) computation"
    );
    // The stored column value equals that recomputed key for every row.
    const stored = await db.prisma.client.$queryRawUnsafe<
      {
        id: string;
        last_activity_at: string;
      }[]
    >("SELECT id, last_activity_at FROM sessions ORDER BY id");
    const byId = new Map(stored.map((r) => [r.id, r.last_activity_at]));
    assert.equal(byId.get("alpha"), "2026-06-10T00:00:00.000Z");
    assert.equal(byId.get("bravo"), "2026-06-05T00:00:00.000Z");
    assert.equal(byId.get("charlie"), "2026-06-08T00:00:00.000Z");
    assert.equal(byId.get("delta"), "2026-06-08T00:00:00.000Z");

    // ASC mirrors DESC (key ASC, id ASC tie-break): charlie before delta.
    const fullAsc = await db.syncSource.listSessionCursorPage?.({
      limit: 10,
      offset: 0,
      sortBy: "lastActivity",
      sortDir: "asc",
    });
    assert.deepEqual(
      fullAsc?.rows.map((row) => row.id),
      ["bravo", "charlie", "delta", "alpha"]
    );

    // Paging is stable across page boundaries (limit/offset over the same order).
    const page1 = await db.syncSource.listSessionCursorPage?.({
      limit: 2,
      offset: 0,
      sortBy: "lastActivity",
      sortDir: "desc",
    });
    const page2 = await db.syncSource.listSessionCursorPage?.({
      limit: 2,
      offset: 2,
      sortBy: "lastActivity",
      sortDir: "desc",
    });
    assert.deepEqual(
      [
        ...(page1?.rows.map((r) => r.id) ?? []),
        ...(page2?.rows.map((r) => r.id) ?? []),
      ],
      expectedDesc
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
