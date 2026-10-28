/**
 * @file session-analytics-started-day-bucket.test.ts
 * ISS-7579: `session_analytics.started_day` is written by
 * `upsertSessionAnalyticsRollup` from `storedUtcDaySql` and had no end-to-end
 * coverage — every pre-existing fixture that drives the rollup seeds a canonical
 * `sessions.started_at`, so the bucket's date guard never fired and the writer
 * could drift back to a raw `substr(...)` or to LOCAL-day bucketing while the
 * suite stayed green (whitlockk, #5786). The sibling
 * `component-usage-invoked-at-mixed-format.test.ts` cases prove the same helper
 * for `agent_component_session_usage`.
 *
 * ISS-12596 dropped `session_tool_analytics`, so the second column this file
 * used to pin is gone with it; the `session_analytics` half is unchanged.
 *
 * Its own file because the suite that owns rollups
 * (`session-analytics-backfill-batch.test.ts`) is a shrink-only grandfathered
 * file, and because this concern is the day bucket rather than the tool count
 * that `session-analytics-tool-invocations.test.ts` pins.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, test } from "vitest";
import { upsertSessionAnalyticsRollup } from "../src/main/database/session-analytics-rollup.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

// Pin a non-UTC zone so the UTC-vs-LOCAL half of this is deterministic rather
// than an accident of the runner's machine: under UTC the two answers coincide
// and a `localDay()` writer would pass. Restore the exact previous value (unset
// → delete the property) per the root AGENTS.md Test Practices rule, so a
// co-located runner mode cannot leak Chicago into a later file.
const originalTz = process.env.TZ;
process.env.TZ = "America/Chicago";
afterAll(() => {
  if (originalTz === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = originalTz;
  }
});

const NOW = "2026-07-29T12:00:00.000Z";
// 02:30Z on the 10th is 21:30 on the 9th in America/Chicago (CDT, UTC-5 — DST
// began the 8th), so the UTC day and the LOCAL day name DIFFERENT dates. The
// stored column is storage-only UTC (FEA-2430): swap `storedUtcDaySql` for
// `localDay()` and the assertion below reads "2026-03-09".
const NEAR_MIDNIGHT_STARTED_AT = "2026-03-10T02:30:00.000Z";
const NEAR_MIDNIGHT_UTC_DAY = "2026-03-10";
// No leading date, so the bucket's ISO-date GLOB guard must answer NULL. Drop
// that guard for a raw `substr(col, 1, 10)` and the column reads "not-a-time".
const UNSHAPED_STARTED_AT = "not-a-timestamp";

type StartedDayRow = { started_day: string | null };

/**
 * Seeds one session and rolls it up through the production writer, then returns
 * the `started_day` it persisted.
 */
async function rolledUpStartedDays(
  startedAt: string,
  sessionId: string
): Promise<string | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "started-day-bucket-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at)
       VALUES ($1, $2, 'claude_code', $3, $4)`,
      sessionId,
      SESSION_STATUS.INACTIVE,
      startedAt,
      NOW
    );

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, sessionId, NOW, ROLLUP_OPTS)
      )
    );

    const analytics = await db.prisma.client.$queryRawUnsafe<StartedDayRow[]>(
      "SELECT started_day FROM session_analytics WHERE session_id = $1",
      sessionId
    );
    return analytics[0].started_day;
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-7579: the rollup started_day column buckets the UTC day, not the local one", async () => {
  const startedDay = await rolledUpStartedDays(
    NEAR_MIDNIGHT_STARTED_AT,
    "sess-near-midnight"
  );
  assert.equal(startedDay, NEAR_MIDNIGHT_UTC_DAY);
});

test("ISS-7579: the rollup started_day column is NULL for a started_at with no leading date", async () => {
  const startedDay = await rolledUpStartedDays(
    UNSHAPED_STARTED_AT,
    "sess-unshaped-started-at"
  );
  assert.equal(startedDay, null);
});
