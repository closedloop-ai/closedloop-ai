/**
 * ISS-4603 — real-Postgres proof of the behaviour the sanctioned
 * delete-and-re-land exception in `migration-immutability` rests on:
 * `prisma migrate deploy` TOLERATES a migration recorded in
 * `_prisma_migrations` but absent from the migrations folder, while
 * `migrate dev` does NOT.
 *
 * Until now only prose asserted it (FEA-3638 #3324 and ISS-4565 #4080 headers).
 * Every CI `migrate deploy` starts from an empty database and applies the whole
 * history in order, so none ever reaches the applied-but-locally-absent state,
 * and a Prisma upgrade that turned the tolerance into an error would first be
 * seen on a stage or production deploy.
 *
 * This narrows that gap rather than closing it: `database-integration-tests` is
 * `continue-on-error: true` (ISS-6361), so a red here names the regression on
 * its own check run without failing the PR. Promoting the lane is a separate
 * decision than this test.
 *
 * The history is a throwaway three-migration project in a temp directory rather
 * than the repo's own: the tolerance is a property of the Prisma CLI, so a
 * synthetic history exercises it identically in seconds. The orphan is created
 * the way a re-land creates one — deployed, then deleted from disk — so its
 * `_prisma_migrations` row carries a checksum Prisma itself wrote.
 *
 * Isolated `iss4603_*` schemas carrying a per-invocation suffix, created and
 * dropped by name here; never `public` and never the repo's own
 * `_prisma_migrations`.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";

const DATABASE_URL = process.env.DATABASE_URL;
// Unique per invocation, because this repo's Postgres is routinely shared by
// concurrent worktrees and Dagger lanes (ISS-7143): a fixed name lets one run
// drop another's schema mid-test. Random rather than `process.pid` — pids are
// unique only within a PID namespace, and two containers sharing one database
// can hold the same one. `afterAll` drops exactly these two names; a
// `LIKE 'iss4603_%'` sweep would re-introduce the cross-run destruction this
// suffix exists to stop.
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const DEPLOY_SCHEMA = `iss4603_migrate_deploy_orphan_it_${RUN_ID}`;
const DEV_SCHEMA = `iss4603_migrate_dev_orphan_it_${RUN_ID}`;

const FIRST = { name: "20260101000000_iss4603_first", table: "iss4603_first" };
const ORPHANED = {
  name: "20260102000000_iss4603_orphaned",
  table: "iss4603_orphaned",
};
const PENDING = {
  name: "20260103000000_iss4603_pending",
  table: "iss4603_pending",
};

const PRISMA_BIN = path.join(
  import.meta.dirname,
  "..",
  "..",
  "node_modules",
  ".bin",
  "prisma"
);

/**
 * Per-spawn budget, well under the suite's 300s `SEED_DB_TEST_TIMEOUT_MS` floor
 * so a wedged CLI fails here with its output captured rather than as a bare
 * Vitest abort. `migrate dev` prompts for a migration name when it finds NO
 * drift, and that prompt does not abort on closed stdin — without this a
 * regression in the divergence below would hang the suite instead of reddening
 * it.
 */
const PRISMA_TIMEOUT_MS = 90_000;

/** The sentence `migrate dev` emits for exactly this state, and nothing else. */
const DRIFT_MESSAGE =
  "applied to the database but absent from the migrations directory are";

const SCHEMA_PRISMA = 'datasource db {\n  provider = "postgresql"\n}\n';

// Dependency-free, like `prisma-runtime/prisma.config.mjs`: Prisma 7 reads
// `datasource.url` only from a config file, and this one is loaded by a spawned
// CLI that has no access to the workspace's TS config or its imports.
const PRISMA_CONFIG_MJS = `import path from "node:path";

export default {
  schema: path.join(import.meta.dirname, "schema.prisma"),
  migrations: { path: path.join(import.meta.dirname, "migrations") },
  datasource: { url: process.env.DATABASE_URL },
};
`;

type Migration = { name: string; table: string };
type Project = { dir: string; config: string; migrationsDir: string };
type CliRun = { status: number | null; output: string };

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

// `addSchemaToUrl` defers to a `?schema=` the URL already carries; isolation
// from `public` must not be optional, so force it.
function withSchema(schema: string): string {
  const url = new URL(requireUrl());
  url.searchParams.set("schema", schema);
  return url.toString();
}

/** Every temp project ever created, so a throw cannot orphan one. */
const createdProjects: Project[] = [];

function createProject(): Project {
  const dir = mkdtempSync(path.join(tmpdir(), "iss4603-"));
  const migrationsDir = path.join(dir, "migrations");
  writeFileSync(path.join(dir, "schema.prisma"), SCHEMA_PRISMA);
  writeFileSync(path.join(dir, "prisma.config.mjs"), PRISMA_CONFIG_MJS);
  const project = {
    dir,
    config: path.join(dir, "prisma.config.mjs"),
    migrationsDir,
  };
  createdProjects.push(project);
  for (const migration of [FIRST, ORPHANED, PENDING]) {
    writeMigration(project, migration);
  }
  return project;
}

function writeMigration(project: Project, migration: Migration): void {
  mkdirSync(path.join(project.migrationsDir, migration.name), {
    recursive: true,
  });
  writeFileSync(
    path.join(project.migrationsDir, migration.name, "migration.sql"),
    `CREATE TABLE "${migration.table}" (id integer PRIMARY KEY);\n`
  );
}

function removeMigration(project: Project, name: string): void {
  rmSync(path.join(project.migrationsDir, name), {
    recursive: true,
    force: true,
  });
}

