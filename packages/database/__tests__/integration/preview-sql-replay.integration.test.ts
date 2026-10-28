/**
 * ISS-8039 — real-Postgres proof that the direct SQL replay is INTERCHANGEABLE
 * with `prisma migrate deploy`, not merely similar to it.
 *
 * WHY THIS EXISTS: every unit test in `preview-sql-replay.test.ts` injects a
 * mock `SqlClient`, so they pin the orchestration — what is sent, in what order,
 * what is recorded, what declines — and can say nothing about whether Postgres
 * accepts it or whether Prisma later agrees the schema is at head. That is the
 * load-bearing claim of the change: the replay bypasses Prisma's migration
 * engine, rewrites `CONCURRENTLY`, relies on `search_path`, and writes
 * `_prisma_migrations` itself. Four independent things a mock cannot see.
 *
 * The history is a synthetic three-migration project in a temp directory rather
 * than the repo's own 344: the property under test belongs to the MECHANISM, so
 * a small history exercises it identically in seconds. It deliberately carries
 * the three constructs `schema.prisma` cannot express — a trigger, a partial
 * unique index, and a `CREATE INDEX CONCURRENTLY` — because those are exactly
 * what the rejected `db push` approach silently dropped.
 *
 * Isolated `preview_iss8039_*` schemas with a per-invocation suffix, created and
 * dropped by name; never `public` and never the repo's own `_prisma_migrations`.
 * Skips when DATABASE_URL is unset.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";
import { replayPendingMigrationsViaSql } from "../../scripts/preview-sql-replay";

const DATABASE_URL = process.env.DATABASE_URL;
// Unique per invocation: this repo's Postgres is routinely shared by concurrent
// worktrees and Dagger lanes (ISS-7143), and a fixed name lets one run drop
// another's schema mid-test.
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const DEPLOYED_SCHEMA = `preview_iss8039_deployed_${RUN_ID}`;
const REPLAYED_SCHEMA = `preview_iss8039_replayed_${RUN_ID}`;

const PRISMA_BIN = path.join(
  import.meta.dirname,
  "..",
  "..",
  "node_modules",
  ".bin",
  "prisma"
);
const PRISMA_TIMEOUT_MS = 90_000;
const SCHEMA_PRISMA = 'datasource db {\n  provider = "postgresql"\n}\n';
const PRISMA_CONFIG_MJS = `import path from "node:path";

export default {
  schema: path.join(import.meta.dirname, "schema.prisma"),
  migrations: { path: path.join(import.meta.dirname, "migrations") },
  datasource: { url: process.env.DATABASE_URL },
};
`;

/**
 * A trigger, a partial UNIQUE index, and a CONCURRENTLY build — the three
 * constructs a `schema.prisma`-derived approach cannot express, and therefore
 * the three this mechanism has to carry to be worth preferring.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "20260101000000_iss8039_table",
    sql: `CREATE TABLE "iss8039_row" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "key_folded" TEXT NOT NULL DEFAULT '',
  "retired_at" TIMESTAMPTZ,
  CONSTRAINT "iss8039_row_pkey" PRIMARY KEY ("id")
);`,
  },
  {
    name: "20260102000000_iss8039_trigger",
    sql: `CREATE FUNCTION "iss8039_fold"() RETURNS TRIGGER AS $$
BEGIN
  NEW."key_folded" := lower(btrim(NEW."key"));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "iss8039_fold_sync"
BEFORE INSERT OR UPDATE OF "key", "key_folded" ON "iss8039_row"
FOR EACH ROW EXECUTE FUNCTION "iss8039_fold"();`,
  },
  {
    name: "20260103000000_iss8039_indexes",
    sql: `-- Prisma cannot express a partial unique index; this is a correctness guard.
CREATE UNIQUE INDEX "iss8039_row_live_key_key" ON "iss8039_row"("key_folded") WHERE "retired_at" IS NULL;

CREATE INDEX CONCURRENTLY "iss8039_row_key_idx" ON "iss8039_row"("key");`,
  },
];

type Project = { dir: string; config: string; migrationsDir: string };

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

// Isolation from `public` must not be optional, so force the parameter rather
// than deferring to one the URL may already carry.
function withSchema(schema: string): string {
  const url = new URL(requireUrl());
  url.searchParams.set("schema", schema);
  return url.toString();
}

function writeProject(): Project {
  const dir = mkdtempSync(path.join(tmpdir(), "iss8039-project-"));
  const migrationsDir = path.join(dir, "migrations");
  mkdirSync(migrationsDir);
  writeFileSync(path.join(dir, "schema.prisma"), SCHEMA_PRISMA);
  writeFileSync(path.join(dir, "prisma.config.mjs"), PRISMA_CONFIG_MJS);
  for (const migration of MIGRATIONS) {
    mkdirSync(path.join(migrationsDir, migration.name));
    writeFileSync(
      path.join(migrationsDir, migration.name, "migration.sql"),
      `${migration.sql}\n`
    );
  }
  return { dir, config: path.join(dir, "prisma.config.mjs"), migrationsDir };
}

function runPrismaDeploy(
  project: Project,
  schema: string
): { status: number | null; output: string } {
  const result = spawnSync(
    PRISMA_BIN,
    ["migrate", "deploy", "--config", project.config],
    {
      encoding: "utf8",
      timeout: PRISMA_TIMEOUT_MS,
      env: { ...process.env, DATABASE_URL: withSchema(schema) },
    }
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

async function query<T>(sql: string, values?: unknown[]): Promise<T[]> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const result = await client.query(sql, values);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/** The applied history as Prisma records it — name plus the checksum it wrote. */
async function appliedHistory(
  schema: string
): Promise<{ migration_name: string; checksum: string }[]> {
  return await query(
    `SELECT "migration_name", "checksum" FROM ${quoteIdentifier(schema)}."_prisma_migrations"
       WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
       ORDER BY "migration_name"`
  );
}

