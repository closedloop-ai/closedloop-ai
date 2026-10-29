/**
 * ISS-8039 — apply a fresh preview schema's pending migrations over ONE pg
 * connection instead of spawning `prisma migrate deploy`.
 *
 * WHY: a first-time preview schema replays the entire migration history — 344
 * migrations as of 2026-08-25 — inside the 300 s ceiling of the
 * `/preview-schemas/ensure` function. Measured `migrate_ms` had reached 258 s
 * against a 290 s route budget, so the ensure 504'd mid-pipeline
 * (`outcome: deadline_cut`). The telemetry rules out lock contention as the
 * cause: `gate_wait_ms` sits at 40-120 ms across the whole observed window.
 *
 * WHAT IS ACTUALLY SLOW: not the DDL. Replaying all 344 migrations takes ~1.5 s
 * of real work — the cost is the CLI's per-migration round trips and engine
 * startup, and it scales with the migration COUNT rather than with anything the
 * branch changed, so it degrades on every merge.
 *
 * WHAT THIS DOES INSTEAD: reads the same `migration.sql` files, in the same
 * order, and sends each one as a single query on a connection it opens once.
 * A `pg_dump --schema-only` of a schema built this way differs from one built by
 * `migrate deploy` by nothing at all — it is the same SQL — so there is no
 * structural-divergence question to answer. That is the whole reason this is a
 * replay rather than a `db push` or a catalog clone: both of those produce a
 * DIFFERENT schema and have to argue that the difference does not matter.
 * `schema.prisma` cannot express the triggers, functions, partial indexes, or
 * `GENERATED ALWAYS` columns that migrations own here, and several of those are
 * documented correctness guards.
 *
 * PREVIEW ONLY, and only a schema created in THIS run. `PGSCHEMA` accepts
 * non-preview names, so the guard is `isPreviewSchema`, matching `resetSchema`.
 *
 * FAIL-OPEN, by returning `false` rather than throwing: any failure falls back
 * to the ordinary `migrate deploy`, so this can only make a fresh preview
 * faster, never break one that would have worked. The fallback is exact, not
 * approximate — every migration this applies is recorded applied before the next
 * one starts, so `migrate deploy` resumes from wherever this stopped instead of
 * re-running work.
 *
 * ATOMICITY, precisely: each `migration.sql` is one query, and Postgres wraps a
 * multi-statement query in an implicit transaction, so a file either applies
 * whole or not at all. The applied ROW is a second query, matching Prisma's own
 * ordering — Prisma likewise applies then records. A crash in that gap leaves a
 * migration applied but unrecorded, which is the P3005/P3018 state the
 * pipeline's reset recovery already exists for. Three migrations manage their
 * own transaction (`20260602150000`, `20260602160000`, `20260629130000`); their
 * `COMMIT` ends the implicit wrapper early, which is exactly what happens under
 * `migrate deploy` today.
 *
 * No I/O at module load; the client and the file readers are injected, so this
 * is unit-testable without a database or the real migrations tree. Sibling-lib
 * pattern, see preview-prestamp.ts.
 */

import {
  createSqlClient,
  readMigrationSql as defaultReadMigrationSql,
  endQuietly,
  migrationChecksum,
  quoteIdentifier,
  type SqlClient,
  stripConcurrentlyKeyword,
} from "./db-utils";
import {
  defaultListMigrationDirs,
  previewPendingMigrations,
} from "./preview-at-head";
import {
  ensureMigrationsTableSql,
  stampAppliedRowSql,
} from "./preview-prestamp";
import { isPreviewSchema } from "./preview-schema";

type ReplayLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export type SqlReplayDeps = {
  /** Client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (databaseUrl: string) => SqlClient;
  /** Reads a migration's `migration.sql`; defaults to the on-disk read. Injected in tests. */
  readMigrationSql?: (migrationName: string) => string;
  /** Lists migration directory names; defaults to the cwd-relative read (ISS-6810). */
  listMigrationDirs?: () => string[];
  logger?: ReplayLogger;
  /**
   * ISS-11785: replay only the migrations this schema has already applied
   * (stage `public`), so `public`'s rows can be cloned in before the rest run.
   * Absent → every pending migration, as before.
   */
  appliedInSchema?: string;
};

/**
 * Every migration name already recorded applied on `schema`.
 *
 * Unlike the at-head probe this does NOT need to distinguish an in-flight row
 * from a finished one: the only writer that can have touched a schema created in
 * this run is the pre-stamp immediately before, which writes `finished_at`. A
 * row without one is therefore not a state to reason about — it is a reason to
 * decline, which the caller does by treating a throw here as fail-open.
 */
