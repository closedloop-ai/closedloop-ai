/**
 * ISS-10721 review (whitlockk): `backfillActivityMetrics` must advance the sync
 * watermark STRICTLY FORWARD, per session.
 *
 * The stale-id query runs BEFORE the write transaction opens, so an import can
 * move one of the selected rows to a later `updated_at` in the gap. The pass's
 * own timestamp is the boot wall-clock, so a blind `UPDATE sessions SET
 * updated_at = $now` over the chunk moves that row BACKWARDS — behind a cursor
 * that has already read it — and the corrected rollup is never re-selected.
 * ISS-8758 established the rule; this is the third caller that has to keep it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { backfillActivityMetrics } from "../src/main/database/activity-metrics.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** The pass's own `now` — `backfillActivityMetrics` reads the wall clock. */
const SEED_AT = "2026-07-01T12:00:00.000Z";
/**
 * Where a concurrent import left the row after the stale-id query had already
 * selected it. Far enough ahead of any plausible wall clock that a backwards
 * write is unambiguous rather than a race.
 */
const IMPORT_AHEAD_AT = "2099-01-01T00:00:00.000Z";
const SESSION_ID = "s-watermark";
const SEGMENT_VERSION = 4;

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10721-watermark-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => SEED_AT,
  });
  await db.whenBootMaintenanceSettled();
  await db.run("DELETE FROM session_activity_metrics");
  return { db, dir };
}

async function seedStaleSession(db: SqliteDb) {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id)
     VALUES ($1, $1, 'completed', $2, $3, $2, 'claude_code', NULL, NULL)`,
    SESSION_ID,
    SEED_AT,
    // The import that landed in the gap.
    IMPORT_AHEAD_AT
  );
  await db.run(
    `INSERT INTO session_analytics
       (session_id, harness, human_turns, agent_turns, runtime_ms, started_day, is_human, event_count, updated_at)
     VALUES ($1, 'claude_code', 2, 2, 240000, '2026-07-01', 0, 0, $2)`,
    SESSION_ID,
    SEED_AT
  );
  await db.run(
    `INSERT INTO session_activity_segments
       (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
     VALUES ($1, $2, 'implement', 0, 100, 0.9, '[]', $3, NULL, $4)`,
    `${SESSION_ID}-seg-0`,
    SESSION_ID,
    SEGMENT_VERSION,
    SEED_AT
  );
  await db.run(
    `INSERT INTO token_events (session_id, model, created_at, cost_usd_estimated)
     VALUES ($1, 'model-0', $2, 2.0)`,
    SESSION_ID,
    SEED_AT
  );
}

async function readUpdatedAt(db: SqliteDb): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ updated_at: string }[]>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    SESSION_ID
  );
  const value = rows[0]?.updated_at;
  if (value === undefined) {
    throw new Error("precondition: the session row was read back");
  }
  return value;
}

test("the backfill never moves a session's watermark backwards", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedStaleSession(db);
    assert.equal(
      await readUpdatedAt(db),
      IMPORT_AHEAD_AT,
      "precondition: the import's later timestamp is what the row holds"
    );

    await backfillActivityMetrics(db.prisma, () => undefined);

    const rollup = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
      "SELECT session_id AS id FROM session_activity_metrics WHERE session_id = $1",
      SESSION_ID
    );
    assert.equal(rollup.length, 1, "precondition: the backfill wrote a rollup");

    const after = await readUpdatedAt(db);
    assert.ok(
      after > IMPORT_AHEAD_AT,
      `the watermark must advance STRICTLY past the import's ${IMPORT_AHEAD_AT}, got ${after}`
    );
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