function runPrisma(
  project: Project,
  schema: string,
  args: readonly string[]
): CliRun {
  const result = spawnSync(PRISMA_BIN, [...args, "--config", project.config], {
    cwd: project.dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PRISMA_TIMEOUT_MS,
    // ISS-4436: this child's cwd is a temp directory, so it cannot resolve the
    // dd-trace preload the CI lane puts in `NODE_OPTIONS` and would die before
    // parsing an argument. `vitest.config.integration.ts` wires the canonical
    // stripper into this tier, so `process.env` is already clean here.
    env: { ...process.env, DATABASE_URL: withSchema(schema) },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    throw new Error(
      `prisma ${args.join(" ")} did not run to completion (${result.error.message}); output: ${output}`,
      { cause: result.error }
    );
  }
  return { status: result.status, output };
}

type PgClient = ReturnType<typeof createSslClient>;

async function withClient<T>(run: (client: PgClient) => Promise<T>) {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function columnValues(
  client: PgClient,
  column: string,
  text: string,
  values?: unknown[]
): Promise<string[]> {
  const { rows } = await client.query<Record<string, string>>(text, values);
  return rows.map((row) => row[column]);
}

// No pre-drop: RUN_ID makes both names new, so anything already under them
// would belong to another live run and must not be touched.
async function createSchemas(): Promise<void> {
  await withClient(async (client) => {
    for (const schema of [DEPLOY_SCHEMA, DEV_SCHEMA]) {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    }
  });
}

async function dropSchemas(): Promise<void> {
  await withClient(async (client) => {
    for (const schema of [DEPLOY_SCHEMA, DEV_SCHEMA]) {
      await client.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`
      );
    }
  });
}

async function appliedMigrationNames(schema: string): Promise<string[]> {
  return await withClient((client) =>
    columnValues(
      client,
      "migration_name",
      `SELECT migration_name FROM ${quoteIdentifier(schema)}."_prisma_migrations"
       WHERE finished_at IS NOT NULL ORDER BY migration_name`
    )
  );
}

async function tableNames(schema: string): Promise<string[]> {
  return await withClient((client) =>
    columnValues(
      client,
      "tablename",
      "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [schema]
    )
  );
}

/**
 * Deploys `FIRST` and `ORPHANED`, then deletes `ORPHANED` from disk and restores
 * `PENDING`: the state a delete-and-re-land leaves on stage, with one genuinely
 * pending migration behind it.
 */
function reachAppliedButLocallyAbsent(schema: string): Project {
  const project = createProject();
  removeMigration(project, PENDING.name);

  const seed = runPrisma(project, schema, ["migrate", "deploy"]);
  if (seed.status !== 0 || !seed.output.includes(ORPHANED.name)) {
    throw new Error(
      `seed deploy did not apply ${ORPHANED.name} (exit ${seed.status}): ${seed.output}`
    );
  }

  removeMigration(project, ORPHANED.name);
  writeMigration(project, PENDING);
  return project;
}

describe.skipIf(!DATABASE_URL)(
  "prisma migrate deploy with an applied-but-locally-absent migration (integration)",
  () => {
    beforeAll(async () => {
      await createSchemas();
    });

    // Schemas first: they are the shared resource, and a `beforeAll` that threw
    // partway still reaches this (`IF EXISTS` covers the never-created half).
    // The temp dirs are process-local and OS-reaped, so they go in `finally`
    // where a failed drop cannot skip them and they cannot mask it.
    afterAll(async () => {
      try {
        await dropSchemas();
      } finally {
        for (const project of createdProjects) {
          rmSync(project.dir, { recursive: true, force: true });
        }
      }
    });

    it("tolerates the orphan record and still applies the pending migration", async () => {
      const project = reachAppliedButLocallyAbsent(DEPLOY_SCHEMA);

      // The state this test exists to reach — without it the deploy below is a
      // deploy against an ordinary history and proves nothing.
      expect(await appliedMigrationNames(DEPLOY_SCHEMA)).toEqual([
        FIRST.name,
        ORPHANED.name,
      ]);
      expect(readdirSync(project.migrationsDir).sort()).toEqual([
        FIRST.name,
        PENDING.name,
      ]);

      const deploy = runPrisma(project, DEPLOY_SCHEMA, ["migrate", "deploy"]);

      expect(deploy.output).toContain(PENDING.name);
      expect(deploy.status).toBe(0);
      expect(await appliedMigrationNames(DEPLOY_SCHEMA)).toEqual([
        FIRST.name,
        ORPHANED.name,
        PENDING.name,
      ]);
      // The orphan's own table survives untouched: tolerated, not reconciled.
      expect(await tableNames(DEPLOY_SCHEMA)).toEqual([
        "_prisma_migrations",
        FIRST.table,
        ORPHANED.table,
        PENDING.table,
      ]);
    });

    // `migrate dev` computes drift through a SHADOW DATABASE, so this case needs
    // a role that can CREATE DATABASE. CI's `postgres:16` `POSTGRES_USER` and a
    // local dev Postgres both can; a locked-down managed role cannot, and would
    // fail here on the shadow database rather than on the divergence.
    it("migrate dev diverges on the same state, which is the asymmetry the headers cite", async () => {
      const project = reachAppliedButLocallyAbsent(DEV_SCHEMA);

      const dev = runPrisma(project, DEV_SCHEMA, ["migrate", "dev"]);

      expect(dev.output).toContain(DRIFT_MESSAGE);
      expect(dev.output).toContain(ORPHANED.name);
      expect(dev.status).not.toBe(0);
      // It exits 130 on the drift alone, applying nothing — no prompt is
      // rendered on this path, so the outcome is the same headless in CI.
      expect(await appliedMigrationNames(DEV_SCHEMA)).toEqual([
        FIRST.name,
        ORPHANED.name,
      ]);
    });
  }
);
