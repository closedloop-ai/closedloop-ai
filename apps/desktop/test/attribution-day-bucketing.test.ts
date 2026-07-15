/**
 * @file attribution-day-bucketing.test.ts
 * @description Day bucketing + heatmap (FEA-1459 Fix 6; FEA-2430 localtime).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";

// FEA-2430: pinned so the localtime characterization below is deterministic
// across machines/CI. The UTC-dialect tests are TZ-independent (substr /
// strftime without 'localtime'), so the pin does not affect them. Runs at
// module evaluation, before any test opens a DB.
process.env.TZ = "America/Chicago";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 5: Day bucketing + heatmap (Fix 6)
// ═══════════════════════════════════════════════════════════════════════════

test("SQLite: UTC substr day bucketing groups token events by UTC calendar day", async () => {
  // The SQLite migration originally replaced Postgres
  // `(created_at::timestamptz AT TIME ZONE $tz)::date` with UTC
  // `substr(created_at, 1, 10)` bucketing. FEA-2430 restored LOCAL-day display
  // bucketing via `strftime(..., 'localtime')` in the production analytics SQL
  // (local-insights.ts / dashboard-queries.ts — see the localtime
  // characterization below and test/localtime-halfhour-characterization.test.ts).
  // These UTC-dialect tests remain to characterize the raw substr/strftime
  // semantics still used for STORAGE-side derivations (write-core started_day).
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-tz-"));
  const { db } = await openMigrationDatabase(path.join(dir, "tz.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS token_events (
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);

    const events = [
      // UTC day is taken verbatim from the ISO prefix.
      { ts: "2026-06-08T01:30:00.000Z", input: 100 },
      { ts: "2026-06-08T00:00:00.000Z", input: 50 },
      { ts: "2026-06-07T23:59:59.000Z", input: 200 },
    ];
    for (const ev of events) {
      await db.query(
        `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ('utc-test', 'claude', $1, $2, 0, 0, 0)`,
        [ev.ts, ev.input]
      );
    }

    const result = await db.query<{ day: string; total_input: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(input_tokens) AS total_input
       FROM token_events
       WHERE session_id = 'utc-test'
       GROUP BY day
       ORDER BY day`
    );

    const dayMap = new Map(
      result.rows.map((r) => [r.day, Number(r.total_input)])
    );
    assert.equal(
      dayMap.get("2026-06-07"),
      200,
      "late-UTC event buckets to June 7"
    );
    assert.equal(
      dayMap.get("2026-06-08"),
      150,
      "early-UTC events bucket to June 8"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite: UTC substr/strftime hour bucketing extracts the UTC hour", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-hr-"));
  const { db } = await openMigrationDatabase(path.join(dir, "hr.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await db.query(
      `INSERT INTO events (session_id, event_type, created_at)
       VALUES ('hr', 'Stop', '2026-06-08T13:45:00.000Z'),
              ('hr', 'Stop', '2026-06-08T13:10:00.000Z'),
              ('hr', 'Stop', '2026-06-08T09:00:00.000Z')`
    );

    const result = await db.query<{ day: string; hour: number; n: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              CAST(strftime('%H', created_at) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM events
       GROUP BY day, hour
       ORDER BY hour`
    );

    assert.deepEqual(
      result.rows.map((r) => ({
        day: r.day,
        hour: Number(r.hour),
        n: Number(r.n),
      })),
      [
        { day: "2026-06-08", hour: 9, n: 1 },
        { day: "2026-06-08", hour: 13, n: 2 },
      ]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite: 'localtime' strftime buckets by the process-local day and hour (FEA-2430 display dialect)", async () => {
  // The production analytics queries (local-insights.ts, dashboard-queries.ts)
  // bucket DISPLAY days/hours with strftime(..., 'localtime'). Same seed shape
  // as the UTC tests above, asserted under the pinned America/Chicago zone:
  // a late-UTC event belongs to the PREVIOUS local calendar day.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2430-lt-"));
  const { db } = await openMigrationDatabase(path.join(dir, "lt.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await db.query(
      `INSERT INTO events (session_id, event_type, created_at)
       VALUES ('lt', 'Stop', '2026-06-08T03:30:00.000Z'),
              ('lt', 'Stop', '2026-06-08T13:10:00.000Z')`
    );

    const result = await db.query<{ day: string; hour: number; n: number }>(
      `SELECT strftime('%Y-%m-%d', created_at, 'localtime') AS day,
              CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM events
       GROUP BY day, hour
       ORDER BY day, hour`
    );

    assert.deepEqual(
      result.rows.map((r) => ({
        day: r.day,
        hour: Number(r.hour),
        n: Number(r.n),
      })),
      [
        // 03:30Z = June 7 22:30 CDT — previous LOCAL day (UTC substr says June 8).
        { day: "2026-06-07", hour: 22, n: 1 },
        // 13:10Z = June 8 08:10 CDT — same local day, shifted hour.
        { day: "2026-06-08", hour: 8, n: 1 },
      ]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
