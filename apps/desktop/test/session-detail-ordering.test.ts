import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

test("ISS-7575: unpaged detail reads use id to break started-at ties", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-detail-ordering-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
  });
  const startedAt = "2026-08-22T12:00:00.000Z";

  try {
    await insertSqliteSession(db, "active-a", {
      status: SESSION_STATUS.ACTIVE,
      startedAt,
    });
    await insertSqliteSession(db, "active-z", {
      status: SESSION_STATUS.ACTIVE,
      startedAt,
    });
    await insertSqliteSession(db, "historical-a", {
      status: SESSION_STATUS.INACTIVE,
      startedAt,
    });
    await insertSqliteSession(db, "historical-z", {
      status: SESSION_STATUS.INACTIVE,
      startedAt,
    });

    const actual = {
      active: (await db.sessions.getActiveWithDetails()).map(
        (session) => session.id
      ),
      historical: (await db.sessions.getHistoricalWithDetails()).map(
        (session) => session.id
      ),
    };
    assert.deepEqual(actual, {
      active: ["active-z", "active-a"],
      historical: ["historical-z", "historical-a"],
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
