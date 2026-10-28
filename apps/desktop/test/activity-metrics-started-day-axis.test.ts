/**
 * @file activity-metrics-started-day-axis.test.ts
 * @description ISS-6760 — `session_activity_metrics.started_day` is STORAGE-ONLY
 * and must never be offered as a day/group-by axis.
 *
 * The column copies `session_analytics.started_day` forward, and that is a
 * stored UTC day FEA-2430 declared storage-only: "any future DISPLAY read must
 * re-bucket from the raw timestamp with strftime(..., 'localtime') ... never
 * read this column" (session-analytics-rollup.ts). Every other desktop Insights
 * day series buckets in the user's LOCAL calendar (the timezone contract in
 * local-insights.ts, via `localDay()` in db-helpers.ts), so a coverage-over-time
 * chart grouped on the copy would put non-UTC users' activity on the wrong day.
 * That is not hypothetical: FEA-2999 had to rewrite exactly this read in
 * optimization-analytics-queries.ts. Migration 0060 dropped the copy's index so
 * nothing here reads as an endorsement of a UTC axis.
 *
 * Asserted over indexed COLUMNS rather than index NAMES, so a re-add under a
 * different name (Prisma's default `session_activity_metrics_started_day_idx`
 * from a bare `@@index([startedDay])`) fails this too. The column itself is
 * asserted to survive and stay WRITTEN: dropping it would put the bare name
 * `started_day` into the migration runner's `laterDroppedColumns` heal set,
 * where two surviving columns still use it (`session_analytics`,
 * `agent_component_session_usage`) — see 0060's note.
 *
 * Lives in its own file because `activity-metrics.test.ts` is at 962 lines and
 * the repo ceiling is 1,000 (cf. activity-metrics-unrepresentable-span.test.ts).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { upsertActivityMetricsRollup } from "../src/main/database/activity-metrics.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const NOW = "2026-07-01T12:00:00.000Z";
const SESSION_ID = "s-iss6760-day-axis";
/** The UTC day the rollup derives from NOW — what the storage-only copy holds. */
const STARTED_DAY = "2026-07-01";

test("ISS-6760: started_day is stored but carries no index, on any name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6760-day-axis-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_activity_metrics");

    const indexes = await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM pragma_index_list('session_activity_metrics')"
    );
    const indexedColumns: string[] = [];
    for (const index of indexes) {
      const columns = await db.prisma.client.$queryRawUnsafe<
        { name: string | null }[]
      >("SELECT name FROM pragma_index_info($1)", index.name);
      for (const column of columns) {
        if (column.name !== null) {
          indexedColumns.push(column.name);
        }
      }
    }
    assert.equal(
      indexedColumns.includes("started_day"),
      false,
      "an index on started_day reads as an endorsement of a UTC group-by axis"
    );
    // The surviving harness index proves the probes above see this table's real
    // indexes, so the absence assertion cannot pass on an empty result.
    assert.ok(indexedColumns.includes("harness"));

    // The column stays, and stays WRITTEN — it is storage, not an axis, so it
    // must still hold the rollup's UTC day rather than quietly becoming NULL.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id)
       VALUES ($1, $1, 'completed', $2, $2, $2, 'claude_code', 'user-1', NULL)`,
      SESSION_ID,
      NOW
    );
    await db.run(
      `INSERT INTO session_analytics
         (session_id, harness, human_turns, agent_turns, runtime_ms, started_day, is_human, event_count, updated_at)
       VALUES ($1, 'claude_code', 2, 2, 300000, $2, 0, 0, $3)`,
      SESSION_ID,
      STARTED_DAY,
      NOW
    );
    await db.run(
      `INSERT INTO session_activity_segments
         (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
       VALUES ('seg-1', $1, 'implement', 0, 100, 0.9, '[]', 4, NULL, $2)`,
      SESSION_ID,
      NOW
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, cost_usd_estimated)
       VALUES ($1, 'model-0', $2, 1.0)`,
      SESSION_ID,
      new Date(50).toISOString()
    );

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollup(tx, SESSION_ID, NOW)
      )
    );

    const rows = await db.prisma.client.$queryRawUnsafe<
      { started_day: string | null }[]
    >(
      "SELECT started_day FROM session_activity_metrics WHERE session_id = $1",
      SESSION_ID
    );
    assert.equal(rows[0]?.started_day, STARTED_DAY);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
