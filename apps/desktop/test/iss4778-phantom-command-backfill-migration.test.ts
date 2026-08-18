/**
 * @file iss4778-phantom-command-backfill-migration.test.ts
 * @description ISS-4778 (Part 2 of ISS-4775): behavioural coverage for desktop
 * migration `0045_iss4778_phantom_command_backfill`.
 *
 * Applies the committed migration chain up to (but excluding) 0044, seeds a
 * resolved `skill` + its phantom `/skill` command + a GENUINE command with no
 * skill sibling, then applies 0044 and asserts the exact effect: the phantom
 * inventory row is gone, its invocations survive re-pointed at the skill, the
 * genuine command is untouched, and only the affected sessions are marked stale
 * for the boot rebuild.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareMigrationDirNames } from "../scripts/migration-order.mjs";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("0045 deletes the phantom command, re-points its invocations to the skill, and loses none", async () => {
  const { db } = await openTestDatabase("repoint");
  try {
    await applyPredecessors(db);
    await seedFixture(db);

    const before = await readInvocationCount(db);
    await db.exec(readBackfillMigrationSql());
    assert.equal(await readInvocationCount(db), before);

    assert.deepEqual(await readComponentIdentities(db), [
      { component_key: "/deploy", component_kind: "command" },
      { component_key: "review", component_kind: "skill" },
    ]);

    assert.deepEqual(await readInvocationIdentities(db), [
      {
        component_key: "/deploy",
        component_kind: "command",
        id: "invocation-deploy",
        local_component_id: "component-command-deploy",
        normalized_name: "/deploy",
        raw_name: "/deploy staging",
      },
      {
        component_key: "review",
        component_kind: "skill",
        id: "invocation-phantom",
        local_component_id: "component-skill-review",
        normalized_name: "review",
        raw_name: "/review the diff",
      },
      {
        component_key: "review",
        component_kind: "skill",
        id: "invocation-skill",
        local_component_id: "component-skill-review",
        normalized_name: "review",
        raw_name: "Skill",
      },
    ]);
  } finally {
    await db.close();
  }
});

test("0045 marks only the phantom-bearing sessions stale for the boot rebuild", async () => {
  const { db } = await openTestDatabase("stale");
  try {
    await applyPredecessors(db);
    await seedFixture(db);
    await db.exec(readBackfillMigrationSql());

    assert.deepEqual(await readSessionRevisions(db), [
      { data_revision: SEEDED_REVISION, id: "session-genuine" },
      { data_revision: 0, id: "session-phantom" },
    ]);
  } finally {
    await db.close();
  }
});

test("0045 leaves a command alone when its same-named skill is unresolved", async () => {
  const { db } = await openTestDatabase("unresolved-sibling");
  try {
    await applyPredecessors(db);
    await seedFixture(db);
    await db.query(
      "UPDATE agent_components SET resolved_state = 'unresolved' WHERE id = $1",
      ["component-skill-review"]
    );

    await db.exec(readBackfillMigrationSql());

    assert.deepEqual(await readComponentIdentities(db), [
      { component_key: "/deploy", component_kind: "command" },
      { component_key: "/review", component_kind: "command" },
      { component_key: "review", component_kind: "skill" },
    ]);
    assert.deepEqual(await readSessionRevisions(db), [
      { data_revision: SEEDED_REVISION, id: "session-genuine" },
      { data_revision: SEEDED_REVISION, id: "session-phantom" },
    ]);
  } finally {
    await db.close();
  }
});

test("0045 is idempotent — a second application changes nothing", async () => {
  const { db } = await openTestDatabase("idempotent");
  try {
    await applyPredecessors(db);
    await seedFixture(db);

    const migrationSql = readBackfillMigrationSql();
    await db.exec(migrationSql);
    const firstComponents = await readComponentIdentities(db);
    const firstInvocations = await readInvocationIdentities(db);

    await db.exec(migrationSql);

    assert.deepEqual(await readComponentIdentities(db), firstComponents);
    assert.deepEqual(await readInvocationIdentities(db), firstInvocations);
  } finally {
    await db.close();
  }
});

type SqliteDb = Awaited<ReturnType<typeof openMigrationDatabase>>["db"];

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const BACKFILL_MIGRATION_DIR = "0045_iss4778_phantom_command_backfill";
/** Any non-zero revision; the migration must only reset the affected sessions. */
const SEEDED_REVISION = 63;
const SEED_TIMESTAMP = "2026-08-01T12:00:00.000Z";
const tempDirs: string[] = [];

async function openTestDatabase(label: string): Promise<{ db: SqliteDb }> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), `iss4778-phantom-command-${label}-`)
  );
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  return { db };
}

