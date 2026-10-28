/**
 * ISS-11785 replay, against real Postgres and the real pipeline: a preview schema
 * built from a `public` shaped like stage `public` on 2026-09-30.
 *
 * Each case creates its own database, whose `public` holds the migrations a PR's
 * base had applied plus the rows stage held: an organization, and the legacy
 * Engineer View comment that broke the prod deploy (ISS-11749) — a NATIVE-thread
 * body with no `type`, which no rule in `20260930150000_iss11212_comment_contract_core`
 * classifies. The PR's tree is that base plus one migration. Then the pipeline
 * builds the PR's preview schema exactly as `/preview-schemas/ensure` does, minus
 * the seed (a `pnpm` spawn this suite does not need).
 *
 * - #8187's migration fails the build on the cloned legacy row.
 * - A migration with no data dependency builds, over the cloned rows.
 *
 * Skips when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSslClient,
  migrationChecksum,
  quoteIdentifier,
  readMigrationSql,
  stripConcurrentlyKeyword,
} from "../../scripts/db-utils";
import { runMigrationPipeline } from "../../scripts/migration-pipeline";
import {
  ensureMigrationsTableSql,
  stampAppliedRowSql,
} from "../../scripts/preview-prestamp";
import { PRISMA_CLI_ENTRY_ENV } from "../../scripts/prisma-cli";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const PREVIEW_SCHEMA = `preview_iss11785_${RUN_ID}`;
const BRANCH = `feat/iss-11785-${RUN_ID}`;

const PACKAGE_DIR = path.join(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, "prisma", "migrations");
const PRISMA_ENTRY = path.join(
  PACKAGE_DIR,
  "node_modules",
  "prisma",
  "build",
  "index.js"
);

/** #8187: ISS-11212's comment contract, whose backfill raises on an unclassified body. */
const ISS11212_MIGRATION = "20260930150000_iss11212_comment_contract_core";
/** One nullable ADD COLUMN: no dependency on any row. */
const NO_DATA_MIGRATION =
  "20260930003000_iss11427_monitored_activity_held_since";
/** The migration before it, and so its base. */
const NO_DATA_BASE_TIP =
  "20260929210000_iss11322_claude_code_telemetry_families";
/** #8187's base: main's last migration before it merged is the one above. */
const ISS11212_BASE_TIP = NO_DATA_MIGRATION;

const ISS11212_INVARIANT_RE =
  /ISS-11212: 1 comments rows match no body_format rule/;
const PUBLIC_MIGRATIONS = '"public"."_prisma_migrations"';
const PRISMA_TIMEOUT_MS = 240_000;
const SCHEMA_PRISMA = 'datasource db {\n  provider = "postgresql"\n}\n';
const PRISMA_CONFIG_MJS = `import path from "node:path";

export default {
  schema: path.join(import.meta.dirname, "schema.prisma"),
  migrations: { path: path.join(import.meta.dirname, "migrations") },
  datasource: { url: process.env.DATABASE_URL },
};
`;

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

function databaseUrl(database: string, schema?: string): string {
  const url = new URL(requireUrl());
  url.pathname = `/${database}`;
  if (schema) {
    url.searchParams.set("schema", schema);
  }
  return url.toString();
}

/** Every shipped migration up to and including `tip`, in order. */
function migrationsThrough(tip: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name <= tip)
    .map((entry) => entry.name)
    .sort();
}

async function withClient<T>(
  url: string,
  fn: (client: ReturnType<typeof createSslClient>) => Promise<T>
): Promise<T> {
  const client = createSslClient(url);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A Prisma project whose migrations directory is exactly `names`. */
function writeProject(names: string[]): { dir: string; migrationsDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "iss11785-project-"));
  const migrationsDir = path.join(dir, "migrations");
  for (const name of names) {
    cpSync(path.join(MIGRATIONS_DIR, name), path.join(migrationsDir, name), {
      recursive: true,
    });
  }
  writeFileSync(path.join(dir, "schema.prisma"), SCHEMA_PRISMA);
  writeFileSync(path.join(dir, "prisma.config.mjs"), PRISMA_CONFIG_MJS);
  return { dir, migrationsDir };
}

/**
 * Stage `public` as of the PR's base: every base migration applied and recorded
 * the way Prisma records it, then the rows stage held.
 */
