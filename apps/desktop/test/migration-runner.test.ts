/**
 * @file migration-runner.test.ts
 * @description Exercises the desktop migration runner against a real on-disk
 * libSQL database, covering every path the runner
 * must get right: fresh install, baselining a pre-runner install (including an
 * older legacy schema), applying a pending migration, transactional rollback of
 * a failed migration, and refusal on checksum drift or a downgraded app.
 *
 * Uses a small synthetic schema (a `widgets` table) rather than the real one,
 * so the assertions stay legible and independent of the production migrations.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";
import {
  type EmbeddedMigration,
  type MigrationDb,
  runDesktopMigrations,
} from "../src/main/database/migration-runner.js";
import {
  DesktopMigrationError,
  MigrationRefusalKind,
} from "../src/main/migration-refusal.js";

function migration(name: string, sql: string): EmbeddedMigration {
  return {
    name,
    checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    sql,
  };
}

const M1 = migration(
  "0001_init",
  "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT);"
);
const M2 = migration(
  "0002_add_color",
  "ALTER TABLE widgets ADD COLUMN color TEXT;"
);
// Frozen legacy re-assert sequence representing the union of M1 + M2 at the
// cutover shape. SQLite has no `ADD COLUMN IF NOT EXISTS`, so (unlike the prior
// Postgres sequence) the lift of an older install is expressed as a single
// idempotent `CREATE TABLE IF NOT EXISTS` at the full shape — a no-op on an
// install already at the cutover shape. (The production re-assert sequence is
// now empty post-migration; this synthetic one only exercises the runner's
// record-without-execute baselining path.)
const BASELINE_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, name TEXT, color TEXT);",
];
const BASELINE_NAMES = [M1.name, M2.name];

// Models a post-hoc migration squash (FEA-2038): the old genesis G_OLD plus the
// superseded S_COLOR migration were folded into a single G_NEW genesis — same
// name, new checksum. A DB that ran G_OLD + S_COLOR is schema-identical to a
// fresh G_NEW, so the runner should self-heal it instead of refusing on drift.
const G_OLD = migration(
  "0001_init",
  "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, name TEXT);"
);
const S_COLOR = migration(
  "0002_add_color",
  "ALTER TABLE widgets ADD COLUMN color TEXT;"
);
const G_NEW = migration("0001_init", `${G_OLD.sql}\n${S_COLOR.sql}`);
const COLLAPSE_CONFIG = [
  { genesisName: "0001_init", supersededNames: ["0002_add_color"] },
] as const;

async function genesisChecksum(db: MigrationDb): Promise<string | undefined> {
  const result = await db.query<{ checksum: string }>(
    'SELECT "checksum" FROM "_desktop_migrations" WHERE "name" = $1',
    ["0001_init"]
  );
  return result.rows[0]?.checksum;
}

const tempDirs: string[] = [];

async function freshDb(): Promise<MigrationDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-runner-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "widgets.sqlite"));
  // The libSQL handle structurally satisfies MigrationDb (exec/query/transaction).
  return db;
}

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function listApplied(db: MigrationDb): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    'SELECT "name" FROM "_desktop_migrations" ORDER BY "name"'
  );
  return result.rows.map((row) => row.name);
}

async function tableExists(db: MigrationDb, name: string): Promise<boolean> {
  const result = await db.query<{ present: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = $1
     ) AS present`,
    [name]
  );
  return result.rows[0]?.present === 1;
}

async function columnExists(
  db: MigrationDb,
  table: string,
  column: string
): Promise<boolean> {
  // pragma_table_info is the SQLite catalog for a table's columns.
  const result = await db.query<{ name: string }>(
    "SELECT name FROM pragma_table_info($1) WHERE name = $2",
    [table, column]
  );
  return result.rows.length > 0;
}

async function seedTracking(
  db: MigrationDb,
  rows: { name: string; checksum: string }[]
): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_desktop_migrations" (
       "name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL
     );`
  );
  for (const row of rows) {
    await db.query(
      'INSERT INTO "_desktop_migrations" ("name", "checksum", "applied_at") VALUES ($1, $2, $3)',
      [row.name, row.checksum, "2026-01-01T00:00:00.000Z"]
    );
  }
}

test("fresh install applies all migrations in order", async () => {
  const db = await freshDb();
  const outcome = await runDesktopMigrations(db, {
    migrations: [M1, M2],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: BASELINE_NAMES,
    legacySentinelTable: "widgets",
  });

  assert.deepEqual(outcome.applied, [M1.name, M2.name]);
  assert.deepEqual(outcome.baselined, []);
  assert.deepEqual(await listApplied(db), [M1.name, M2.name]);
  assert.ok(await columnExists(db, "widgets", "color"));
});

test("existing pre-runner install is baselined without executing migrations", async () => {
  const db = await freshDb();
  // A pre-runner install already at the cutover shape. If the runner *executed*
  // M1 (CREATE TABLE widgets) it would throw — baselining records it instead.
  await db.exec(
    "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, color TEXT);"
  );

  const outcome = await runDesktopMigrations(db, {
    migrations: [M1, M2],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: BASELINE_NAMES,
    legacySentinelTable: "widgets",
  });

  assert.deepEqual(outcome.baselined, [M1.name, M2.name]);
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(await listApplied(db), [M1.name, M2.name]);
});

test("a sentinel-present install is baselined (records, does not execute)", async () => {
  const db = await freshDb();
  // A pre-cutover table (without `color`) trips the sentinel, so the runner
  // takes the baseline path: it records M1+M2 as applied WITHOUT executing them.
  // (SQLite cannot express an idempotent `ADD COLUMN IF NOT EXISTS` re-assert,
  // and the production re-assert sequence is empty post-migration, so unlike the
  // Postgres version this no longer lifts the column — it only records history.)
  await db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT);");

  const outcome = await runDesktopMigrations(db, {
    migrations: [M1, M2],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: BASELINE_NAMES,
    legacySentinelTable: "widgets",
  });

  // M2 (ADD COLUMN color) was recorded as applied, not executed, so the column
  // stays absent — proving the runner did not run migration SQL on a baseline.
  assert.equal(await columnExists(db, "widgets", "color"), false);
  assert.deepEqual(outcome.baselined, [M1.name, M2.name]);
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(await listApplied(db), [M1.name, M2.name]);
});

test("pending migration applies on an already-managed install", async () => {
  const db = await freshDb();
  await runDesktopMigrations(db, {
    migrations: [M1],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: BASELINE_NAMES,
    legacySentinelTable: "widgets",
  });

  const outcome = await runDesktopMigrations(db, {
    migrations: [M1, M2],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: BASELINE_NAMES,
    legacySentinelTable: "widgets",
  });

  assert.deepEqual(outcome.applied, [M2.name]);
  assert.deepEqual(await listApplied(db), [M1.name, M2.name]);
  assert.ok(await columnExists(db, "widgets", "color"));
});

test("re-running with no pending migrations is a no-op", async () => {
  const db = await freshDb();
  const config = {
    migrations: [M1, M2],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: BASELINE_NAMES,
    legacySentinelTable: "widgets",
  };
  await runDesktopMigrations(db, config);
  const outcome = await runDesktopMigrations(db, config);
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(outcome.baselined, []);
});

test("a failing migration rolls back wholesale, leaving the prior version intact", async () => {
  const db = await freshDb();
  // The second statement fails; the CREATE before it must roll back with it.
  const bad = migration(
    "0002_bad",
    "CREATE TABLE temp_bad (id TEXT PRIMARY KEY);\nINSERT INTO does_not_exist (id) VALUES ('x');"
  );

  await assert.rejects(
    runDesktopMigrations(db, {
      migrations: [M1, bad],
      baselineStatements: BASELINE_STATEMENTS,
      baselineMigrations: BASELINE_NAMES,
      legacySentinelTable: "widgets",
    })
  );

  // M1 (its own committed transaction) survives; the failed migration left no
  // tracking row and no partial table.
  assert.deepEqual(await listApplied(db), [M1.name]);
  assert.equal(await tableExists(db, "temp_bad"), false);
});

test("refuses on checksum drift", async () => {
  const db = await freshDb();
  await db.exec(M1.sql);
  await seedTracking(db, [{ name: M1.name, checksum: "0".repeat(64) }]);

  await assert.rejects(
    runDesktopMigrations(db, {
      migrations: [M1],
      baselineStatements: BASELINE_STATEMENTS,
      baselineMigrations: BASELINE_NAMES,
      legacySentinelTable: "widgets",
    }),
    (error: unknown) =>
      error instanceof DesktopMigrationError &&
      error.kind === MigrationRefusalKind.ChecksumDrift
  );
});

test("refuses on downgrade (DB has a migration the bundle lacks)", async () => {
  const db = await freshDb();
  await seedTracking(db, [
    { name: M1.name, checksum: M1.checksum },
    { name: "0099_from_the_future", checksum: "a".repeat(64) },
  ]);

  await assert.rejects(
    runDesktopMigrations(db, {
      migrations: [M1],
      baselineStatements: BASELINE_STATEMENTS,
      baselineMigrations: BASELINE_NAMES,
      legacySentinelTable: "widgets",
    }),
    (error: unknown) =>
      error instanceof DesktopMigrationError &&
      error.kind === MigrationRefusalKind.Downgrade
  );
});

test("refuses on baseline_missing (baseline migration absent from manifest)", async () => {
  const db = await freshDb();
  // Sentinel present → baseline path entered; but a BASELINE_NAMES entry (M1)
  // is absent from the bundled migrations.
  await db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT);");

  await assert.rejects(
    runDesktopMigrations(db, {
      migrations: [M2], // M1.name is in BASELINE_NAMES but not here
      baselineStatements: BASELINE_STATEMENTS,
      baselineMigrations: BASELINE_NAMES,
      legacySentinelTable: "widgets",
    }),
    (error: unknown) =>
      error instanceof DesktopMigrationError &&
      error.kind === MigrationRefusalKind.BaselineMissing
  );
});

test("refuses on a gapped history (later migration applied, earlier missing)", async () => {
  const db = await freshDb();
  // Seed a non-contiguous history: M2 recorded as applied, M1 missing.
  await seedTracking(db, [{ name: M2.name, checksum: M2.checksum }]);

  await assert.rejects(
    runDesktopMigrations(db, {
      migrations: [M1, M2],
      baselineStatements: BASELINE_STATEMENTS,
      baselineMigrations: BASELINE_NAMES,
      legacySentinelTable: "widgets",
    }),
    (error: unknown) =>
      error instanceof DesktopMigrationError &&
      error.kind === MigrationRefusalKind.HistoryGap
  );
});

test("self-heals a pre-collapse history by rebaselining superseded migrations into the genesis", async () => {
  const db = await freshDb();
  // Schema already at the full post-fold shape — every folded migration ran.
  await db.exec(
    "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, color TEXT);"
  );
  // Pre-collapse tracking: the OLD genesis checksum + the now-folded migration.
  await seedTracking(db, [
    { name: G_OLD.name, checksum: G_OLD.checksum },
    { name: S_COLOR.name, checksum: S_COLOR.checksum },
  ]);

  const outcome = await runDesktopMigrations(db, {
    migrations: [G_NEW],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: [],
    collapsedMigrations: COLLAPSE_CONFIG,
    legacySentinelTable: "widgets",
  });

  // The superseded row was folded in (not executed); nothing was applied.
  assert.deepEqual(outcome.rebaselined, [S_COLOR.name]);
  assert.deepEqual(outcome.applied, []);
  // Tracking collapsed to a single genesis row carrying the bundled checksum.
  assert.deepEqual(await listApplied(db), [G_NEW.name]);
  assert.equal(await genesisChecksum(db), G_NEW.checksum);
  // Data/schema untouched — no DDL ran.
  assert.ok(await columnExists(db, "widgets", "color"));
});

test("does not rebaseline a partial pre-collapse history; refuses safely", async () => {
  const db = await freshDb();
  await db.exec(
    "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, color TEXT);"
  );
  // Only ONE of the two declared superseded migrations is recorded — the fold's
  // other DDL may never have run, so auto-rebaseline must NOT claim it applied.
  await seedTracking(db, [
    { name: G_OLD.name, checksum: G_OLD.checksum },
    { name: S_COLOR.name, checksum: S_COLOR.checksum },
  ]);

  await assert.rejects(
    runDesktopMigrations(db, {
      migrations: [G_NEW],
      baselineStatements: BASELINE_STATEMENTS,
      baselineMigrations: [],
      collapsedMigrations: [
        {
          genesisName: "0001_init",
          supersededNames: ["0002_add_color", "0003_add_size"],
        },
      ],
      legacySentinelTable: "widgets",
    }),
    // It must REFUSE rather than silently rebaseline. Which guard fires depends
    // on iteration order (the genesis checksum mismatch trips ChecksumDrift; the
    // orphaned superseded row would otherwise trip Downgrade) — either is a safe
    // stop. What matters is no partial rebaseline occurred.
    (error: unknown) =>
      error instanceof DesktopMigrationError &&
      (error.kind === MigrationRefusalKind.ChecksumDrift ||
        error.kind === MigrationRefusalKind.Downgrade)
  );

  // Tracking is left untouched — no partial rebaseline happened.
  assert.deepEqual(await listApplied(db), [G_OLD.name, S_COLOR.name]);
  assert.equal(await genesisChecksum(db), G_OLD.checksum);
});

test("collapsed-migration reconcile is a no-op on a clean genesis-only install", async () => {
  const db = await freshDb();
  const config = {
    migrations: [G_NEW],
    baselineStatements: BASELINE_STATEMENTS,
    baselineMigrations: [],
    collapsedMigrations: COLLAPSE_CONFIG,
    legacySentinelTable: "widgets",
  };

  const first = await runDesktopMigrations(db, config);
  assert.deepEqual(first.applied, [G_NEW.name]);
  assert.deepEqual(first.rebaselined, []);

  // Re-running never re-triggers the rebaseline (no superseded rows present).
  const second = await runDesktopMigrations(db, config);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.rebaselined, []);
  assert.deepEqual(await listApplied(db), [G_NEW.name]);
});