/** Everything that sorts strictly BEFORE 0044, so 0044's effect is isolated. */
async function applyPredecessors(db: SqliteDb): Promise<void> {
  const sql = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        compareMigrationDirNames(entry.name, BACKFILL_MIGRATION_DIR) < 0
    )
    .map((entry) => entry.name)
    .sort(compareMigrationDirNames)
    .map((dirName) =>
      readFileSync(path.join(MIGRATIONS_DIR, dirName, "migration.sql"), "utf8")
    )
    .join("\n");
  await db.exec(sql);
}

function readBackfillMigrationSql(): string {
  return readFileSync(
    path.join(MIGRATIONS_DIR, BACKFILL_MIGRATION_DIR, "migration.sql"),
    "utf8"
  );
}

/**
 * Two sessions: one that fired the slash-invoked skill `/review` (phantom) and
 * one that fired a GENUINE `/deploy` command with no skill of that name.
 */
async function seedFixture(db: SqliteDb): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, status, last_activity_at, data_revision)
     VALUES ($1, 'inactive', $3, $4), ($2, 'inactive', $3, $4)`,
    ["session-phantom", "session-genuine", SEED_TIMESTAMP, SEEDED_REVISION]
  );
  await db.query(
    `INSERT INTO agent_components (
       id, component_kind, external_id, component_key, resolved_state,
       content, first_seen_at, last_seen_at
     )
     VALUES
       ($1, 'skill', 'skill:review', 'review', 'resolved', '# Review', $4, $4),
       ($2, 'command', '/review', '/review', 'unresolved', NULL, $4, $4),
       ($3, 'command', '/deploy', '/deploy', 'unresolved', NULL, $4, $4)`,
    [
      "component-skill-review",
      "component-command-review",
      "component-command-deploy",
      SEED_TIMESTAMP,
    ]
  );
  await insertInvocation(db, {
    componentKey: "review",
    componentKind: "skill",
    id: "invocation-skill",
    localComponentId: "component-skill-review",
    normalizedName: "review",
    rawName: "Skill",
    sessionId: "session-phantom",
  });
  await insertInvocation(db, {
    componentKey: "/review",
    componentKind: "command",
    id: "invocation-phantom",
    localComponentId: "component-command-review",
    normalizedName: "/review",
    rawName: "/review the diff",
    sessionId: "session-phantom",
  });
  await insertInvocation(db, {
    componentKey: "/deploy",
    componentKind: "command",
    id: "invocation-deploy",
    localComponentId: "component-command-deploy",
    normalizedName: "/deploy",
    rawName: "/deploy staging",
    sessionId: "session-genuine",
  });
}

type SeededInvocation = {
  componentKey: string;
  componentKind: string;
  id: string;
  localComponentId: string;
  normalizedName: string;
  rawName: string;
  sessionId: string;
};

async function insertInvocation(
  db: SqliteDb,
  invocation: SeededInvocation
): Promise<void> {
  await db.query(
    `INSERT INTO agent_component_invocations (
       id, session_id, external_invocation_id, component_kind, component_key,
       raw_name, normalized_name, relationship, invoked_at, sequence,
       anchor_kind, anchor_value, attribution_status, evidence_class,
       local_component_id, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'direct', $9, 0, 'userTurn', $3,
       'matched', 'transcriptSnapshot', $8, $9, $9
     )`,
    [
      invocation.id,
      invocation.sessionId,
      `external-${invocation.id}`,
      invocation.componentKind,
      invocation.componentKey,
      invocation.rawName,
      invocation.normalizedName,
      invocation.localComponentId,
      SEED_TIMESTAMP,
    ]
  );
}

async function readInvocationCount(db: SqliteDb): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM agent_component_invocations"
  );
  return Number(result.rows[0]?.count);
}

async function readComponentIdentities(
  db: SqliteDb
): Promise<{ component_key: string; component_kind: string }[]> {
  const result = await db.query<{
    component_key: string;
    component_kind: string;
  }>(
    `SELECT component_kind, component_key
       FROM agent_components
      ORDER BY component_kind, component_key`
  );
  return result.rows;
}

async function readInvocationIdentities(db: SqliteDb): Promise<
  {
    component_key: string;
    component_kind: string;
    id: string;
    local_component_id: string | null;
    normalized_name: string | null;
    raw_name: string | null;
  }[]
> {
  const result = await db.query<{
    component_key: string;
    component_kind: string;
    id: string;
    local_component_id: string | null;
    normalized_name: string | null;
    raw_name: string | null;
  }>(
    `SELECT id, component_kind, component_key, raw_name, normalized_name,
            local_component_id
       FROM agent_component_invocations
      ORDER BY id`
  );
  return result.rows;
}

async function readSessionRevisions(
  db: SqliteDb
): Promise<{ data_revision: number; id: string }[]> {
  const result = await db.query<{ data_revision: number; id: string }>(
    "SELECT id, data_revision FROM sessions ORDER BY id"
  );
  return result.rows.map((row) => ({
    data_revision: Number(row.data_revision),
    id: row.id,
  }));
}
