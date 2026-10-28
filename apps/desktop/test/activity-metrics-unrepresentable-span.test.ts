/**
 * @file activity-metrics-unrepresentable-span.test.ts
 * @description ISS-6417 (review sweep) — the THIRD copy of the unguarded
 * timestamp normalization, the one wearing a guard that looks protective.
 *
 * `activity-metrics.ts` `toNormalizedIso` gated on `Number.isFinite` before
 * calling `toISOString`, and a nanosecond epoch PASSES that check — 1.72e18 is
 * perfectly finite, it just exceeds the ±8.64e15 ms a `Date` can hold. So the
 * rollup threw the exact `RangeError` its own docstring promised it could not
 * ("this never throws mid-import"), and one unreadable segment span took the
 * whole session's metrics row with it.
 *
 * `session_activity_segments.start_ms` is a persisted bigint column, so it is a
 * trust boundary: the in-process types do not constrain what a row already on
 * disk holds. Asserted by the surviving row's exact spend, not by "did not
 * throw" — a rollup that wrote an empty row also does not throw.
 *
 * Lives in its own file because `activity-metrics.test.ts` is at 962 lines and
 * the repo ceiling is 1,000.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { upsertActivityMetricsRollup } from "../src/main/database/activity-metrics.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const NOW = "2026-07-01T12:00:00.000Z";
const SESSION_ID = "s-iss6417-nanos";

/**
 * A span past what `Date` can represent, chosen to be one a row can ACTUALLY
 * hold. The window is narrow and real: `Date` tops out at 8.64e15 ms while the
 * libSQL driver reads an integer back as a JS number only up to
 * `Number.MAX_SAFE_INTEGER` (~9.007e15), so anything in between round-trips out
 * of storage intact and still throws in `toISOString`. A full nanosecond epoch
 * (1.7e18) is the wrong probe here — the driver rejects it on read long before
 * the normalization sees it, which would test the driver rather than the guard.
 */
const UNREPRESENTABLE_MS = 9_000_000_000_000_000;

const CLOSE = 1e-9;

test("a segment span no Date can represent does not cost the session its metrics row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6417-span-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_activity_metrics");

    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id)
       VALUES ($1, $1, 'completed', $2, $2, $2, 'claude_code', 'user-1', NULL)`,
      SESSION_ID,
      NOW
    );
    await db.run(
      `INSERT INTO session_analytics
         (session_id, harness, human_turns, agent_turns, runtime_ms, started_day, is_human, event_count, updated_at)
       VALUES ($1, 'claude_code', 10, 0, 60000, '2026-07-01', 0, 0, $2)`,
      SESSION_ID,
      NOW
    );

    // One readable span, and one whose persisted `start_ms` no `Date` can
    // represent. The readable one is the positive control: its spend can only be
    // attributed if the rollup got past its unreadable neighbor.
    for (const seg of [
      { id: "seg-ok", startMs: 0, endMs: 100 },
      {
        id: "seg-unrepresentable",
        startMs: UNREPRESENTABLE_MS,
        endMs: UNREPRESENTABLE_MS + 100,
      },
    ]) {
      await db.run(
        `INSERT INTO session_activity_segments
           (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
         VALUES ($1, $2, 'implement', $3, $4, 0.9, '[]', 4, NULL, $5)`,
        seg.id,
        SESSION_ID,
        seg.startMs,
        seg.endMs,
        NOW
      );
    }
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, cost_usd_estimated)
       VALUES ($1, 'model-0', $2, 3.0)`,
      SESSION_ID,
      new Date(50).toISOString()
    );

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollup(tx, SESSION_ID, NOW)
      )
    );

    const rows = await db.prisma.client.$queryRawUnsafe<
      {
        segment_count: number;
        covered_segment_count: number;
        covered_spend_usd: number;
        total_spend_usd: number;
      }[]
    >(
      "SELECT * FROM session_activity_metrics WHERE session_id = $1",
      SESSION_ID
    );
    const row = rows[0];

    // A row at all is the headline: the RangeError used to abort the rollup, so
    // the session got no metrics row whatsoever. Both segments are still in the
    // population, and both count as covered — `isCoveredSegment` reads state and
    // confidence, not spend, so the unreadable span's zero spend does not
    // uncover it. The $3.00 still lands on the readable span, which is what
    // proves the rollup ran to completion rather than writing an empty shell.
    assert.equal(row?.segment_count, 2);
    assert.equal(row?.covered_segment_count, 2);
    assert.ok(Math.abs((row?.covered_spend_usd ?? 0) - 3.0) <= CLOSE);
    assert.ok(Math.abs((row?.total_spend_usd ?? 0) - 3.0) <= CLOSE);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
