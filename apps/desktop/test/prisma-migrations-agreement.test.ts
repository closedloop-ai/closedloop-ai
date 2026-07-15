/**
 * @file prisma-migrations-agreement.test.ts
 * @description CI guard: asserts the committed migration history and
 * prisma/schema.prisma agree — the desktop equivalent of
 * `prisma migrate diff --from-migrations --to-schema --exit-code`, using an
 * on-disk libSQL database as the shadow so no external server is needed (the
 * desktop CI job has none).
 *
 * Post SQLite migration: the 14 Postgres incremental migrations collapsed into
 * a single SQLite `0001_init`, and the Postgres-only CHECK constraints / casts
 * are gone. The guard now compares the SQLite schema produced by the committed
 * migration chain against the one Prisma would emit from schema.prisma.
 *
 * Fails when someone edits schema.prisma without regenerating the migration, or
 * hand-edits the migration in a way that diverges from the datamodel.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp as mkdtempAsync, rm as rmAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  compareMigrationDirNames,
  legacyMigrationSortKeys,
  migrationSortKey,
} from "../scripts/migration-order.mjs";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";
import { ModelPricingSource } from "../src/main/model-pricing/model-pricing-fixture.js";
import {
  snapshotSchema,
  withoutPslInexpressibleArtifacts,
} from "./helpers/schema-snapshot.js";

const execFileAsync = promisify(execFile);
const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const PRISMA_BIN = path.join(APP_DIR, "node_modules", ".bin", "prisma");
const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rmAsync(dir, { recursive: true, force: true }))
  );
});

type SqliteDb = Awaited<ReturnType<typeof openMigrationDatabase>>["db"];

async function openShadowDb(): Promise<SqliteDb> {
  const dir = await mkdtempAsync(path.join(os.tmpdir(), "migrations-agree-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "shadow.sqlite"));
  return db;
}

function readMigrationDirNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareMigrationDirNames);
}

function readMigrationChainSql(): string {
  const migrationDirs = readMigrationDirNames();
  if (migrationDirs.length === 0) {
    throw new Error("No migrations found");
  }
  return migrationDirs
    .map((dir) =>
      readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")
    )
    .join("\n");
}

async function generateSchemaSql(): Promise<string> {
  const { stdout } = await execFileAsync(
    PRISMA_BIN,
    [
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema",
      "prisma/schema.prisma",
      "--script",
    ],
    {
      cwd: APP_DIR,
      maxBuffer: 16 * 1024 * 1024,
      // No telemetry/update probe from CI runners or sandboxes.
      env: { ...process.env, CHECKPOINT_DISABLE: "1" },
    }
  );
  return stdout;
}

test("committed migration history agrees with prisma/schema.prisma", async () => {
  const schemaSql = await generateSchemaSql();
  const fromSchema = await openShadowDb();
  const fromMigrations = await openShadowDb();
  try {
    await fromSchema.exec(schemaSql);
    await fromMigrations.exec(readMigrationChainSql());

    const schemaSnapshot = withoutPslInexpressibleArtifacts(
      await snapshotSchema(fromSchema)
    );
    const migrationsSnapshot = withoutPslInexpressibleArtifacts(
      await snapshotSchema(fromMigrations)
    );

    assert.deepEqual(
      migrationsSnapshot,
      schemaSnapshot,
      "prisma/migrations and prisma/schema.prisma have diverged. " +
        "If you changed schema.prisma, regenerate the migration (see " +
        "apps/desktop/prisma/schema.prisma header)."
    );
  } finally {
    await fromSchema.close();
    await fromMigrations.close();
  }
});

test("committed migration history stores canonical pricing source", async () => {
  const db = await openShadowDb();
  try {
    await db.exec(readMigrationChainSql());
    await db.query(
      `INSERT INTO sessions (
         id, name, status, started_at, updated_at, harness, cost_usd_estimated,
         cost_currency, cost_source
       )
       VALUES ($1, 'GenAI pricing session', 'completed', $2, $2, 'codex', 1.5, 'USD', $3)`,
      [
        "session-genai-prices",
        "2026-06-07T10:00:00.000Z",
        ModelPricingSource.GenaiPricesV1,
      ]
    );
    await db.query(
      `INSERT INTO token_usage (
         session_id, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd_estimated, cost_currency, cost_source
       )
       VALUES ($1, 'gpt-5-codex', 10, 2, 3, 1, 1.5, 'USD', $2)`,
      ["session-genai-prices", ModelPricingSource.GenaiPricesV1]
    );
    await db.query(
      `INSERT INTO token_events (
         session_id, model, created_at, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd_estimated,
         input_cost_usd_estimated, output_cost_usd_estimated,
         cache_read_cost_usd_estimated, cost_currency, cost_source
       )
       VALUES ($1, 'gpt-5-codex', $2, 10, 2, 3, 1, 1.5, 1.0, 0.3, 0.2, 'USD', $3)`,
      [
        "session-genai-prices",
        "2026-06-07T10:00:30.000Z",
        ModelPricingSource.GenaiPricesV1,
      ]
    );
    const sources = await db.query<{
      session_source: string | null;
      usage_source: string | null;
      event_source: string | null;
    }>(
      `SELECT
         s.cost_source AS session_source,
         tu.cost_source AS usage_source,
         te.cost_source AS event_source
       FROM sessions s
       JOIN token_usage tu ON tu.session_id = s.id
       JOIN token_events te ON te.session_id = s.id
       WHERE s.id = $1`,
      ["session-genai-prices"]
    );
    assert.deepEqual(sources.rows, [
      {
        session_source: ModelPricingSource.GenaiPricesV1,
        usage_source: ModelPricingSource.GenaiPricesV1,
        event_source: ModelPricingSource.GenaiPricesV1,
      },
    ]);
  } finally {
    await db.close();
  }
});

const MIGRATION_DIR_RE = /^(\d{4})_[a-z0-9][a-z0-9_]*$/;
const USER_PROMPT_INDEX_COLUMNS_RE = /"created_at" DESC, "session_id"/;
const USER_PROMPT_INDEX_WHERE_RE = /WHERE event_type = 'UserPromptSubmit'/;
const ARTIFACTS_BRANCH_TABLE_RE = /"artifacts"/;
const BRANCH_INDEX_COLUMNS_RE = /"repo_full_name", "branch_name"/;
const ARTIFACTS_BRANCH_WHERE_RE = /WHERE kind = 'branch'/;
const PULL_REQUESTS_BRANCH_TABLE_RE = /"pull_requests"/;

test("committed migration directories use canonical names with only known legacy exceptions", () => {
  const dirNames = readMigrationDirNames();
  let previousSortKey = "";
  let numericIndex = 0;
  for (const dirName of dirNames) {
    const sortKey = migrationSortKey(dirName);
    assert.ok(
      sortKey > previousSortKey,
      `Migration directory ${dirName} must sort after ${previousSortKey}`
    );
    previousSortKey = sortKey;

    if (legacyMigrationSortKeys.has(dirName)) {
      continue;
    }

    numericIndex += 1;
    const expectedPrefix = String(numericIndex).padStart(4, "0");
    const match = MIGRATION_DIR_RE.exec(dirName);
    assert.ok(
      match,
      `Migration directory ${dirName} must use 000N_snake_case format`
    );
    assert.equal(
      match[1],
      expectedPrefix,
      `Migration directory ${dirName} must use prefix ${expectedPrefix}`
    );
  }
});

test("committed migration history uses a UserPromptSubmit partial index, not a broad event_type index", async () => {
  const db = await openShadowDb();
  try {
    await db.exec(readMigrationChainSql());
    const snapshot = await snapshotSchema(db);
    const indexDefinitionsByName = new Map(
      snapshot.indexes.map((row) => [
        String(row.indexname),
        String(row.indexdef),
      ])
    );
    const userPromptIndexDef = indexDefinitionsByName.get(
      "idx_events_user_prompt_created_session"
    );

    assert.equal(indexDefinitionsByName.has("idx_events_type"), false);
    assert.equal(indexDefinitionsByName.has("idx_events_session_id"), true);
    assert.ok(userPromptIndexDef);
    assert.match(userPromptIndexDef, USER_PROMPT_INDEX_COLUMNS_RE);
    assert.match(userPromptIndexDef, USER_PROMPT_INDEX_WHERE_RE);
  } finally {
    await db.close();
  }
});

test("committed migration history indexes branch_name for the propagateBranchPrLinks join", async () => {
  // perf/0003: propagateBranchPrLinks joins artifacts(kind='branch') ->
  // pull_requests on (repo_full_name, branch_name) on every import. These two
  // indexes must exist in the applied schema to serve that join's predicates.
  const db = await openShadowDb();
  try {
    await db.exec(readMigrationChainSql());
    const snapshot = await snapshotSchema(db);
    const indexDefinitionsByName = new Map(
      snapshot.indexes.map((row) => [
        String(row.indexname),
        String(row.indexdef),
      ])
    );

    const artifactsBranchDef = indexDefinitionsByName.get(
      "idx_artifacts_branch"
    );
    assert.ok(
      artifactsBranchDef,
      "idx_artifacts_branch must exist (artifacts branch-side of the join)"
    );
    assert.match(artifactsBranchDef, ARTIFACTS_BRANCH_TABLE_RE);
    assert.match(artifactsBranchDef, BRANCH_INDEX_COLUMNS_RE);
    assert.match(artifactsBranchDef, ARTIFACTS_BRANCH_WHERE_RE);

    const pullRequestsBranchDef = indexDefinitionsByName.get(
      "idx_pull_requests_branch"
    );
    assert.ok(
      pullRequestsBranchDef,
      "idx_pull_requests_branch must exist (pull_requests side of the join)"
    );
    assert.match(pullRequestsBranchDef, PULL_REQUESTS_BRANCH_TABLE_RE);
    assert.match(pullRequestsBranchDef, BRANCH_INDEX_COLUMNS_RE);
  } finally {
    await db.close();
  }
});

test("large token metric columns store large counters on a clean install", async () => {
  const db = await openShadowDb();
  try {
    await db.exec(readMigrationChainSql());
    await assertTokenMetricColumnsAreBigint(db);
    await insertTokenMetricRows(db, "clean-large", LARGE_CACHE_READ_TOKENS);

    assert.deepEqual(await readTokenMetricCacheReadValues(db, "clean-large"), {
      tokenUsage: LARGE_CACHE_READ_TOKENS,
      tokenEvents: LARGE_CACHE_READ_TOKENS,
      claudeCodeApiRequest: LARGE_CACHE_READ_TOKENS,
    });
  } finally {
    await db.close();
  }
});

async function assertTokenMetricColumnsAreBigint(db: SqliteDb): Promise<void> {
  const requiredColumns = new Map([
    ["token_usage.cache_read_tokens", ["token_usage", "cache_read_tokens"]],
    ["token_usage.raw_cache_read", ["token_usage", "raw_cache_read"]],
    ["token_usage.baseline_cache_read", ["token_usage", "baseline_cache_read"]],
    ["token_events.cache_read_tokens", ["token_events", "cache_read_tokens"]],
    [
      "claude_code_api_request.tokens_cache_read",
      ["claude_code_api_request", "tokens_cache_read"],
    ],
  ] as const);

  for (const [label, [tableName, columnName]] of requiredColumns) {
    const result = await db.query<{ type: string }>(
      "SELECT type FROM pragma_table_info($1) WHERE name = $2",
      [tableName, columnName]
    );
    // SQLite stores INTEGER affinity as a 64-bit signed value regardless of the
    // declared type; the migration declares these BIGINT to document the intent.
    if (result.rows[0]?.type !== "BIGINT") {
      throw new Error(`Expected ${label} to be declared BIGINT`);
    }
  }
}

async function insertTokenMetricRows(
  db: SqliteDb,
  idSuffix: string,
  cacheReadTokens: number
): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
     VALUES ($1, $2, 'completed', '2026-06-07T10:00:00.000Z', '2026-06-07T10:01:00.000Z', 'claude')`,
    [`session-${idSuffix}`, `Session ${idSuffix}`]
  );
  await db.query(
    `INSERT INTO token_usage (
       session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       raw_input, raw_output, raw_cache_read, raw_cache_write
     )
     VALUES ($1, 'claude-opus-4-8', 1, 1, $2, 1, 1, 1, $2, 1)`,
    [`session-${idSuffix}`, cacheReadTokens]
  );
  await db.query(
    `INSERT INTO token_events (
       session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
     )
     VALUES ($1, 'claude-opus-4-8', '2026-06-07T10:00:30.000Z', 1, 1, $2, 1)`,
    [`session-${idSuffix}`, cacheReadTokens]
  );
  await db.query(
    `INSERT INTO claude_code_api_request (
       id, session_id, model, tokens_input, tokens_output, tokens_cache_read,
       tokens_cache_creation, cost_usd, started_at, duration_ms
     )
     VALUES ($1, $2, 'claude-opus-4-8', 1, 1, $3, 1, 0, '2026-06-07T10:00:30.000Z', 100)`,
    [`api-request-${idSuffix}`, `session-${idSuffix}`, cacheReadTokens]
  );
}

async function readTokenMetricCacheReadValues(
  db: SqliteDb,
  idSuffix: string
): Promise<{
  tokenUsage: number;
  tokenEvents: number;
  claudeCodeApiRequest: number;
}> {
  const [tokenUsage, tokenEvents, claudeCodeApiRequest] = await Promise.all([
    db.query<{ value: number }>(
      "SELECT cache_read_tokens AS value FROM token_usage WHERE session_id = $1",
      [`session-${idSuffix}`]
    ),
    db.query<{ value: number }>(
      "SELECT cache_read_tokens AS value FROM token_events WHERE session_id = $1",
      [`session-${idSuffix}`]
    ),
    db.query<{ value: number }>(
      "SELECT tokens_cache_read AS value FROM claude_code_api_request WHERE session_id = $1",
      [`session-${idSuffix}`]
    ),
  ]);

  return {
    tokenUsage: Number(tokenUsage.rows[0]?.value ?? 0),
    tokenEvents: Number(tokenEvents.rows[0]?.value ?? 0),
    claudeCodeApiRequest: Number(claudeCodeApiRequest.rows[0]?.value ?? 0),
  };
}
