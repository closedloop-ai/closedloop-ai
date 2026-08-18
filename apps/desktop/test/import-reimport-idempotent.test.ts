/**
 * @file import-reimport-idempotent.test.ts
 * @description ISS-4476: the historical import path (`importSession`) must be
 * IDEMPOTENT — re-importing a session whose spine rows already exist must not
 * throw. The pre-fix new-session branch of `importPhaseSessionAndMainAgent`
 * inserted the `<sessionId>-main` `agents` row with a bare `INSERT` (no conflict
 * handling). When a prior/partial import left an `agents.id` (e.g. a residual
 * `<sessionId>-main` row after the owning `sessions` row was cleared) but
 * `getImportSession` returned null, the agent INSERT threw `SQLITE_CONSTRAINT:
 * UNIQUE constraint failed: agents.id` (code 1555). That aborted the whole
 * session import; the collector retried the same session on every backfill tick
 * → wedged at 1/N → desktop crash-loop (and the ISS-4483 Sessions-load errors).
 *
 * The fix (`upsertImportedMainAgentSpine`) recovers the colliding row ONLY when
 * it genuinely belongs to this session's canonical main agent (same
 * `session_id`, `type = 'main'`); a cross-session / non-main collision fails
 * closed (throws → `ImportResult.failed`) rather than reparenting another
 * session's agent. Legitimate recovery restores the canonical main-agent shape
 * and clears `current_tool`.
 *
 * These DB-backed tests drive the REAL ingest path (`db.importer.importSession`)
 * so the ownership check runs against a live SQLite store, and cover: (1) the
 * same-session orphan-agent recovery (the crash-report state) succeeds; (2) a
 * cross-session collision fails closed and does NOT reparent; (3) a plain
 * import-twice (existing-session path — which `getImportSession` short-circuits
 * before the new-session branch) stays idempotent.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-10T12:00:00.000Z";
// Well before NOW so `recentlyActive` is false and the run is a finished import.
const OLD_FILE_MTIME_MS = Date.parse("2026-07-01T12:00:00.000Z");
const STARTED_AT = "2026-07-01T12:00:00.000Z";
const ASSISTANT_TS = "2026-07-01T12:03:00.000Z";
const ENDED_AT = "2026-07-01T12:05:30.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function openDb(dir: string): Promise<Db> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

function fixture(sessionId: string): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/sandbox/project",
    model: "claude-opus-4-5",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    fileModifiedAt: OLD_FILE_MTIME_MS,
    userMessages: 1,
    assistantMessages: 1,
    messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "hello" }],
  });
}

async function countSessionRows(db: Db, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<Array<{ n: number }>>(
    "SELECT COUNT(*) AS n FROM sessions WHERE id = $1",
    sessionId
  );
  return Number(rows[0]?.n ?? 0);
}

async function countMainAgentRows(db: Db, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<Array<{ n: number }>>(
    "SELECT COUNT(*) AS n FROM agents WHERE session_id = $1 AND type = 'main'",
    sessionId
  );
  return Number(rows[0]?.n ?? 0);
}

async function querySessionStatus(
  db: Db,
  sessionId: string
): Promise<string | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ status: string }>
  >("SELECT status FROM sessions WHERE id = $1", sessionId);
  return rows[0]?.status;
}

async function queryMainAgent(
  db: Db,
  sessionId: string
): Promise<
  { session_id: string; current_tool: string | null; type: string } | undefined
> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ session_id: string; current_tool: string | null; type: string }>
  >(
    "SELECT session_id, current_tool, type FROM agents WHERE id = $1",
    `${sessionId}-main`
  );
  return rows[0];
}

async function countAgentRowsById(db: Db, agentId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<Array<{ n: number }>>(
    "SELECT COUNT(*) AS n FROM agents WHERE id = $1",
    agentId
  );
  return Number(rows[0]?.n ?? 0);
}

test("re-import of a session whose main-agent row survived a cleared session row succeeds (ISS-4476: no UNIQUE agents.id abort)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reimport-orphan-agent-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-orphan-agent";

    // 1. First import: creates the `sessions` row and the `<id>-main` agent row.
    const first = await db.importer.importSession(fixture(sessionId), "claude");
    assert.notEqual(first.failed, true);
    assert.equal(await countMainAgentRows(db, sessionId), 1);

    // 2. Simulate the prior/partial-import residue from the crash report: delete
    //    ONLY the `sessions` row, leaving the `<id>-main` agent orphaned. This is
    //    exactly the state that made `getImportSession` return null (→ the
    //    new-session branch) while the agent id already existed.
    //
    //    `agents.session_id` has an `ON DELETE CASCADE` FK to `sessions(id)` and
    //    the writer connection runs with `PRAGMA foreign_keys=ON` (see
    //    connection-pragmas.ts), so a plain `DELETE FROM sessions` would cascade
    //    the `-main` agent away too — leaving no collision to exercise. Bypass the
    //    cascade for this legacy-residue setup by disabling FK enforcement ONLY
    //    around the delete, then restore normal enforcement before the re-import so
    //    the import runs under the same FK regime as production. Each PRAGMA runs
    //    as its own statement (no enclosing transaction — SQLite silently ignores
    //    a `foreign_keys` PRAGMA issued inside a transaction).
    await db.prisma.write((tx) =>
      tx.$executeRawUnsafe("PRAGMA foreign_keys=OFF")
    );
    await db.prisma.write((tx) =>
      tx.$executeRawUnsafe("DELETE FROM sessions WHERE id = $1", sessionId)
    );
    await db.prisma.write((tx) =>
      tx.$executeRawUnsafe("PRAGMA foreign_keys=ON")
    );
    // Leave the orphan mid-tool: recovery must clear `current_tool` (matching the
    // reactivation path) so a stale tool cannot stay visible on the Agent card.
    await db.prisma.write((tx) =>
      tx.$executeRawUnsafe(
        "UPDATE agents SET current_tool = $1 WHERE id = $2",
        "Bash",
        `${sessionId}-main`
      )
    );
    assert.equal(await countSessionRows(db, sessionId), 0);
    assert.equal(
      await countMainAgentRows(db, sessionId),
      1,
      "the -main agent row must survive the session delete (FK cascade bypassed) to reproduce the collision"
    );

    // 3. Re-import the SAME session. Pre-fix this threw SQLITE_CONSTRAINT
    //    (UNIQUE agents.id) and aborted the import (result.failed).
    const second = await db.importer.importSession(
      fixture(sessionId),
      "claude"
    );
    assert.notEqual(
      second.failed,
      true,
      "re-import must not fail on the pre-existing same-session agent id"
    );

    // 4. The session imported fully: exactly one session row and one main agent
    //    (recovered in place — no duplicate), and the stale tool was cleared.
    assert.equal(await countSessionRows(db, sessionId), 1);
    assert.equal(await countMainAgentRows(db, sessionId), 1);
    assert.equal(await querySessionStatus(db, sessionId), "inactive");
    const recovered = await queryMainAgent(db, sessionId);
    assert.equal(
      recovered?.current_tool,
      null,
      "recovery must reset current_tool so a mid-tool row cannot publish a stale tool"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4476: a cross-session agents.id collision fails closed and does not reparent the foreign row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reimport-cross-session-"));
  const db = await openDb(dir);
  try {
    const victimSessionId = "sess-victim";
    const attackerSessionId = "sess-attacker";
    // The derived main id for the victim import. We plant a row at this id that
    // belongs to a DIFFERENT session (the attacker) — the exact wongk scenario
    // where two session ids derive the same `${id}-main` string. Recovering it
    // would silently steal the attacker's agent (and orphan its events under the
    // stolen id).
    const collidingId = `${victimSessionId}-main`;

    // Import the attacker session so its own spine rows exist, then reparent a
    // real agent row onto the colliding id owned by the attacker. FK enforcement
    // is on, so the attacker session row must exist for the agents FK to hold.
    const attacker = await db.importer.importSession(
      fixture(attackerSessionId),
      "claude"
    );
    assert.notEqual(attacker.failed, true);
    await db.prisma.write((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, ended_at, parent_agent_id, metadata)
         VALUES ($1, $2, 'sub', 'subagent', NULL, 'completed', NULL, NULL, $3, $3, $3, NULL, NULL)`,
        collidingId,
        attackerSessionId,
        STARTED_AT
      )
    );

    // Importing the victim derives `sess-victim-main`, which now collides with a
    // row owned by the attacker. The import must FAIL CLOSED.
    const victim = await db.importer.importSession(
      fixture(victimSessionId),
      "claude"
    );
    assert.equal(
      victim.failed,
      true,
      "a mis-owned agents.id collision must fail closed, not reparent"
    );

    // The foreign row is untouched: still owned by the attacker, still a subagent,
    // and there is still exactly one row at the colliding id (no duplicate/steal).
    const colliding = await queryMainAgent(db, victimSessionId);
    assert.equal(colliding?.session_id, attackerSessionId);
    assert.equal(colliding?.type, "subagent");
    assert.equal(await countAgentRowsById(db, collidingId), 1);
    // The victim's session row was rolled back with the failed gate txn — no
    // partial victim spine persisted.
    assert.equal(await countSessionRows(db, victimSessionId), 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// This exercises the EXISTING-session path, NOT the new-session ON CONFLICT
// branch: on the second import `getImportSession` finds the row and takes the
// `if (existing)` path (already idempotent before ISS-4476). It stays here as a
// guard that the common re-import case does not regress.
test("importing the same session twice is idempotent (no throw, single spine row set)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reimport-twice-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-reimport-twice";

    const first = await db.importer.importSession(fixture(sessionId), "claude");
    assert.notEqual(first.failed, true);
    const second = await db.importer.importSession(
      fixture(sessionId),
      "claude"
    );
    assert.notEqual(second.failed, true);

    assert.equal(await countSessionRows(db, sessionId), 1);
    assert.equal(await countMainAgentRows(db, sessionId), 1);
    assert.equal(await querySessionStatus(db, sessionId), "inactive");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