/**
 * The structure, schema-qualification normalized away so two schemas built by
 * different mechanisms are directly comparable.
 */
async function structure(schema: string): Promise<Record<string, string[]>> {
  const rows = await query<{ kind: string; name: string; def: string }>(
    `SELECT 'index' AS kind, indexname AS name, indexdef AS def
       FROM pg_indexes WHERE schemaname = $1
     UNION ALL
     SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid)
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
     UNION ALL
     SELECT 'function', p.proname, pg_get_functiondef(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
     UNION ALL
     SELECT 'table', c.relname, c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema]
  );
  const byKind: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.name.startsWith("_prisma_migrations")) {
      continue;
    }
    // `pg_get_*def` emits the owning schema, UNQUOTED when it needs no quoting
    // and quoted when it does; normalize both so the comparison is about
    // STRUCTURE rather than about which schema it was built in.
    const normalized = row.def
      .replaceAll(quoteIdentifier(schema), "SCHEMA")
      .replaceAll(schema, "SCHEMA");
    const bucket = byKind[row.kind] ?? [];
    bucket.push(`${row.name}: ${normalized}`);
    byKind[row.kind] = bucket;
  }
  for (const list of Object.values(byKind)) {
    list.sort();
  }
  return byKind;
}

async function dropSchemas(): Promise<void> {
  for (const schema of [DEPLOYED_SCHEMA, REPLAYED_SCHEMA]) {
    await query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  }
}

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("preview SQL replay against a real Postgres (ISS-8039)", () => {
  let project: Project;
  let deployedRun: { status: number | null; output: string };
  let replayedOk = false;

  beforeAll(async () => {
    project = writeProject();
    await dropSchemas();
    for (const schema of [DEPLOYED_SCHEMA, REPLAYED_SCHEMA]) {
      await query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    }

    deployedRun = runPrismaDeploy(project, DEPLOYED_SCHEMA);

    replayedOk = await replayPendingMigrationsViaSql(
      requireUrl(),
      REPLAYED_SCHEMA,
      {
        listMigrationDirs: () => MIGRATIONS.map((m) => m.name),
        readMigrationSql: (name) => {
          const found = MIGRATIONS.find((m) => m.name === name);
          if (!found) {
            throw new Error(`no such migration ${name}`);
          }
          return `${found.sql}\n`;
        },
        logger: { log: () => undefined, warn: () => undefined },
      }
    );
  });

  afterAll(async () => {
    await dropSchemas();
    if (project) {
      rmSync(project.dir, { force: true, recursive: true });
    }
  });

  it("builds both arms — the control deploy and the replay", () => {
    // Asserted here rather than in `beforeAll` (biome's noMisplacedAssertion),
    // which also makes a setup failure read as a named test rather than as an
    // unexplained suite abort.
    expect(deployedRun.status, deployedRun.output).toBe(0);
    expect(replayedOk).toBe(true);
  });

  it("produces the same structure as prisma migrate deploy", async () => {
    const [deployed, replayed] = await Promise.all([
      structure(DEPLOYED_SCHEMA),
      structure(REPLAYED_SCHEMA),
    ]);

    // Named explicitly rather than trusting a bare deep-equal to be non-empty:
    // two empty schemas are also equal, and that would pass vacuously.
    expect(deployed.table).toContain("iss8039_row: iss8039_row");
    expect(deployed.trigger?.length).toBe(1);
    expect(deployed.function?.length).toBe(1);
    expect(
      deployed.index?.filter((entry) => entry.includes("WHERE")).length
    ).toBe(1);

    expect(replayed).toEqual(deployed);
  });

  it("records a history Prisma itself accepts as complete", async () => {
    const [deployed, replayed] = await Promise.all([
      appliedHistory(DEPLOYED_SCHEMA),
      appliedHistory(REPLAYED_SCHEMA),
    ]);

    // Same names AND same checksums: a later deploy of the same branch matches
    // an applied row on those, so a mismatch is what would make it re-run the
    // history against objects that already exist.
    expect(replayed).toEqual(deployed);
    expect(replayed).toHaveLength(MIGRATIONS.length);

    // The decisive compatibility claim: Prisma, run against the replayed schema,
    // finds nothing left to do.
    const rerun = runPrismaDeploy(project, REPLAYED_SCHEMA);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("No pending migrations");
  });

  it("carries a working trigger, which is what a schema.prisma push loses", async () => {
    // Structural equality above cannot prove the trigger FIRES. This is the
    // exact defect the rejected `db push` approach shipped: the column exists
    // with its default, the index serves it, and every row silently reads `''`.
    await query(
      `INSERT INTO ${quoteIdentifier(REPLAYED_SCHEMA)}."iss8039_row" ("id", "key") VALUES ($1, $2)`,
      ["r1", "  MiXeD  "]
    );
    const rows = await query<{ key_folded: string }>(
      `SELECT "key_folded" FROM ${quoteIdentifier(REPLAYED_SCHEMA)}."iss8039_row" WHERE "id" = $1`,
      ["r1"]
    );
    expect(rows[0]?.key_folded).toBe("mixed");
  });
});
