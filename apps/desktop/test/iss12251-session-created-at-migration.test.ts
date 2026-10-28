/**
 * @file iss12251-session-created-at-migration.test.ts
 * @description ISS-12251 (PLN-2176 T-6.3): the migration adding
 * `sessions.created_at`, run against a store one migration behind it that
 * already holds a session. The upgrade must keep the row intact and leave its
 * `created_at` NULL for a later import to fill.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/migration/baseline-schema.js";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import { openTestDb } from "./agent-db-test-utils.js";

const CREATED_AT_MIGRATION = "20261014164812_iss12251_session_created_at";
const STARTED_AT = "2026-10-01T12:00:00.000Z";

const migrationIndex = MIGRATIONS.findIndex(
  ({ name }) => name === CREATED_AT_MIGRATION
);

type UpgradedRow = {
  id: string;
  name: string | null;
  started_at: string | null;
  created_at: string | null;
};

test("ISS-12251: a store holding a session upgrades cleanly and the row's created_at is NULL", async () => {
  assert.ok(migrationIndex > 0, "the created_at migration is in the manifest");
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss12251-created-at-"));
  try {
    const legacy = await openMigrationDatabase(
      path.join(dir, "agent-dashboard.pgdata")
    );
    try {
      await runDesktopMigrations(legacy.db, {
        migrations: MIGRATIONS.slice(0, migrationIndex),
        baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
        baselineMigrations: BASELINE_MIGRATIONS,
      });
      await legacy.db.query(
        `INSERT INTO sessions (id, name, status, started_at, updated_at)
         VALUES ('pre-column', 'Pre-column session', 'inactive', $1, $1)`,
        [STARTED_AT]
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
        CREATED_AT_MIGRATION
      );
      assert.equal(applied.length, 1, "the migration ran on open");
      assert.deepEqual(
        await upgraded.prisma.client.$queryRawUnsafe<UpgradedRow[]>(
          "SELECT id, name, started_at, created_at FROM sessions"
        ),
        [
          {
            id: "pre-column",
            name: "Pre-column session",
            started_at: STARTED_AT,
            created_at: null,
          },
        ]
      );
    } finally {
      await upgraded.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
