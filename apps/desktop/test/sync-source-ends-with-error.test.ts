/**
 * ISS-4586: the desktop sync payload assembly carries the per-session
 * `ends_with_error` SQLite flag (`1`/`0`/`NULL`) as the cloud contract's
 * `endsWithError: boolean | null`, so the cloud stale-session reaper can classify
 * an orphaned still-active session ERROR vs INACTIVE without re-deriving from
 * events. Drives the real SQLite -> loadSyncedSessions boundary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

test("ISS-4586: sync payload carries ends_with_error (1/0/NULL -> true/false/null)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4586-ends-with-error-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status, ends_with_error) VALUES ('err-1','error',1)"
    );
    await db.run(
      "INSERT INTO sessions (id, status, ends_with_error) VALUES ('ok-1','inactive',0)"
    );
    // A legacy row predating the column: ends_with_error stays NULL.
    await db.run(
      "INSERT INTO sessions (id, status) VALUES ('legacy-1','active')"
    );

    const sessions = await db.syncSource.loadSyncedSessions(
      ["err-1", "ok-1", "legacy-1"],
      emptyAttributionCache()
    );
    const byId = new Map(
      sessions.map((session) => [session.externalSessionId, session])
    );

    assert.equal(byId.get("err-1")?.endsWithError, true, "1 -> true");
    assert.equal(byId.get("ok-1")?.endsWithError, false, "0 -> false");
    // NULL stays null so the cloud treats it as not-error rather than
    // fabricating `false` — matching the reaper's absent-flag -> INACTIVE default.
    assert.equal(byId.get("legacy-1")?.endsWithError, null, "NULL -> null");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
