/**
 * @file historical-import-sync-watermark.test.ts
 * @description ISS-5086 regression: a newly-discovered historical transcript
 * must use import wall time for the sync watermark. Its event chronology stays
 * historical, but the new row must sort above an already-advanced cursor.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-04T12:00:00.000Z";
const CURSOR_AFTER_SESSION_ENDED = "2026-08-03T23:30:00.000Z";
const STARTED_AT = "2026-08-03T22:09:18.626Z";
const ENDED_AT = "2026-08-03T23:08:37.780Z";

test("ISS-5086: a late historical import is visible above an existing sync cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "late-import-watermark-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    const sessionId = "late-historical-session";
    const session = makeSession({
      sessionId,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      fileModifiedAt: Date.parse(ENDED_AT),
      messages: [
        {
          role: "assistant",
          timestamp: ENDED_AT,
          text: "historical activity",
        },
      ],
    });

    const result = await db.importer.importSession(session, "claude");
    assert.notEqual(result.failed, true);

    const rows = await db.prisma.client.$queryRawUnsafe<
      Array<{
        ended_at: string | null;
        started_at: string;
        updated_at: string;
      }>
    >(
      "SELECT started_at, ended_at, updated_at FROM sessions WHERE id = ?",
      sessionId
    );
    assert.deepEqual(rows[0], {
      started_at: STARTED_AT,
      ended_at: ENDED_AT,
      updated_at: NOW,
    });

    const incrementalRows = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_SESSION_ENDED,
      []
    );
    assert.equal(
      incrementalRows.some((row) => row.id === sessionId),
      true,
      "the new local row must remain discoverable even when the cursor already passed its historical end time"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
