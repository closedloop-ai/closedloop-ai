/**
 * @file localtime-halfhour-characterization.test.ts
 * @description FEA-2430 — characterizes SQLite/libSQL `'localtime'` bucketing
 * under a NON-whole-hour UTC offset. The display-facing analytics SQL buckets
 * days/hours with `strftime(..., 'localtime')`, which resolves against the
 * process timezone; a half-hour zone (IST, +05:30, no DST) proves the modifier
 * shifts by true wall-clock offset, not whole hours, and that a module-eval
 * `process.env.TZ` pin propagates into libSQL's localtime conversion.
 *
 * Lives in its own file because the TZ pin is per-process and the node:test
 * runner executes one process per test file (see sqlite-conversion-golden's
 * TZ=UTC pin for the same pattern in a different zone).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";

// Runs at module evaluation, before any test opens a DB or reads a Date.
process.env.TZ = "Asia/Kolkata";

test("TZ pin canary: process is running under Asia/Kolkata (+05:30)", () => {
  // getTimezoneOffset is minutes BEHIND UTC, so IST (+05:30) reports -330.
  // A loud failure here means the module-eval TZ pin did not take and every
  // localtime assertion below would be testing the wrong zone.
  assert.equal(new Date("2026-06-20T00:00:00.000Z").getTimezoneOffset(), -330);
});

test("libSQL strftime 'localtime' buckets by half-hour offset (day advances, hour wraps)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2430-halfhour-"));
  const { db } = await openMigrationDatabase(path.join(dir, "halfhour.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // 18:45Z = 00:15 IST the NEXT day; 06:15Z = 11:45 IST the SAME day.
    await db.query(
      `INSERT INTO events (session_id, event_type, created_at)
       VALUES ('hh', 'Stop', '2026-06-20T18:45:00.000Z'),
              ('hh', 'Stop', '2026-06-20T06:15:00.000Z')`
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
        { day: "2026-06-20", hour: 11, n: 1 },
        { day: "2026-06-21", hour: 0, n: 1 },
      ]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
