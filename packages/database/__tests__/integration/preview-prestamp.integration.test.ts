/**
 * ISS-4600 — integration proof that the REAL pre-stamp statement executes against
 * a real Postgres.
 *
 * WHY THIS EXISTS: every unit test in `preview-prestamp.test.ts` injects a mock
 * `PrestampClient`, so they assert the statement's TEXT and never its VALIDITY.
 * That gap shipped a statement Postgres rejects outright: binding `$1` both bare
 * in an `INSERT ... SELECT` output list (inferred `text`) and in a comparison
 * against the `varchar` `migration_name` column made the server refuse it with
 * `inconsistent types deduced for parameter $1 — text versus character varying`,
 * which — because the plain-build list is non-empty — takes the fail-CLOSED
 * branch and turns EVERY `preview_*` deploy red. A mock client cannot see that.
 *
 * Skips when DATABASE_URL is unset. Uses an isolated `preview_*` schema it
 * creates and drops — never touches `public` or the real `_prisma_migrations`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSslClient,
  migrationChecksum,
  quoteIdentifier,
  readMigrationSql,
} from "../../scripts/db-utils";
import { migrationsToPrestampForPreview } from "../../scripts/preview-heavy-migrations";
import { prestampSkippableMigrationsViaSql } from "../../scripts/preview-prestamp";

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = "preview_iss4600_prestamp_it";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const EXPECTED = migrationsToPrestampForPreview(TEST_SCHEMA);

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

/** Stand-in migration bodies so the test never depends on the real tree's contents. */
function fakeMigrationSql(migrationName: string): string {
  return `-- ${migrationName}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_${migrationName}" ON "t" ("c");\n`;
}

async function withClient<T>(
  fn: (q: (sql: string) => Promise<unknown>) => Promise<T>
) {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    return await fn((sql: string) => client.query(sql));
  } finally {
    await client.end();
  }
}

async function stampedRows(): Promise<
  { migration_name: string; checksum: string }[]
> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const result = await client.query(
      `SELECT "migration_name", "checksum" FROM ${quoteIdentifier(TEST_SCHEMA)}."_prisma_migrations" ORDER BY "migration_name"`
    );
    return result.rows as { migration_name: string; checksum: string }[];
  } finally {
    await client.end();
  }
}

/** Base tables in `schema`, sorted — Prisma's own emptiness test (ISS-6466). */
async function baseTableNames(schema: string): Promise<string[]> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const result = await client.query(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [schema]
    );
    return (result.rows as { tablename: string }[]).map((row) => row.tablename);
  } finally {
    await client.end();
  }
}

/**
 * Rows in `schema._prisma_migrations`, or `-1` when the table does not exist —
 * i.e. the pre-stamp DECLINED and P3005's precondition is still standing.
 */
async function stampedRowCountIn(schema: string): Promise<number> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const present = await client.query(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`${schema}._prisma_migrations`]
    );
    if (!(present.rows as { present: boolean }[])[0].present) {
      return -1;
    }
    const result = await client.query(
      `SELECT count(*)::int AS n FROM ${quoteIdentifier(schema)}."_prisma_migrations"`
    );
    return (result.rows as { n: number }[])[0].n;
  } finally {
    await client.end();
  }
}

/**
 * The checksums PRISMA ITSELF wrote, keyed by migration name.
 *
 * Free to read here: the `database-integration-tests` job runs
 * `cd packages/database && pnpm prisma migrate deploy` against this same
 * postgres:16 service BEFORE `test:integration`, so `public._prisma_migrations`
 * already holds a Prisma-authored row for every committed migration. No fixture,
 * no extra service.
 */
async function prismaWrittenChecksums(): Promise<Map<string, string>> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const result = await client.query(
      `SELECT "migration_name", "checksum" FROM public."_prisma_migrations" WHERE "migration_name" = ANY($1::text[])`,
      [[...EXPECTED]]
    );
    return new Map(
      (result.rows as { migration_name: string; checksum: string }[]).map(
        (row) => [row.migration_name, row.checksum]
      )
    );
  } finally {
    await client.end();
  }
}

