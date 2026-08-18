/**
 * @file migration-baseline-adoption.test.ts
 * @description Regression guard for an untracked, possibly-PARTIAL pre-existing
 * SQLite store, wired with the PRODUCTION manifest + baseline constants.
 *
 * Two boot crashes motivated this: (1) an interim store with the sentinel
 * `sessions` table but empty `_desktop_migrations` re-ran `CREATE TABLE
 * "sessions"` → `table "sessions" already exists`; (2) recording `0001_init` as
 * applied-without-executing for such a store left missing tables uncreated →
 * `no such table: token_events`. Both are fixed by writing `0001_init`
 * idempotently and applying it normally, so it reconciles complete and partial
 * stores alike.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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

const tempDirs: string[] = [];

const NO_SUCH_COLUMN_RE = /no such column/i;

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function openDb(): Promise<SqliteClient> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-adopt-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  return db;
}

function runRealMigrations(db: SqliteClient) {
  return runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
}

async function tableExists(db: SqliteClient, name: string): Promise<boolean> {
  const r = await db.query<{ present: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $1
     ) AS present`,
    [name]
  );
  return r.rows[0]?.present === 1;
}

async function columnExists(
  db: SqliteClient,
  table: string,
  column: string
): Promise<boolean> {
  // `table` is a test literal, so inlining it into the pragma function is safe.
  const r = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = $1`,
    [column]
  );
  return Number(r.rows[0]?.n) > 0;
}

test("a clean install applies 0001_init once and is a no-op thereafter", async () => {
  const db = await openDb();
  try {
    const first = await runRealMigrations(db);
    assert.deepEqual(
      first.applied,
      MIGRATIONS.map((m) => m.name)
    );
    assert.ok(await tableExists(db, "sessions"));
    assert.ok(await tableExists(db, "token_events"));

    const second = await runRealMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.baselined, []);
  } finally {
    await db.close();
  }
});

test("an untracked PARTIAL store heals: missing tables are created, present ones survive", async () => {
  const db = await openDb();
  try {
    // First boot creates the full schema, then seed a row we expect to survive.
    await runRealMigrations(db);
    await db.query(
      `INSERT INTO sessions (id, status, harness)
       VALUES ('keep-me', 'completed', 'claude')`
    );
    await db.query(
      `INSERT INTO repository_default_authorities (
         identity_key, provider, provider_repository_id, repo_full_name,
         default_branch, availability, completeness, source, mechanism,
         trigger, credential_type, observation_key, observed_at, updated_at
       ) VALUES (
         'keep-authority', 'github', 'repo-1', 'acme/web', 'trunk',
         'available', 'complete', 'repository_rest', 'rest', 'surface_open',
         'github_app', 'observation-1', '2026-08-11T01:00:00.000Z',
         '2026-08-11T01:00:00.000Z'
       )`
    );

    // Simulate the broken interim store: a table is missing AND tracking is
    // wiped (so the runner sees an untracked, partial store).
    await db.exec('DROP TABLE "token_events";');
    await db.exec('DELETE FROM "_desktop_migrations";');
    assert.equal(await tableExists(db, "token_events"), false);
    assert.ok(await tableExists(db, "sessions"));

    // Re-running must NOT throw (idempotent CREATEs skip `sessions`), must
    // recreate `token_events`, and must preserve existing rows.
    const outcome = await runRealMigrations(db);
    assert.deepEqual(
      outcome.applied,
      MIGRATIONS.map((m) => m.name)
    );
    assert.ok(await tableExists(db, "token_events"));

    const kept = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = 'keep-me'"
    );
    assert.equal(Number(kept.rows[0]?.n), 1);
    const keptAuthority = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM repository_default_authorities
       WHERE identity_key = 'keep-authority'`
    );
    assert.equal(Number(keptAuthority.rows[0]?.n), 1);
  } finally {
    await db.close();
  }
});

test("multi-ADD-COLUMN heal re-applies a MISSING column even when an earlier ADD is a duplicate", async () => {
  // Regression: the idempotent-heal must run a migration statement-by-statement
  // so a `duplicate column` on one ALTER cannot skip a later ALTER. Otherwise a
  // partially-applied migration (one column present, one missing) gets recorded
  // as applied with the schema permanently out of sync — a corruption path.
  const db = await openDb();
  try {
    await runRealMigrations(db);
    assert.ok(await columnExists(db, "artifacts", "committed_at"));
    assert.ok(await columnExists(db, "pull_requests", "opened_at"));

    // Simulate a partial 0005: committed_at present, opened_at dropped, tracking
    // wiped (untracked store). Re-running 0005's first ALTER throws `duplicate
    // column name: committed_at`.
    await db.exec('ALTER TABLE "pull_requests" DROP COLUMN "opened_at";');
    await db.exec('DELETE FROM "_desktop_migrations";');
    assert.ok(await columnExists(db, "artifacts", "committed_at"));
    assert.equal(await columnExists(db, "pull_requests", "opened_at"), false);

    const outcome = await runRealMigrations(db);
    assert.deepEqual(
      outcome.applied,
      MIGRATIONS.map((m) => m.name)
    );
    // The heal skipped the duplicate committed_at ADD but STILL applied the
    // missing opened_at ADD — schema is fully back in sync.
    assert.ok(await columnExists(db, "pull_requests", "opened_at"));
    assert.ok(await columnExists(db, "artifacts", "committed_at"));
  } finally {
    await db.close();
  }
});

test("re-applying a DROP COLUMN migration on an untracked store heals instead of throwing", async () => {
  // SQLite can express neither `ADD COLUMN IF NOT EXISTS` nor `DROP COLUMN IF
  // EXISTS`, so the heal has to recognize BOTH already-applied signatures. Only
  // the ADD half existed until PLN-1562 added the manifest's first DROP COLUMN,
  // at which point an untracked-but-migrated store could no longer boot: the
  // re-applied DROP threw `no such column` and aborted the whole run.
  const db = await openDb();
  try {
    await runRealMigrations(db);
    assert.equal(await columnExists(db, "plans", "sync_state"), false);

    // The untracked store: schema fully migrated, tracking wiped.
    await db.exec('DELETE FROM "_desktop_migrations";');

    const outcome = await runRealMigrations(db);
    assert.deepEqual(
      outcome.applied,
      MIGRATIONS.map((m) => m.name)
    );
    // Still dropped, and every migration recorded — the heal skipped the DROP
    // rather than failing the run or silently leaving the schema out of sync.
    assert.equal(await columnExists(db, "plans", "sync_state"), false);
    assert.ok(await columnExists(db, "plans", "plan_key"));
  } finally {
    await db.close();
  }
});

test("an EARLIER migration referencing a LATER-dropped column heals on an untracked store", async () => {
  // The sharper half of the same problem. PLN-1562's drop (plans.sync_state)
  // was referenced by nothing before it, so only the DROP statement itself
  // needed tolerating. `artifacts.enrichment_state` is referenced by migrations
  // that run BEFORE the one dropping it — `0001_init` indexes it
  // (idx_artifacts_sweep) and `0011` filters on it — so re-applying the history
  // against an already-final schema fails on THOSE statements, not on the drop.
  // Skipping them is the only outcome that converges: the end state they reach
  // for is superseded by a migration that has already run.
  const db = await openDb();
  try {
    await runRealMigrations(db);
    assert.equal(
      await columnExists(db, "artifacts", "enrichment_state"),
      false
    );

    await db.exec('DELETE FROM "_desktop_migrations";');

    const outcome = await runRealMigrations(db);
    assert.deepEqual(
      outcome.applied,
      MIGRATIONS.map((m) => m.name)
    );
    assert.equal(
      await columnExists(db, "artifacts", "enrichment_state"),
      false
    );
    // The surviving columns on the same table are untouched — the heal skipped
    // only the statements naming the dropped column, not whole migrations.
    assert.ok(await columnExists(db, "artifacts", "lines_added"));
    assert.ok(await columnExists(db, "artifacts", "branch_name"));
  } finally {
    await db.close();
  }
});

test("a `no such column` for a column NOTHING drops still fails the run", async () => {
  // The negative half: the tolerance is keyed on the manifest proving the
  // column is dropped later. A migration naming a column that simply does not
  // exist is a real defect and must still abort, or the runner would record it
  // as applied over a schema that never received it.
  const db = await openDb();
  try {
    await runRealMigrations(db);
    await db.exec('DELETE FROM "_desktop_migrations";');

    await assert.rejects(
      () =>
        runDesktopMigrations(db, {
          migrations: [
            ...MIGRATIONS,
            {
              name: "9999_references_a_column_nothing_drops",
              // A duplicate-column failure first forces the per-statement heal,
              // so the second statement is judged by isAlreadyAppliedStatement
              // rather than short-circuiting before the heal is entered.
              sql: 'ALTER TABLE "artifacts" ADD COLUMN "kind" TEXT;\nCREATE INDEX "idx_probe" ON "artifacts"("column_that_never_existed");',
              checksum: "test-only-not-a-real-migration",
            },
          ],
          baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
          baselineMigrations: BASELINE_MIGRATIONS,
        }),
      NO_SUCH_COLUMN_RE
    );
  } finally {
    await db.close();
  }
});
