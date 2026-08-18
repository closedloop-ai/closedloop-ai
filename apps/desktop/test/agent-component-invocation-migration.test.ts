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

test("0034 upgrade creates the exact invocation schema, indexes, and FK actions", async () => {
  const { db } = await openTestDatabase("schema");
  try {
    await db.exec(readPredecessorMigrationSql());
    await db.exec(readInvocationMigrationSql());

    const tables = await db.query<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'agent_component_invocations',
           'agent_component_invocation_sync_outbox'
         )
       ORDER BY name`
    );
    assert.deepEqual(
      tables.rows.map((row) => row.name),
      ["agent_component_invocation_sync_outbox", "agent_component_invocations"]
    );

    const invocationColumns = await readColumnNames(
      db,
      "agent_component_invocations"
    );
    assert.deepEqual(invocationColumns, EXPECTED_INVOCATION_COLUMNS);
    assert.equal(invocationColumns.includes("definition_version_id"), false);
    assert.equal(invocationColumns.includes("source_occurrence_id"), false);

    const outboxColumns = await readColumnNames(
      db,
      "agent_component_invocation_sync_outbox"
    );
    assert.deepEqual(outboxColumns, EXPECTED_OUTBOX_COLUMNS);

    const indexes = await db.query<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'index'
         AND name NOT LIKE 'sqlite_autoindex_%'
         AND (
           tbl_name = 'agent_component_invocations'
           OR tbl_name = 'agent_component_invocation_sync_outbox'
         )
       ORDER BY name`
    );
    assert.deepEqual(
      indexes.rows.map((row) => row.name),
      EXPECTED_INDEX_NAMES
    );

    const foreignKeys = await readForeignKeys(
      db,
      "agent_component_invocations"
    );
    assert.deepEqual(foreignKeys, EXPECTED_FOREIGN_KEYS);

    const outboxForeignKeys = await readForeignKeys(
      db,
      "agent_component_invocation_sync_outbox"
    );
    assert.deepEqual(outboxForeignKeys, []);
  } finally {
    await db.close();
  }
});

test("0034 preserves invocation evidence while optional links disappear and sessions cascade", async () => {
  const { db } = await openTestDatabase("delete-actions");
  try {
    await db.exec(readPredecessorMigrationSql());
    await seedRelationOwners(db);
    await db.exec(readInvocationMigrationSql());
    await insertInvocation(db);
    await insertOutboxPart(db, {
      externalGenerationId: "generation-1",
      partHash: "hash-1",
      partIndex: 0,
    });

    await db.query("DELETE FROM agents WHERE id IN ($1, $2)", [
      "agent-child",
      "agent-parent",
    ]);
    await db.query("DELETE FROM agent_components WHERE id = $1", [
      "component-1",
    ]);
    await db.query("DELETE FROM agent_component_versions WHERE id = $1", [
      "component-version-1",
    ]);

    const relinked = await db.query<{
      agent_id: string | null;
      definition_hash: string | null;
      definition_content: string | null;
      local_component_id: string | null;
      local_component_version_id: string | null;
      parent_agent_id: string | null;
    }>(
      `SELECT agent_id, parent_agent_id, local_component_id,
              local_component_version_id, definition_hash, definition_content
       FROM agent_component_invocations
       WHERE id = $1`,
      ["invocation-1"]
    );
    assert.deepEqual(relinked.rows, [
      {
        agent_id: null,
        definition_hash: "definition-hash-1",
        definition_content: "# Frozen definition",
        local_component_id: null,
        local_component_version_id: null,
        parent_agent_id: null,
      },
    ]);

    await db.query("DELETE FROM sessions WHERE id = $1", ["session-1"]);
    const invocationCount = await db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_component_invocations"
    );
    assert.equal(Number(invocationCount.rows[0]?.count), 0);

    const outboxCount = await db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_component_invocation_sync_outbox"
    );
    assert.equal(Number(outboxCount.rows[0]?.count), 1);
  } finally {
    await db.close();
  }
});