async function buildStagePublic(url: string, base: string[]): Promise<void> {
  await withClient(url, async (client) => {
    await client.query(ensureMigrationsTableSql(PUBLIC_MIGRATIONS));
    for (const name of base) {
      const sql = readMigrationSql(name, MIGRATIONS_DIR);
      await client.query(stripConcurrentlyKeyword(sql));
      await client.query(stampAppliedRowSql(PUBLIC_MIGRATIONS), [
        name,
        migrationChecksum(sql),
      ]);
    }

    const organizationId = randomUUID();
    const threadId = randomUUID();
    const text = "Planning has started.\n\n-Closedloop.dev";
    await client.query(
      `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
       VALUES ($1, $2, 'iss11785', $3, now(), now())`,
      [organizationId, `clerk_${organizationId}`, `iss11785-${organizationId}`]
    );
    await client.query(
      `INSERT INTO comment_threads (id, organization_id, source, updated_at)
       VALUES ($1, $2, 'NATIVE', now())`,
      [threadId, organizationId]
    );
    await client.query(
      `INSERT INTO comments (id, thread_id, author_id, body, plain_text, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())`,
      [
        randomUUID(),
        threadId,
        randomUUID(),
        JSON.stringify({
          version: 1,
          content: [{ type: "paragraph", children: [{ text }] }],
        }),
        text,
      ]
    );
  });
}

describe.skipIf(!DATABASE_URL)(
  "ISS-11785: a PR preview runs its new migrations over a clone of public",
  () => {
    let database: string;
    let projectDir: string | null = null;
    let previousPrismaEntry: string | undefined;

    beforeEach(async () => {
      database = `iss11785_${RUN_ID}_${randomUUID().slice(0, 8)}`;
      await withClient(requireUrl(), (client) =>
        client.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
      );
      // The CLI as an entrypoint under this node, not whatever `prisma` PATH holds.
      previousPrismaEntry = process.env[PRISMA_CLI_ENTRY_ENV];
      process.env[PRISMA_CLI_ENTRY_ENV] = PRISMA_ENTRY;
      vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      if (previousPrismaEntry === undefined) {
        Reflect.deleteProperty(process.env, PRISMA_CLI_ENTRY_ENV);
      } else {
        process.env[PRISMA_CLI_ENTRY_ENV] = previousPrismaEntry;
      }
      if (projectDir) {
        rmSync(projectDir, { force: true, recursive: true });
        projectDir = null;
      }
      await withClient(requireUrl(), (client) =>
        client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
        )
      );
    });

    async function buildPreview(base: string[], prMigration: string) {
      await buildStagePublic(databaseUrl(database), base);
      const project = writeProject([...base, prMigration]);
      projectDir = project.dir;
      return runMigrationPipeline(
        databaseUrl(database, PREVIEW_SCHEMA),
        PREVIEW_SCHEMA,
        BRANCH,
        {
          runPreviewSeed: () => undefined,
          prismaCli: { cwd: project.dir, migrationsDir: project.migrationsDir },
        }
      );
    }

    it(
      "fails #8187's migration on the cloned legacy comment",
      async () => {
        await expect(
          buildPreview(migrationsThrough(ISS11212_BASE_TIP), ISS11212_MIGRATION)
        ).rejects.toThrow(ISS11212_INVARIANT_RE);
      },
      PRISMA_TIMEOUT_MS
    );

    it(
      "builds a migration with no data dependency over the cloned rows",
      async () => {
        await buildPreview(
          migrationsThrough(NO_DATA_BASE_TIP),
          NO_DATA_MIGRATION
        );

        const preview = quoteIdentifier(PREVIEW_SCHEMA);
        const [organizations, applied] = await withClient(
          databaseUrl(database),
          async (client) => [
            (
              await client.query(
                `SELECT count(*)::int AS n FROM ${preview}.organizations`
              )
            ).rows[0]?.n,
            (
              await client.query(
                `SELECT 1 FROM ${preview}."_prisma_migrations"
                  WHERE migration_name = $1 AND finished_at IS NOT NULL`,
                [NO_DATA_MIGRATION]
              )
            ).rowCount,
          ]
        );
        expect(organizations).toBe(1);
        expect(applied).toBe(1);
      },
      PRISMA_TIMEOUT_MS
    );
  }
);
