/**
 * @file prisma-baseline-equivalence.test.ts
 * @description Proves the FROZEN baseline schema (baseline-schema.ts) creates a
 * database structurally identical to running the BASELINE_MIGRATIONS chain, and
 * that re-asserting the baseline DDL on an already-baselined database is a no-op.
 * Together these are the soundness condition for baselining: the runner
 * re-asserts the frozen DDL once, then records BASELINE_MIGRATIONS as applied
 * without executing them.
 *
 * Scope is the baseline set only — post-cutover migrations apply normally and
 * are covered by prisma-migrations-agreement.test.ts (migrations ↔ schema.prisma).
 *
 * If the first test fails after editing the baseline schema or a baseline
 * migration: the frozen snapshot and the migrations it represents have diverged.
 * The baseline schema is frozen — do not edit it; post-cutover changes are new
 * migrations (see baseline-schema.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/baseline-schema.js";
import {
  openMigrationDatabase,
  type SqliteClient,
} from "../src/main/database/migration-executor.js";
import { snapshotSchema } from "./helpers/schema-snapshot.js";

const MIGRATIONS_DIR = path.join(
  import.meta.dirname,
  "..",
  "prisma",
  "migrations"
);

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function openDb(): Promise<SqliteClient> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-equiv-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "d.sqlite"));
  return db;
}

/** Concatenate exactly the migrations the baseline snapshot represents, in order. */
function readBaselineMigrationsSql(): string {
  return BASELINE_MIGRATIONS.map((name) =>
    readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8")
  ).join("\n");
}

/** Apply the runner's baseline re-assert sequence to a database. */
async function applyBaselineSchema(db: SqliteClient): Promise<void> {
  for (const statement of LEGACY_SCHEMA_REASSERT_SEQUENCE) {
    await db.exec(statement);
  }
}

test("frozen baseline schema is structurally identical to the baseline migration chain", async () => {
  // Post SQLite migration: baselining is inert — every store reconciles via the
  // idempotent `0001_init` migration, so BASELINE_MIGRATIONS and the re-assert
  // sequence are empty. Both databases therefore stay empty and remain
  // structurally equal, which is the invariant this guard protects: the frozen
  // baseline and the migrations it represents never diverge.
  const legacyDb = await openDb();
  const migratedDb = await openDb();
  try {
    await applyBaselineSchema(legacyDb);
    await migratedDb.exec(readBaselineMigrationsSql() || "SELECT 1;");

    const legacy = await snapshotSchema(legacyDb);
    const migrated = await snapshotSchema(migratedDb);

    assert.deepEqual(migrated.tables, legacy.tables);
    assert.deepEqual(migrated.columns, legacy.columns);
    assert.deepEqual(migrated.indexes, legacy.indexes);
    assert.deepEqual(migrated.foreignKeys, legacy.foreignKeys);
  } finally {
    await legacyDb.close();
    await migratedDb.close();
  }
});

test("re-asserting the frozen baseline on a baselined database is a no-op", async () => {
  // The baseline re-assert must be a no-op on a database already at the baseline
  // shape. With an empty SQLite re-assert sequence this is trivially true, but
  // the assertion still guards against a future repopulated sequence drifting.
  const db = await openDb();
  try {
    await db.exec(readBaselineMigrationsSql() || "SELECT 1;");
    const before = await snapshotSchema(db);
    await applyBaselineSchema(db);
    const after = await snapshotSchema(db);
    assert.deepEqual(after, before);
  } finally {
    await db.close();
  }
});