test("0034 outbox retains exact parts and resumes retry state after restart", async () => {
  const databasePath = await createDatabasePath("outbox-restart");
  const first = await openMigrationDatabase(databasePath);
  try {
    await first.db.exec(readPredecessorMigrationSql());
    const migrationSql = readInvocationMigrationSql();
    await first.db.exec(migrationSql);
    await first.db.exec(migrationSql);

    await insertOutboxPart(first.db, {
      externalGenerationId: "generation-1",
      partHash: "hash-g1-p0",
      partIndex: 0,
    });
    await insertOutboxPart(first.db, {
      externalGenerationId: "generation-1",
      partHash: "hash-g1-p1",
      partIndex: 1,
    });
    await insertOutboxPart(first.db, {
      externalGenerationId: "generation-2",
      partHash: "hash-g2-p0",
      partIndex: 0,
    });

    await assert.rejects(
      insertOutboxPart(first.db, {
        externalGenerationId: "generation-1",
        partHash: "conflicting-hash",
        partIndex: 0,
      })
    );

    await first.db.query(
      `UPDATE agent_component_invocation_sync_outbox
       SET attempt_count = 3,
           next_attempt_at = $1,
           last_error = $2,
           updated_at = $3
       WHERE source_key = $4
         AND external_session_id = $5
         AND external_generation_id = $6
         AND part_index = $7`,
      [
        "2026-07-22T18:05:00.000Z",
        "capability_unavailable",
        "2026-07-22T18:00:00.000Z",
        "target:compute-1",
        "session-1",
        "generation-1",
        1,
      ]
    );
  } finally {
    await first.db.close();
  }

  const reopened = await openMigrationDatabase(databasePath);
  try {
    const rows = await reopened.db.query<{
      attempt_count: number;
      external_generation_id: string;
      last_error: string | null;
      part_hash: string;
      part_index: number;
    }>(
      `SELECT external_generation_id, part_index, part_hash,
              attempt_count, last_error
       FROM agent_component_invocation_sync_outbox
       ORDER BY external_generation_id, part_index`
    );
    assert.deepEqual(rows.rows, [
      {
        attempt_count: 0,
        external_generation_id: "generation-1",
        last_error: null,
        part_hash: "hash-g1-p0",
        part_index: 0,
      },
      {
        attempt_count: 3,
        external_generation_id: "generation-1",
        last_error: "capability_unavailable",
        part_hash: "hash-g1-p1",
        part_index: 1,
      },
      {
        attempt_count: 0,
        external_generation_id: "generation-2",
        last_error: null,
        part_hash: "hash-g2-p0",
        part_index: 0,
      },
    ]);

    await reopened.db.query(
      `DELETE FROM agent_component_invocation_sync_outbox
       WHERE source_key = $1
         AND external_session_id = $2
         AND external_generation_id = $3
         AND part_index = $4
         AND part_hash = $5`,
      ["target:compute-1", "session-1", "generation-1", 0, "hash-g1-p0"]
    );
    const surviving = await reopened.db.query<{
      external_generation_id: string;
      part_index: number;
    }>(
      `SELECT external_generation_id, part_index
       FROM agent_component_invocation_sync_outbox
       ORDER BY external_generation_id, part_index`
    );
    assert.deepEqual(surviving.rows, [
      { external_generation_id: "generation-1", part_index: 1 },
      { external_generation_id: "generation-2", part_index: 0 },
    ]);
  } finally {
    await reopened.db.close();
  }
});

test("0034 pins the SQLite constraint names and actions", () => {
  const sql = readInvocationMigrationSql();
  const invocationTable = extractCreateTable(
    sql,
    "agent_component_invocations"
  );
  assert.match(invocationTable, SESSION_FK_RE);
  assert.match(invocationTable, AGENT_FK_RE);
  assert.match(invocationTable, PARENT_AGENT_FK_RE);
  assert.match(invocationTable, COMPONENT_FK_RE);
  assert.match(invocationTable, COMPONENT_VERSION_FK_RE);

  const outboxTable = extractCreateTable(
    sql,
    "agent_component_invocation_sync_outbox"
  );
  assert.match(outboxTable, OUTBOX_PK_RE);
  assert.doesNotMatch(outboxTable, OUTBOX_FK_RE);
});

type SqliteDb = Awaited<ReturnType<typeof openMigrationDatabase>>["db"];

type OutboxPart = {
  externalGenerationId: string;
  partHash: string;
  partIndex: number;
};

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const INVOCATION_MIGRATION_DIR = "0034_agent_component_invocations";
const tempDirs: string[] = [];

const EXPECTED_INVOCATION_COLUMNS = [
  "agent_id",
  "anchor_kind",
  "anchor_value",
  "attribution_status",
  "child_session_id",
  "component_key",
  "component_kind",
  "created_at",
  "definition_content",
  "definition_hash",
  "evidence_class",
  "evidence_pointer",
  "external_invocation_id",
  "external_source_id",
  "git_branch",
  "id",
  "invoked_at",
  "local_component_id",
  "local_component_version_id",
  "normalized_name",
  "normalizer_contract_version",
  "parent_agent_id",
  "provider_tool_use_id",
  "raw_name",
  "relationship",
  "repository_full_name",
  "sequence",
  "session_id",
  "updated_at",
];