describe.skipIf(!DATABASE_URL)(
  "prestampSkippableMigrationsViaSql against a real Postgres (ISS-4600)",
  () => {
    beforeAll(async () => {
      await withClient(async (q) => {
        await q(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(TEST_SCHEMA)} CASCADE`
        );
        await q(`CREATE SCHEMA ${quoteIdentifier(TEST_SCHEMA)}`);
      });
    });

    afterAll(async () => {
      await withClient(async (q) => {
        await q(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(TEST_SCHEMA)} CASCADE`
        );
      });
    });

    it("executes the real stamp statement and writes one applied row per migration", async () => {
      // No row exists anywhere in `public` for these names on a throwaway DB —
      // this IS the introducing-PR shape, run against a real server.
      await prestampSkippableMigrationsViaSql(requireUrl(), TEST_SCHEMA, {
        readMigrationSql: fakeMigrationSql,
        logger: { log: () => undefined, warn: () => undefined },
      });

      const rows = await stampedRows();
      expect(rows.map((r) => r.migration_name)).toEqual([...EXPECTED].sort());
      for (const row of rows) {
        expect(row.checksum).toMatch(SHA256_HEX_RE);
      }
    });

    it("is idempotent: a redeploy stamps nothing further and duplicates no row", async () => {
      await prestampSkippableMigrationsViaSql(requireUrl(), TEST_SCHEMA, {
        readMigrationSql: fakeMigrationSql,
        logger: { log: () => undefined, warn: () => undefined },
      });

      const rows = await stampedRows();
      expect(rows).toHaveLength(EXPECTED.length);
    });

    it("creates _prisma_migrations itself when the preview schema is bare", async () => {
      const bareSchema = `${TEST_SCHEMA}_bare`;
      await withClient(async (q) => {
        await q(`DROP SCHEMA IF EXISTS ${quoteIdentifier(bareSchema)} CASCADE`);
        await q(`CREATE SCHEMA ${quoteIdentifier(bareSchema)}`);
      });

      await prestampSkippableMigrationsViaSql(requireUrl(), bareSchema, {
        readMigrationSql: fakeMigrationSql,
        logger: { log: () => undefined, warn: () => undefined },
      });

      const client = createSslClient(requireUrl());
      await client.connect();
      try {
        const result = await client.query(
          `SELECT count(*)::int AS n FROM ${quoteIdentifier(bareSchema)}."_prisma_migrations"`
        );
        expect((result.rows as { n: number }[])[0].n).toBe(EXPECTED.length);
      } finally {
        await client.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(bareSchema)} CASCADE`
        );
        await client.end();
      }
    });

    /**
     * Seed a throwaway `preview_*` schema with `ddl`, run the REAL pre-stamp
     * over it, and report what it did: the ordinary tables present before, and
     * how many rows `_prisma_migrations` ended up with (`-1` = the table does
     * not exist, i.e. the pre-stamp DECLINED and left P3005's precondition
     * intact). Always drops the schema, including when the pre-stamp throws —
     * a fail-CLOSED refusal is exactly the direction these cases guard, and a
     * leaked `preview_*` holding a table with no history is the very state a
     * later run is sensitive to.
     */
    async function prestampOutcome(suffix: string, ddl: readonly string[]) {
      const schema = `${TEST_SCHEMA}_${suffix}`;
      const quoted = quoteIdentifier(schema);
      try {
        await withClient(async (q) => {
          await q(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
          await q(`CREATE SCHEMA ${quoted}`);
          for (const statement of ddl) {
            await q(statement.replaceAll("@S@", quoted));
          }
        });
        const before = await baseTableNames(schema);
        await prestampSkippableMigrationsViaSql(requireUrl(), schema, {
          readMigrationSql: fakeMigrationSql,
          logger: { log: () => undefined, warn: () => undefined },
        });
        return { before, stampedRows: await stampedRowCountIn(schema) };
      } finally {
        await withClient((q) => q(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`));
      }
    }

    it("declines to stamp a schema seeded with a table and NO history, leaving P3005's precondition intact (ISS-6466)", async () => {
      // THE FIXTURE'S STARTING STATE IS THE TEST. The bare-schema case above
      // passes under the broken ordering too — only a schema that already holds
      // an ordinary table AND lacks `_prisma_migrations` can tell the two apart,
      // because that is exactly the state `migrate deploy` answers with P3005,
      // and the P3005 → reset → re-clone recovery is what the mask suppressed.
      const outcome = await prestampOutcome("stale", [
        `CREATE TABLE @S@."scratch" (id int PRIMARY KEY)`,
      ]);

      // Positive control: the un-migrated precondition really held going in. A
      // fixture that silently failed to create `scratch` would otherwise satisfy
      // the assertion below for the wrong reason.
      expect(outcome.before).toEqual(["scratch"]);
      expect(outcome.stampedRows).toBe(-1);
    });

    it("still stamps a schema that holds BOTH a table and its migration history (ISS-6466)", async () => {
      // The steady state, and the only case that exercises the probe's
      // history-side FILTER against real SQL: widen `= 0` to `>= 0` and every
      // other case here still passes while this one drops to -1 — in production
      // that would stop stamping on every preview redeploy and take a spurious
      // reset plus a full re-clone.
      const outcome = await prestampOutcome("steady", [
        `CREATE TABLE @S@."scratch" (id int PRIMARY KEY)`,
        `CREATE TABLE @S@."_prisma_migrations" (
          "id" VARCHAR(36) NOT NULL,
          "checksum" VARCHAR(64) NOT NULL,
          "finished_at" TIMESTAMPTZ,
          "migration_name" VARCHAR(255) NOT NULL,
          "logs" TEXT,
          "rolled_back_at" TIMESTAMPTZ,
          "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
          CONSTRAINT "_prisma_migrations_pkey2" PRIMARY KEY ("id")
        )`,
      ]);

      expect(outcome.before).toEqual(["_prisma_migrations", "scratch"]);
      expect(outcome.stampedRows).toBe(EXPECTED.length);
    });

    it("still stamps a schema holding only a PARTITIONED parent, which Prisma does not count (ISS-6466)", async () => {
      // The over-fire guard, and why the probe reads `pg_class.relkind = 'r'`
      // rather than the obvious `pg_tables` (which is `relkind IN ('r','p')`).
      // Measured against Prisma 7.8.0: a schema holding only a partitioned
      // parent deploys straight through, no P3005. Declining here would leave
      // both plain-build CONCURRENTLY statements UNSTAMPED for a deploy that
      // then runs them — the P1002 amplifier, with no error. Swap the probe back
      // to `pg_tables` and this case drops to -1.
      const outcome = await prestampOutcome("partitioned", [
        `CREATE TABLE @S@."p" (id int) PARTITION BY RANGE (id)`,
      ]);

      expect(outcome.before).toEqual(["p"]);
      expect(outcome.stampedRows).toBe(EXPECTED.length);
    });

    it("derives exactly the checksum Prisma itself wrote, for every migration in scope (ISS-5788)", async () => {
      // The feature's load-bearing claim — "our derived checksum IS Prisma's" —
      // GROUNDED rather than asserted. The unit fixture pins our sha256 against
      // ONE recorded 7.8.0 value and so catches a change on OUR side only; the
      // shape assertion above accepts any 64 hex chars and would pass on a
      // wholly wrong digest. This compares against what the installed Prisma
      // actually wrote, so an upgrade that changed the algorithm fails HERE.
      //
      // It runs the REAL `readMigrationSql` over the REAL migrations tree — the
      // production read+decode and its `process.cwd()` resolution, which every
      // other test in this file replaces with an injected stub.
      const prismaChecksums = await prismaWrittenChecksums();

      // Guard the guard: without migrate deploy the map is empty and the loop
      // below would pass vacuously.
      expect([...prismaChecksums.keys()].sort()).toEqual([...EXPECTED].sort());
      for (const migrationName of EXPECTED) {
        expect(prismaChecksums.get(migrationName)).toBe(
          migrationChecksum(readMigrationSql(migrationName))
        );
      }
    });
  }
);
