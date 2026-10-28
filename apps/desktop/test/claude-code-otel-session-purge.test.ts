/**
 * The `claude_code_*` OTel side tables have NO foreign key to `sessions`, so
 * nothing in the database removes them when a session goes away — every one is
 * deleted by hand in `deleteSessionRow` and `purgeExpiredChunk`. A table missing
 * from either list orphans its rows silently, and the rows are session-keyed,
 * so the orphan outlives the session it describes.
 *
 * This suite is the per-table assertion for that. It lives on its own rather
 * than inside `data-revision-rebuild.test.ts` (whose test 12 covers the same
 * contract for the pre-ISS-7352 tables) because that file is grandfathered
 * shrink-only against the 1,000-line ceiling.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  ClaudeCodeOtelTableName,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
  ClaudeCodePluginLifecycle,
} from "../src/main/otel/claude-code-otel-signal-contract.js";

const NOW = "2026-06-18T19:30:00.000Z";
const SESSION_ID = "claude-otel-purge-session";
const OTHER_SESSION_ID = "claude-otel-keep-session";
// Far enough back that the cutoff clears it whatever the default retention
// window is, so this fixture does not silently stop expiring if that changes.
const EXPIRED_ACTIVITY = "2020-01-01T00:00:00.000Z";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/**
 * Every side table the OTel lane writes. `token_usage` is excluded because the
 * transcript parser owns it and the OTel lane may not write it at all.
 */
const OTEL_SIDE_TABLES = [
  ClaudeCodeOtelTableName.CostEvent,
  ClaudeCodeOtelTableName.PermissionEvent,
  ClaudeCodeOtelTableName.ApiRequest,
  ClaudeCodeOtelTableName.ErrorEvent,
  ClaudeCodeOtelTableName.PermissionModeChange,
  ClaudeCodeOtelTableName.McpServerConnection,
  ClaudeCodeOtelTableName.AuthEvent,
  ClaudeCodeOtelTableName.PluginEvent,
  ClaudeCodeOtelTableName.LinesOfCode,
  ClaudeCodeOtelTableName.SessionStart,
  ClaudeCodeOtelTableName.ToolResult,
  ClaudeCodeOtelTableName.ActiveTime,
  ClaudeCodeOtelTableName.SessionIdentity,
  ClaudeCodeOtelTableName.LlmRequest,
] as const;

test("ISS-7352: deleting a session removes its rows from EVERY claude_code OTel side table", async () => {
  // Asserted per table, not as a total, so a single missing `deleteMany` names
  // itself instead of hiding inside an aggregate count.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    await seedSession(db, OTHER_SESSION_ID);
    await seedOtelRows(db, SESSION_ID);
    await seedOtelRows(db, OTHER_SESSION_ID);

    for (const tableName of OTEL_SIDE_TABLES) {
      assert.equal(
        await countRows(db, tableName, SESSION_ID),
        1,
        `${tableName} should be seeded before the delete`
      );
    }

    await db.deleteSessionRow(SESSION_ID);

    for (const tableName of OTEL_SIDE_TABLES) {
      assert.equal(
        await countRows(db, tableName, SESSION_ID),
        0,
        `${tableName} rows must not outlive their session`
      );
      // The positive sibling on the same derivation: the delete has to be
      // SESSION-SCOPED. A `deleteMany` with no `where` would satisfy the
      // assertion above while emptying the table for every other session.
      assert.equal(
        await countRows(db, tableName, OTHER_SESSION_ID),
        1,
        `${tableName} rows for an unrelated session must survive`
      );
    }
  } finally {
    await cleanup();
  }
});

test("ISS-7352: the retention purge removes rows from EVERY claude_code OTel side table", async () => {
  // `deleteSessionRow` and `purgeExpiredChunk` keep SEPARATE hand-written table
  // lists, so a table present in one can be missing from the other. The case
  // above covers the delete path; this one covers the retention sweep, or a
  // table dropped from only the sweep's list orphans its rows silently.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    // Inside the retention window, so the sweep must leave it alone. This is
    // the positive sibling: a purge with no cutoff would satisfy the
    // zero-rows assertion below while emptying the table for every session.
    await seedSession(db, OTHER_SESSION_ID, NOW);
    await seedOtelRows(db, SESSION_ID);
    await seedOtelRows(db, OTHER_SESSION_ID);

    const { purged } = await sweepExpiredSessions(db.prisma, NOW);
    assert.equal(purged, 1, "only the expired session should be purged");

    for (const tableName of OTEL_SIDE_TABLES) {
      assert.equal(
        await countRows(db, tableName, SESSION_ID),
        0,
        `${tableName} rows must not outlive the retention window`
      );
      assert.equal(
        await countRows(db, tableName, OTHER_SESSION_ID),
        1,
        `${tableName} rows inside the retention window must survive`
      );
    }
  } finally {
    await cleanup();
  }
});

