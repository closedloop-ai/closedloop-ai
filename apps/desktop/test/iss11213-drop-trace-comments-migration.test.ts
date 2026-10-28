/**
 * @file iss11213-drop-trace-comments-migration.test.ts
 * @description ISS-11213 (PLN-2162 M5.4): the migration that drops the
 * desktop-local `trace_comments` store, run against a database one migration
 * behind it that still holds queued and dead-lettered comments.
 *
 * The rows are dropped, not sent (PLN-2162 decision 13), so the upgrade must
 * leave no table, no index, and no request behind it. The upgrade runs through
 * the production store open (`openSqliteAgentDatabase`, boot maintenance
 * settled), so a flush added anywhere on that path reaches the stubbed `fetch`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/migration/baseline-schema.js";
import {
  openMigrationDatabase,
  type SqliteClient,
} from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import { openTestDb } from "./agent-db-test-utils.js";

const DROP_MIGRATION = "20261007164914_iss11213_drop_trace_comments";
const SEED_TIME = "2026-10-01T12:00:00.000Z";

const dropIndex = MIGRATIONS.findIndex(({ name }) => name === DROP_MIGRATION);

function migrationOptions(migrations: typeof MIGRATIONS) {
  return {
    migrations,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  };
}

/**
 * A pending root with a pending reply, and a dead-lettered root: the rows an
 * installed build would have sent or offered for retry.
 */
async function seedUndeliveredComments(db: SqliteClient): Promise<void> {
  const pendingReply = JSON.stringify([
    { id: "reply-pending", body: "reply", syncStatus: "local_pending" },
  ]);
  for (const row of [
    {
      id: "root-pending",
      replies: pendingReply,
      syncStatus: "local_pending",
      syncAction: "create",
      syncDeliveryStatus: "pending",
    },
    {
      id: "root-abandoned",
      replies: "[]",
      syncStatus: "sync_failed",
      syncAction: "create",
      syncDeliveryStatus: "abandoned",
    },
  ]) {
    await db.query(
      `INSERT INTO trace_comments
         (id, thread_id, target_type, target_id, artifact_id, surface, status,
          anchor, body, author_id, mentions, replies, comment_kind, sync_status,
          sync_action, sync_delivery_status, created_at, updated_at)
       VALUES ($1, $2, 'session', 'session-1', 'artifact-1', 'session_detail',
               'OPEN', '{}', 'body', 'author-1', '[]', $3, 'comment', $4, $5,
               $6, $7, $7)`,
      [
        row.id,
        `thread-${row.id}`,
        row.replies,
        row.syncStatus,
        row.syncAction,
        row.syncDeliveryStatus,
        SEED_TIME,
      ]
    );
  }
}

const TRACE_COMMENT_SCHEMA_OBJECTS_SQL = `SELECT name FROM sqlite_master
  WHERE tbl_name = 'trace_comments' OR name LIKE 'idx_trace_comments%'
  ORDER BY name`;

async function traceCommentSchemaObjects(db: SqliteClient): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    TRACE_COMMENT_SCHEMA_OBJECTS_SQL
  );
  return result.rows.map((row) => row.name);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("ISS-11213: a store holding undelivered comments upgrades cleanly, the table is gone, and nothing is sent", async () => {
  assert.ok(dropIndex > 0, "the drop migration is in the manifest");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss11213-drop-"));
  try {
    const legacy = await openMigrationDatabase(
      path.join(dir, "agent-dashboard.pgdata")
    );
    try {
      await runDesktopMigrations(
        legacy.db,
        migrationOptions(MIGRATIONS.slice(0, dropIndex))
      );
      await seedUndeliveredComments(legacy.db);
      const before = await legacy.db.query<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM trace_comments"
      );
      assert.equal(Number(before.rows[0]?.n), 2, "the seed landed");
      assert.ok(
        (await traceCommentSchemaObjects(legacy.db)).length > 1,
        "the table and its indexes exist before the upgrade"
      );
    } finally {
      await legacy.db.close();
    }

    const upgraded = await openTestDb(dir);
    try {
      const applied = await upgraded.prisma.client.$queryRawUnsafe<
        { name: string }[]
      >(
        'SELECT name FROM "_desktop_migrations" WHERE name = ?',
        DROP_MIGRATION
      );
      assert.equal(applied.length, 1, "the drop migration ran on open");
      assert.deepEqual(
        await upgraded.prisma.client.$queryRawUnsafe<{ name: string }[]>(
          TRACE_COMMENT_SCHEMA_OBJECTS_SQL
        ),
        []
      );
    } finally {
      await upgraded.close();
    }
    assert.equal(fetchSpy.mock.calls.length, 0, "no comment was sent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