const EXPECTED_OUTBOX_COLUMNS = [
  "attempt_count",
  "created_at",
  "data_revision",
  "external_generation_id",
  "external_session_id",
  "last_error",
  "next_attempt_at",
  "part_count",
  "part_hash",
  "part_index",
  "payload",
  "source_key",
  "source_sequence",
  "source_updated_at",
  "status",
  "updated_at",
];

const EXPECTED_INDEX_NAMES = [
  "idx_aci_component_branch_invoked_at",
  "idx_aci_component_invoked_at",
  "idx_aci_component_version_invoked_at",
  "idx_aci_external_source",
  "idx_aci_kind_key_invoked_at",
  "idx_aci_session_external_invocation",
  "idx_aci_session_sequence",
  "idx_aci_status_invoked_at",
  "idx_agent_component_invocation_sync_outbox_ready",
];

const EXPECTED_FOREIGN_KEYS = [
  {
    column: "agent_id",
    onDelete: "SET NULL",
    onUpdate: "NO ACTION",
    referencedColumn: "id",
    referencedTable: "agents",
  },
  {
    column: "local_component_id",
    onDelete: "SET NULL",
    onUpdate: "NO ACTION",
    referencedColumn: "id",
    referencedTable: "agent_components",
  },
  {
    column: "local_component_version_id",
    onDelete: "SET NULL",
    onUpdate: "NO ACTION",
    referencedColumn: "id",
    referencedTable: "agent_component_versions",
  },
  {
    column: "parent_agent_id",
    onDelete: "SET NULL",
    onUpdate: "NO ACTION",
    referencedColumn: "id",
    referencedTable: "agents",
  },
  {
    column: "session_id",
    onDelete: "CASCADE",
    onUpdate: "NO ACTION",
    referencedColumn: "id",
    referencedTable: "sessions",
  },
];

const SESSION_FK_RE =
  /CONSTRAINT "agent_component_invocations_session_id_fkey"\s+FOREIGN KEY \("session_id"\) REFERENCES "sessions" \("id"\)\s+ON DELETE CASCADE ON UPDATE NO ACTION/;
const AGENT_FK_RE =
  /CONSTRAINT "agent_component_invocations_agent_id_fkey"\s+FOREIGN KEY \("agent_id"\) REFERENCES "agents" \("id"\)\s+ON DELETE SET NULL ON UPDATE NO ACTION/;
const PARENT_AGENT_FK_RE =
  /CONSTRAINT "agent_component_invocations_parent_agent_id_fkey"\s+FOREIGN KEY \("parent_agent_id"\) REFERENCES "agents" \("id"\)\s+ON DELETE SET NULL ON UPDATE NO ACTION/;
const COMPONENT_FK_RE =
  /CONSTRAINT "agent_component_invocations_local_component_id_fkey"\s+FOREIGN KEY \("local_component_id"\) REFERENCES "agent_components" \("id"\)\s+ON DELETE SET NULL ON UPDATE NO ACTION/;
const COMPONENT_VERSION_FK_RE =
  /CONSTRAINT "agent_component_invocations_local_component_version_id_fkey"\s+FOREIGN KEY \("local_component_version_id"\) REFERENCES "agent_component_versions" \("id"\)\s+ON DELETE SET NULL ON UPDATE NO ACTION/;
const OUTBOX_PK_RE =
  /CONSTRAINT "agent_component_invocation_sync_outbox_pkey"\s+PRIMARY KEY \("source_key", "external_session_id", "external_generation_id", "part_index"\)/;
const OUTBOX_FK_RE = /FOREIGN KEY/;

async function openTestDatabase(label: string): Promise<{
  db: SqliteDb;
  databasePath: string;
}> {
  const databasePath = await createDatabasePath(label);
  const { db } = await openMigrationDatabase(databasePath);
  return { db, databasePath };
}

async function createDatabasePath(label: string): Promise<string> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), `agent-component-invocation-${label}-`)
  );
  tempDirs.push(dir);
  return path.join(dir, "agent-dashboard.sqlite");
}

function readPredecessorMigrationSql(): string {
  // Everything that sorts strictly BEFORE 0034 — this test applies that chain
  // then 0034 in isolation to assert 0034's exact effect. Later migrations
  // (e.g. 0035, which ALTERs agent_component_invocations) must be excluded, not
  // just 0034 itself: 0035 depends on the table 0034 creates.
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        compareMigrationDirNames(entry.name, INVOCATION_MIGRATION_DIR) < 0
    )
    .map((entry) => entry.name)
    .sort(compareMigrationDirNames)
    .map((dirName) =>
      readFileSync(path.join(MIGRATIONS_DIR, dirName, "migration.sql"), "utf8")
    )
    .join("\n");
}