async function openTestDatabase(): Promise<{
  db: SqliteDb;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-otel-purge-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function seedSession(
  db: SqliteDb,
  sessionId: string,
  lastActivityAt: string = EXPIRED_ACTIVITY
): Promise<void> {
  // The status must be TERMINAL: `deleteSessionRow` re-checks it inside the
  // transaction and refuses to delete a session that is still live, so a
  // non-terminal fixture would make this suite pass by never deleting anything.
  // `last_activity_at` is the retention sweep's age anchor, so it is set
  // explicitly rather than left to the column default.
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, last_activity_at, harness, billing_mode)
     VALUES ($1, $3, $2, $2, $4, 'claude', 'metered_api')`,
    sessionId,
    "2026-06-18T18:00:00.000Z",
    SESSION_STATUS.INACTIVE,
    lastActivityAt
  );
}

async function countRows(
  db: SqliteDb,
  tableName: (typeof OTEL_SIDE_TABLES)[number],
  sessionId: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
    `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE session_id = $1`,
    sessionId
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function seedOtelRows(db: SqliteDb, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.CostEvent} (id, session_id, model, cost_usd, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 1.25, '2026-06-18T19:00:00.000Z', $3, $4, $4)`,
    `${sessionId}-cost`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.PermissionEvent} (id, session_id, tool_name, decision, source, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'Bash', $3, $4, '2026-06-18T19:00:01.000Z', $5, $6, $6)`,
    `${sessionId}-permission`,
    sessionId,
    ClaudeCodePermissionDecision.Allow,
    ClaudeCodePermissionSource.Hook,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ApiRequest} (id, session_id, model, cost_usd, started_at, duration_ms, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 1.75, '2026-06-18T19:00:02.000Z', 2500, $3, $4, $4)`,
    `${sessionId}-api-request`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ErrorEvent} (id, session_id, error_kind, observed_at, occurrence_key, error_category, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'api_error', '2026-06-18T19:00:03.000Z', '', 'overloaded', $3, $4, $4)`,
    `${sessionId}-error`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.PermissionModeChange} (id, session_id, observed_at, from_mode, to_mode, data_revision, created_at, updated_at)
     VALUES ($1, $2, '2026-06-18T19:00:04.000Z', 'default', 'acceptEdits', $3, $4, $4)`,
    `${sessionId}-mode-change`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.McpServerConnection} (id, session_id, observed_at, status, connection_key, transport_type, data_revision, created_at, updated_at)
     VALUES ($1, $2, '2026-06-18T19:00:05.000Z', 'connected', '', 'stdio', $3, $4, $4)`,
    `${sessionId}-mcp`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.AuthEvent} (id, session_id, observed_at, action, occurrence_key, auth_method, data_revision, created_at, updated_at)
     VALUES ($1, $2, '2026-06-18T19:00:06.000Z', 'login', '', 'oauth', $3, $4, $4)`,
    `${sessionId}-auth`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.PluginEvent} (id, session_id, lifecycle, observed_at, plugin_key, plugin_name, data_revision, created_at, updated_at)
     VALUES ($1, $2, $3, '2026-06-18T19:00:07.000Z', '', 'design-pack', $4, $5, $5)`,
    `${sessionId}-plugin`,
    sessionId,
    ClaudeCodePluginLifecycle.Loaded,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.LinesOfCode} (id, session_id, model, observed_at, change_type, line_count, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', '2026-06-18T19:00:08.000Z', 'added', 120, $3, $4, $4)`,
    `${sessionId}-lines-of-code`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.SessionStart} (id, session_id, observed_at, start_type, session_count, data_revision, created_at, updated_at)
     VALUES ($1, $2, '2026-06-18T19:00:09.000Z', 'resume', 1, $3, $4, $4)`,
    `${sessionId}-session-start`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ToolResult} (id, session_id, tool_name, observed_at, result_key, tool_use_id, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'Bash', '2026-06-18T19:00:10.000Z', '', 'toolu_01AAA', $3, $4, $4)`,
    `${sessionId}-tool-result`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ActiveTime} (id, session_id, observed_at, activity_type, seconds, data_revision, created_at, updated_at)
     VALUES ($1, $2, '2026-06-18T19:00:11.000Z', 'human', 42, $3, $4, $4)`,
    `${sessionId}-active-time`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  // Keyed on session_id alone, so unlike its siblings it takes no id column.
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.SessionIdentity} (session_id, observed_at, organization_id, user_account_uuid, data_revision, created_at, updated_at)
     VALUES ($1, '2026-06-18T19:00:11.000Z', 'org_1', 'acct_1', $2, $3, $3)`,
    sessionId,
    effectiveDataRevision(),
    NOW
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.LlmRequest} (id, session_id, trace_id, span_id, started_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '2026-06-18T19:00:11.000Z', $5, $6, $6)`,
    `${sessionId}-llm-request`,
    sessionId,
    `${sessionId}-trace`,
    `${sessionId}-span`,
    effectiveDataRevision(),
    NOW
  );
}
