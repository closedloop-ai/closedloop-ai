/**
 * @file migration-0017-usage-backfill.test.ts
 * @description FEA-2990 — migration 0017 must PRESERVE existing
 * `agent_component_session_usage` rows across the PK rebuild, carrying them into
 * the '' (no-branch) bucket.
 *
 * The rollup is normally rematerialized per-session at import, but on an UPGRADE
 * the boot-maintenance chain does not re-run that pass and DATA_REVISION is
 * unchanged, so already-imported sessions are never re-imported. A bare
 * drop+recreate would therefore wipe every existing install's local component
 * usage/analytics until each transcript happened to be reimported. This test
 * seeds a pre-0017 row and asserts the migration's INSERT…SELECT backfill keeps
 * it (in the '' bucket) rather than dropping it.
 *
 * Runs the REAL migration.sql against an in-memory libSQL DB seeded with the
 * pre-0017 (0015-shape) table. Run: `node --import tsx --test <file>`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = path.join(
  HERE,
  "..",
  "prisma",
  "migrations",
  "0017_event_git_branch_per_event_usage",
  "migration.sql"
);

// Minimal pre-0017 schema: the migration ALTERs `events` and rebuilds
// `agent_component_session_usage`, so both must exist first. Mirrors the 0015
// old-shape usage table (no git_branch column / PK member).
const PRE_0017_SCHEMA = `
  CREATE TABLE "events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "event_type" TEXT,
    "tool_name" TEXT,
    "created_at" TEXT
  );
  CREATE TABLE "agent_component_session_usage" (
    "session_id" TEXT NOT NULL,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "agent_component_id" TEXT,
    "harness" TEXT,
    "invocations" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "first_invoked_at" TEXT,
    "last_invoked_at" TEXT,
    "started_day" TEXT,
    PRIMARY KEY ("session_id", "component_kind", "component_key")
  );
`;

test("FEA-2990: migration 0017 backfills existing usage rows into the '' bucket", async () => {
  const db = createClient({ url: ":memory:", intMode: "number" });
  try {
    await db.executeMultiple(PRE_0017_SCHEMA);

    // A pre-existing rollup row from an install that upgraded to 0017.
    await db.execute({
      sql: `INSERT INTO "agent_component_session_usage"
              (session_id, component_kind, component_key, agent_component_id,
               harness, invocations, error_count, first_invoked_at,
               last_invoked_at, started_day)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "sess-1",
        "tool",
        "Bash",
        "cmp-1",
        "claude",
        7,
        1,
        "2026-06-01T10:00:00.000Z",
        "2026-06-01T10:05:00.000Z",
        "2026-06-01",
      ],
    });

    // Apply the real migration.
    await db.executeMultiple(await readFile(MIGRATION_SQL, "utf8"));

    // The row must survive — in the '' (no-branch) bucket — not be dropped.
    const after = await db.execute(
      `SELECT session_id, component_kind, component_key, git_branch,
              agent_component_id, harness, invocations, error_count,
              first_invoked_at, last_invoked_at, started_day
       FROM "agent_component_session_usage"`
    );
    assert.equal(
      after.rows.length,
      1,
      "the pre-existing usage row is preserved"
    );
    const row = after.rows[0] as Record<string, unknown>;
    assert.equal(row.session_id, "sess-1");
    assert.equal(row.component_kind, "tool");
    assert.equal(row.component_key, "Bash");
    // Carried into the '' sentinel bucket — exactly what a re-import would assign.
    assert.equal(row.git_branch, "");
    // Every non-key column is copied verbatim (no data loss).
    assert.equal(row.agent_component_id, "cmp-1");
    assert.equal(row.harness, "claude");
    assert.equal(row.invocations, 7);
    assert.equal(row.error_count, 1);
    assert.equal(row.first_invoked_at, "2026-06-01T10:00:00.000Z");
    assert.equal(row.last_invoked_at, "2026-06-01T10:05:00.000Z");
    assert.equal(row.started_day, "2026-06-01");

    // The new column exists on `events` and the temp table is gone.
    const eventsCols = await db.execute(`PRAGMA table_info("events")`);
    const hasGitBranch = eventsCols.rows.some(
      (r) => (r as Record<string, unknown>).name === "git_branch"
    );
    assert.ok(hasGitBranch, "events.git_branch column was added");
    const leftover = await db.execute(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name='agent_component_session_usage_old'`
    );
    assert.equal(leftover.rows.length, 0, "the rename temp table is dropped");
  } finally {
    db.close();
  }
});