function readInvocationMigrationSql(): string {
  return readFileSync(
    path.join(MIGRATIONS_DIR, INVOCATION_MIGRATION_DIR, "migration.sql"),
    "utf8"
  );
}

async function readColumnNames(
  db: SqliteDb,
  tableName: string
): Promise<string[]> {
  const columns = await db.query<{ name: string }>(
    "SELECT name FROM pragma_table_info($1) ORDER BY name",
    [tableName]
  );
  return columns.rows.map((row) => row.name);
}

async function readForeignKeys(
  db: SqliteDb,
  tableName: string
): Promise<typeof EXPECTED_FOREIGN_KEYS> {
  const foreignKeys = await db.query<{
    from: string;
    on_delete: string;
    on_update: string;
    table: string;
    to: string;
  }>(
    `SELECT "from", "table", "to", on_delete, on_update
     FROM pragma_foreign_key_list($1)`,
    [tableName]
  );
  return foreignKeys.rows
    .map((row) => ({
      column: row.from,
      onDelete: row.on_delete,
      onUpdate: row.on_update,
      referencedColumn: row.to,
      referencedTable: row.table,
    }))
    .sort((left, right) => left.column.localeCompare(right.column));
}

async function seedRelationOwners(db: SqliteDb): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, status, last_activity_at)
     VALUES ($1, 'completed', $2)`,
    ["session-1", "2026-07-22T17:00:00.000Z"]
  );
  await db.query(
    `INSERT INTO agents (id, session_id, status)
     VALUES ($1, $3, 'completed'), ($2, $3, 'completed')`,
    ["agent-child", "agent-parent", "session-1"]
  );
  await db.query(
    `INSERT INTO agent_components (
       id, component_kind, external_id, component_key, name
     )
     VALUES ($1, 'skill', $2, 'review', 'Review')`,
    ["component-1", "skill:review"]
  );
  await db.query(
    `INSERT INTO agent_component_versions (
       id, component_kind, component_key, source, content_hash, content
     )
     VALUES ($1, 'skill', 'review', '', $2, '# Frozen definition')`,
    ["component-version-1", "definition-hash-1"]
  );
}

async function insertInvocation(db: SqliteDb): Promise<void> {
  await db.query(
    `INSERT INTO agent_component_invocations (
       id, session_id, external_invocation_id, external_source_id,
       agent_id, parent_agent_id, component_kind, component_key,
       relationship, invoked_at, sequence, anchor_kind, anchor_value,
       attribution_status, evidence_class, evidence_pointer,
       definition_hash, normalizer_contract_version, definition_content,
       local_component_id, local_component_version_id, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, 'skill', 'review', 'childSession', $7,
       0, 'event', $8, 'matched', 'transcriptSnapshot', $9, $10, $11,
       '# Frozen definition', $12, $13, $7, $7
     )`,
    [
      "invocation-1",
      "session-1",
      "external-invocation-1",
      "source-session-1",
      "agent-child",
      "agent-parent",
      "2026-07-22T17:01:00.000Z",
      JSON.stringify({ eventId: "event-1" }),
      JSON.stringify({ sourcePath: "skills/review/SKILL.md" }),
      "definition-hash-1",
      "definition-fingerprint-v1",
      "component-1",
      "component-version-1",
    ]
  );
}

async function insertOutboxPart(db: SqliteDb, part: OutboxPart): Promise<void> {
  await db.query(
    `INSERT INTO agent_component_invocation_sync_outbox (
       source_key, external_session_id, external_generation_id,
       part_index, part_count, part_hash, source_updated_at, data_revision,
       source_sequence, payload, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, 2, $5, $6, 35, 7, $7, $6, $6)`,
    [
      "target:compute-1",
      "session-1",
      part.externalGenerationId,
      part.partIndex,
      part.partHash,
      "2026-07-22T18:00:00.000Z",
      JSON.stringify({
        externalGenerationId: part.externalGenerationId,
        partHash: part.partHash,
        partIndex: part.partIndex,
      }),
    ]
  );
}

function extractCreateTable(sql: string, tableName: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS "${tableName}"`);
  if (start === -1) {
    throw new Error(`missing CREATE TABLE for ${tableName}`);
  }
  const end = sql.indexOf(";", start);
  if (end === -1) {
    throw new Error(`unterminated CREATE TABLE for ${tableName}`);
  }
  return sql.slice(start, end + 1);
}