async function appliedMigrationNames(
  client: SqlClient,
  qualifiedTable: string
): Promise<Set<string>> {
  const result = await client.query(
    `SELECT "migration_name" FROM ${qualifiedTable} WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
  );
  const rows = (result as { rows?: unknown } | null)?.rows;
  const names = new Set<string>();
  if (!Array.isArray(rows)) {
    return names;
  }
  for (const row of rows) {
    const name = (row as { migration_name?: unknown }).migration_name;
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

/**
 * Applies `migrationName` and records it applied. One query for the file, one
 * for the row — see the module header on why they are not combined.
 *
 * `CONCURRENTLY` is stripped because a multi-statement query runs inside an
 * implicit transaction, which neither `CREATE INDEX CONCURRENTLY` nor
 * `DROP INDEX CONCURRENTLY` can. A plain build
 * is also the right build here, not a concession to this module's mechanism: a
 * `preview_*` schema is empty at this point, so it takes milliseconds, while CONCURRENTLY waits
 * instance-wide for every open transaction on the shared stage Postgres to drain
 * — the P1002 amplifier that `preview-plain-index.ts` already exists to remove
 * from this exact class of schema. Same rewrite, same reason, shared helper.
 */
async function applyOneMigration(
  client: SqlClient,
  qualifiedTable: string,
  migrationName: string,
  readMigrationSql: (name: string) => string
): Promise<void> {
  const sql = readMigrationSql(migrationName);
  await client.query(stripConcurrentlyKeyword(sql));
  await client.query(stampAppliedRowSql(qualifiedTable), [
    migrationName,
    migrationChecksum(sql),
  ]);
}

/**
 * Brings a preview `schema` created in THIS run to migration head by replaying
 * its pending migrations directly over one connection.
 *
 * Returns `true` only when every pending migration applied AND was recorded, and
 * `false` when the caller must fall back to `migrate deploy`. Never throws.
 *
 * The checksum is derived with Prisma's own algorithm (`migrationChecksum`), so
 * the rows this writes are indistinguishable from ones `migrate deploy` writes —
 * which is what lets a later deploy of the same branch apply only the migrations
 * that branch adds.
 */
export async function replayPendingMigrationsViaSql(
  databaseUrl: string,
  schema: string | null,
  deps: SqlReplayDeps = {}
): Promise<boolean> {
  const logger = deps.logger ?? { log: console.log, warn: console.warn };
  if (!(schema && isPreviewSchema(schema))) {
    return false;
  }

  const createClient = deps.createClient ?? createSqlClient;
  const readMigrationSql = deps.readMigrationSql ?? defaultReadMigrationSql;
  const listMigrationDirs = deps.listMigrationDirs ?? defaultListMigrationDirs;
  const qualifiedTable = `${quoteIdentifier(schema)}."_prisma_migrations"`;

  let client: SqlClient | null = null;
  try {
    const allMigrationDirs = listMigrationDirs();
    if (allMigrationDirs.length === 0) {
      // Not "nothing to do": an empty listing means the directory resolution is
      // wrong (ISS-6810), and reporting success would leave the schema empty
      // while every step reported green.
      logger.warn(
        `⚠️ No migrations found for ${schema}; falling back to migrate deploy (ISS-8039)`
      );
      return false;
    }
    allMigrationDirs.sort();

    client = createClient(databaseUrl);
    await client.connect();
    // Prisma resolves unqualified DDL through `search_path`, and the migration
    // files are unqualified. Without this every statement would land in
    // `public` — the shared stage schema — rather than the preview.
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await client.query(ensureMigrationsTableSql(qualifiedTable));

    const baseline =
      deps.appliedInSchema === undefined
        ? null
        : await appliedMigrationNames(
            client,
            `${quoteIdentifier(deps.appliedInSchema)}."_prisma_migrations"`
          );
    const pending = previewPendingMigrations(
      allMigrationDirs,
      await appliedMigrationNames(client, qualifiedTable),
      new Set()
    ).filter((name) => baseline?.has(name) ?? true);
    for (const migrationName of pending) {
      await applyOneMigration(
        client,
        qualifiedTable,
        migrationName,
        readMigrationSql
      );
    }

    logger.log(
      `↪ Replayed ${pending.length}/${allMigrationDirs.length} migrations into ${schema} over one connection (ISS-8039)`
    );
    return true;
  } catch (error) {
    logger.warn(
      `⚠️ Direct SQL replay for ${schema} did not complete (${
        error instanceof Error ? error.message : String(error)
      }); falling back to migrate deploy, which resumes from the migrations already recorded (ISS-8039)`
    );
    return false;
  } finally {
    await endQuietly(client);
  }
}
