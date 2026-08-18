/**
 * @file session-analytics-tool-invocations.test.ts
 * The `tool_invocations` rollup counts a tool event only when `tool_name` is a
 * NON-EMPTY string. A hook can emit a tool event with an empty `tool_name` (not
 * just NULL), and the rollup's `tool_name <> ''` guard is the only thing keeping
 * it out of the count — which feeds the substantive/idle classification.
 *
 * Driven through the production `upsertSessionAnalyticsRollup` on purpose: this
 * guard previously lived in the Owner-facet suite asserting against a hand-copied
 * duplicate of the rollup SQL, so deleting the production guard left it green.
 * Its own file because the suite that owns rollups
 * (`session-analytics-backfill-batch.test.ts`) is a shrink-only grandfathered file.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { upsertSessionAnalyticsRollup } from "../src/main/database/session-analytics-rollup.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

const NOW = "2026-07-29T12:00:00.000Z";

test("empty tool_name event does not inflate tool_invocations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tool-invocations-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    const sid = "sess-empty-tool";
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at)
       VALUES ($1, $2, 'claude_code', '2026-07-28T08:00:00.000Z', $3)`,
      sid,
      SESSION_STATUS.INACTIVE,
      NOW
    );
    for (const [i, toolName] of ["", null, "Bash"].entries()) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, 'tool_use', $3, '2026-07-28T08:05:00.000Z')`,
        `empty-tool-evt${i}`,
        sid,
        toolName
      );
    }

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS)
      )
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { tool_invocations: number }[]
    >(
      "SELECT tool_invocations FROM session_analytics WHERE session_id = $1",
      sid
    );
    assert.equal(
      Number(row.tool_invocations),
      1,
      "only the non-empty tool_name event counts as a tool invocation"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
