/**
 * @file fea1899-artifacts-model.test.ts
 * @description FEA-1899 Desktop KLOC Attribution Engine — Module A (schema spine)
 * + Module B (Layer 1 fixes).
 *
 * Post SQLite migration: the 14 incremental Postgres migrations collapsed into a
 * single `0001_init`, so the AC-3/AC-4 *runtime backfill* that lifted an
 * existing denormalized Postgres install into the canonical `artifacts` model no
 * longer exists — every SQLite install is created fresh with the artifacts model
 * already in place (no pre-existing rows to backfill). Those backfill/idempotency
 * tests are therefore obsolete and removed. What remains and is still meaningful:
 *  - Module A schema spine: the canonical artifacts model + the dual-store
 *    pull_requests table are created by the migration with the expected keys.
 *  - AC-5: computeLineDelta no longer collapses duplicate identical lines.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeLineDelta } from "../src/main/collectors/parser-utils.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

test("FEA-1899 Module A: fresh install creates the canonical artifacts model and dual-store pull_requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1899-schema-"));
  const dataDir = path.join(dir, "agent-dashboard.sqlite");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-17T00:00:00.000Z",
    });
    try {
      // The artifacts table exists and starts empty (no backfill on a fresh
      // SQLite install — the prior Postgres lift-and-backfill path is gone).
      const artifacts = await db.prisma.client.$queryRawUnsafe<{ c: number }[]>(
        "SELECT COUNT(*) AS c FROM artifacts"
      );
      assert.equal(Number(artifacts[0].c), 0);

      // identity_key carries the canonical-dedup UNIQUE index.
      const uniqueIndex = await db.prisma.client.$queryRawUnsafe<
        { name: string }[]
      >(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'artifacts_identity_key_key'`
      );
      assert.equal(uniqueIndex.length, 1, "identity_key UNIQUE index present");

      await db.run(
        "INSERT INTO artifacts (id, identity_key, kind, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4)",
        "a1",
        "cldoc:FEA-1",
        "closedloop_artifact",
        "2026-06-17T00:00:00.000Z"
      );
      await assert.rejects(
        () =>
          db.run(
            "INSERT INTO artifacts (id, identity_key, kind, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4)",
            "a2",
            "cldoc:FEA-1",
            "closedloop_artifact",
            "2026-06-17T00:00:00.000Z"
          ),
        "duplicate identity_key rejected"
      );

      // Dual-store model (revised AC-10): pull_requests stays alive as a
      // lifecycle detail store alongside the canonical artifacts table.
      const prTable = await db.prisma.client.$queryRawUnsafe<
        { name: string }[]
      >(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_requests'"
      );
      assert.equal(prTable.length, 1, "pull_requests table still exists");

      // session_artifact_links is the pure join table (artifact_id FK, no
      // denormalized slug column).
      const linkColumns = await db.prisma.client.$queryRawUnsafe<
        { name: string }[]
      >("SELECT name FROM pragma_table_info('session_artifact_links')");
      const linkColumnNames = linkColumns.map((row) => row.name);
      assert.ok(
        linkColumnNames.includes("artifact_id"),
        "links carry artifact_id"
      );
      assert.equal(
        linkColumnNames.includes("slug"),
        false,
        "denormalized slug column is absent from the join table"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1899 AC-5: computeLineDelta counts duplicate lines (no Set collapse)", () => {
  // Old Set-based logic returned add=0 here because "b" was already present.
  assert.deepEqual(computeLineDelta("a\nb", "a\nb\nb\nb"), { add: 2, del: 0 });
  // Pure content change of one line.
  assert.deepEqual(computeLineDelta("foo", "bar"), { add: 1, del: 1 });
  // Removing duplicated lines is counted per-occurrence.
  assert.deepEqual(computeLineDelta("x\nx\nx", "x"), { add: 0, del: 2 });
  // Empty/blank handling.
  assert.deepEqual(computeLineDelta(null, "a\nb"), { add: 2, del: 0 });
  assert.deepEqual(computeLineDelta("a\nb", null), { add: 0, del: 2 });
});
