/**
 * Lock-free pre-stamp of the CONCURRENTLY perf-index migration(s) as applied on
 * a fresh preview schema (FEA-3817).
 *
 * WHY NOT `prisma migrate resolve --applied`: the Prisma CLI acquires Prisma's
 * migration advisory lock (72707369) for `resolve` too — the exact lock this
 * change keeps uncontended. Under the P1002 storm the resolve times out
 * acquiring it, the pre-stamp fails open, and the CONCURRENTLY build runs anyway
 * — i.e. the mechanism no-op'd precisely when it mattered (confirmed in a real
 * preview build log: "Pre-stamp ... did not apply ... pg_advisory_lock(72707369)
 * ... Timeout: 10000ms"). Instead we write the `_prisma_migrations` applied row
 * DIRECTLY over a plain pg connection — NO Prisma engine, NO advisory lock — so
 * it works even when 72707369 is fully contended.
 *
 * CHECKSUM: we DERIVE it from the migration file — `sha256(migration.sql)`, which
 * IS Prisma's canonical algorithm (`migrationChecksum` in db-utils.ts, pinned
 * against a real Prisma-written checksum by the companion test).
 *
 * This replaced copying the row out of `public._prisma_migrations` (FEA-3817),
 * which could not stamp a migration that had never landed there — i.e. the one
 * introduced by the very PR being previewed. The copy affected zero rows, so a
 * perf-index migration fell through to the CONCURRENTLY apply and a plain-build
 * migration threw, on every preview deploy for that PR's whole life: the skip
 * only began protecting AFTER the migration reached stage `public`, having done
 * nothing during the window that needs it most (ISS-4600). Deriving the checksum
 * needs no source row, so the introducing PR's very first preview is covered.
 *
 * WHY DERIVING IS SAFE, given the copy existed to avoid a wrong checksum making
 * `migrate deploy` FAIL rather than skip: measured against Prisma 7.8.0, that
 * failure mode does not exist. A row stamped with a deliberately corrupt checksum
 * still skipped the build and still exited 0 (`migrate status` likewise) — deploy
 * matches an applied row on `migration_name` + `finished_at` and never validates
 * its checksum. So the derived value is belt (it is the canonical algorithm) and
 * the deploy contract is braces (a mismatch could not fail the deploy anyway).
 *
 * FAULT MODEL — read the per-category contract on `prestampSkippableMigrationsViaSql`
 * below, not a blanket one. Errors are fail-OPEN (warn, let the CONCURRENTLY build
 * run) only while every migration in scope is perf-only; once a plain-build
 * (correctness) entry is in scope they are fail-CLOSED, and since ISS-4437 the
 * plain-build list has been non-empty, so in practice today an error fails the
 * deploy. This header used to promise a blanket fail-open — it was already wrong
 * when ISS-4437 introduced the throw. Preview-only — no-op for `public`/null.
 *
 * No I/O at module load; the pg client is injected so this is unit-testable
 * without a database. Sibling-lib pattern, see migration-lock.ts.
 */

import {
  createSqlClient,
  readMigrationSql as defaultReadMigrationSql,
  endQuietly,
  migrationChecksum,
  quoteIdentifier,
  type SqlClient,
} from "./db-utils";
import {
  migrationsToPrestampForPreview,
  PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS,
} from "./preview-heavy-migrations";

/**
 * Prisma's canonical `_prisma_migrations` table (postgres), `IF NOT EXISTS` so
 * it composes with Prisma's own identical create at the start of migrate deploy.
 */
function ensureMigrationsTableSql(qualifiedTable: string): string {
  return `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
    "id" VARCHAR(36) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
  )`;
}

/**
 * Write the applied row into the preview schema's `_prisma_migrations` with the
 * checksum DERIVED from the migration file ($2), unless the preview schema
 * already records it applied. Reads no other schema — in particular not
 * `public` — which is what makes it work for a migration this PR introduces
 * (ISS-4600). `gen_random_uuid()` is built into Postgres 13+ (stage/prod are 16).
 * Parameterized on migration_name ($1) and checksum ($2).
 *
 * The `NOT EXISTS` guard is what makes a redeploy idempotent, and it leaves
 * exactly ONE reason for this statement to affect zero rows: the row is already
 * there. (Under the previous copy-from-public form there were two — already
 * present, or public had nothing to copy — which is why the caller no longer
 * needs a follow-up presence query to tell them apart.)
 *
 * The `::varchar` casts are LOAD-BEARING, not decoration. `$1` appears twice —
 * bare in the `SELECT` output list, and compared against the `varchar`
 * `migration_name` column in the guard — and `pg` sends `Parse` with no parameter
 * OIDs, so the server infers each occurrence independently: `text` from the
 * output list, `character varying` from the comparison. Without the casts it
 * refuses the whole statement with `inconsistent types deduced for parameter $1`
 * which, the plain-build list being non-empty, takes the fail-CLOSED branch and
 * fails EVERY preview deploy. The previous copy-from-public form never hit this
 * because `$1` only ever appeared in `varchar` comparison contexts. Covered by
 * `__tests__/integration/preview-prestamp.integration.test.ts` — a mocked client
 * asserts this statement's TEXT and can never assert its VALIDITY.
 */
function stampAppliedRowSql(qualifiedTable: string): string {
  return `INSERT INTO ${qualifiedTable}
      ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count")
    SELECT gen_random_uuid()::text, $2::varchar, $1::varchar, now(), now(), 1
    WHERE NOT EXISTS (
      SELECT 1 FROM ${qualifiedTable} d
      WHERE d."migration_name" = $1::varchar AND d."finished_at" IS NOT NULL
    )`;
}

/**
 * The pre-stamp uses the shared narrow `SqlClient` surface. Alias kept for
 * callers/tests that import `PrestampClient` by name.
 */
export type PrestampClient = SqlClient;

type PrestampLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export type PrestampDeps = {
  /** Client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (databaseUrl: string) => PrestampClient;
  /** Reads a migration's `migration.sql`; defaults to the on-disk read. Injected in tests. */
  readMigrationSql?: (migrationName: string) => string;
  logger?: PrestampLogger;
  /**
   * ISS-6814: the schema is empty for the whole of this `migrate deploy`, so
   * the plain-build (unique, correctness) entries are left to run natively and
   * only the perf-skip entries are stamped — see `PrestampScopeOptions`.
   */
  freshSchema?: boolean;
};

function rowCountOf(result: unknown): number {
  const count = (result as { rowCount?: number | null } | null)?.rowCount;
  return typeof count === "number" ? count : 0;
}

/**
 * The derived checksum for one migration, or `null` when it should be SKIPPED
 * because its `migration.sql` could not be read.
 *
 * Applies the per-category fault model to the READ specifically, so an unreadable
 * file follows that migration's OWN category rather than the run's: a plain-build
 * (correctness) entry rethrows — the caller turns that into the fail-CLOSED
 * refusal — while a perf-only entry warns and is skipped, leaving the remaining
 * migrations to be stamped normally. Without this split, an ENOENT on any
 * perf-only entry would abort the whole loop and, the plain-build list being
 * non-empty, hard-fail a deploy that would otherwise have succeeded — AND leave
 * the plain-build entry (last in the union) unstamped anyway. The read is the
 * prestamp's first dependency on `process.cwd()` (ISS-4600), so this is a
 * genuinely new failure mode rather than a theoretical one.
 */
function checksumForStamp(
  migrationName: string,
  deps: {
    readMigrationSql: (migrationName: string) => string;
    mustStamp: ReadonlySet<string>;
    logger: PrestampLogger;
  }
): string | null {
  try {
    return migrationChecksum(deps.readMigrationSql(migrationName));
  } catch (readError) {
    if (deps.mustStamp.has(migrationName)) {
      throw readError;
    }
    deps.logger.warn(
      `⚠️ Pre-stamp could not read ${migrationName} (continuing; its CONCURRENTLY build will run): ${
        readError instanceof Error ? readError.message : String(readError)
      }`
    );
    return null;
  }
}

/**
 * Pre-stamps the preview-skippable CONCURRENTLY-index migration(s) as applied on
 * `schema` so the subsequent `migrate deploy` skips their instance-wide-blocking
 * build. No-op for `public`/null.
 *
 * Two fault models by category (ISS-4437), both now reachable only through an
 * actual connect/query/file error — never through "the migration is too new",
 * which the derived checksum removes as a failure cause entirely (ISS-4600):
 * - **Perf-skip entries** (PREVIEW_SKIPPABLE_*): FAIL-OPEN. If the row can't be
 *   written, migrate deploy just runs the CONCURRENTLY perf-index build — a missing
 *   perf index only costs a seq scan, so never fail a would-succeed deploy.
 * - **Plain-build entries** (PREVIEW_PLAIN_BUILD_*): FAIL-CLOSED. These are the
 *   correctness/upsert indexes whose CONCURRENTLY build is the P1002 amplifier. If
 *   one can't be positively stamped (ANY connect/query/file error), we THROW so
 *   migrate deploy never runs its CONCURRENTLY statements (which would re-arm the
 *   storm) — the plain rebuild only helps AFTER migrate, and only if migrate
 *   skipped the build. A brand-new such migration no longer has to reach `public`
 *   before its own branch's previews can deploy; it is stamped like any other.
 */
export async function prestampSkippableMigrationsViaSql(
  databaseUrl: string,
  schema: string | null,
  deps: PrestampDeps = {}
): Promise<void> {
  const migrations = migrationsToPrestampForPreview(schema, {
    freshSchema: deps.freshSchema === true,
  });
  if (migrations.length === 0 || !schema) {
    return;
  }

  const createClient = deps.createClient ?? createSqlClient;
  const readMigrationSql = deps.readMigrationSql ?? defaultReadMigrationSql;
  const logger = deps.logger ?? { log: console.log, warn: console.warn };
  const qualifiedTable = `${quoteIdentifier(schema)}."_prisma_migrations"`;
  // The correctness (plain-build) entries: a per-migration lookup for the read
  // guard below, and — derived from `migrations` rather than assumed — whether
  // any of them is in scope for THIS run, which is what makes an error
  // fail-CLOSED. Today `migrations` is the union of both lists for a preview
  // schema so this is always true; deriving it keeps that an observation rather
  // than a hardcoded assumption.
  const mustStamp = new Set<string>(
    PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS
  );
  const plainBuildInScope = migrations.some((name) => mustStamp.has(name));

  // `client` is created INSIDE the try so a synchronous factory/URL-parse throw
  // is caught below (fail-open for perf-only, fail-closed when plain-build exists).
  let client: SqlClient | null = null;
  try {
    client = createClient(databaseUrl);
    await client.connect();
    await client.query(ensureMigrationsTableSql(qualifiedTable));
    for (const migrationName of migrations) {
      const checksum = checksumForStamp(migrationName, {
        readMigrationSql,
        mustStamp,
        logger,
      });
      if (checksum === null) {
        continue;
      }
      const inserted = await client.query(stampAppliedRowSql(qualifiedTable), [
        migrationName,
        checksum,
      ]);
      // `NOT EXISTS` leaves one reason for zero rows: already stamped. No
      // follow-up presence query, and no "nothing in public to copy" case.
      if (rowCountOf(inserted) > 0) {
        logger.log(
          `↪ Pre-stamped ${migrationName} as applied on ${schema} (lock-free preview skip)`
        );
      } else {
        logger.log(
          `↪ ${migrationName} already applied on ${schema} (lock-free preview skip already in effect)`
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Fail-CLOSED when any plain-build (correctness) migration is in scope: we
    // could not confirm its CONCURRENTLY build is skipped, so refuse to proceed.
    if (plainBuildInScope) {
      throw new Error(
        `Lock-free pre-stamp failed with a plain-build migration in scope; refusing to proceed so migrate deploy does not run a CONCURRENTLY build that re-arms the P1002 storm: ${message}`
      );
    }
    logger.warn(
      `⚠️ Lock-free pre-stamp failed (continuing; CONCURRENTLY build will run): ${message}`
    );
  } finally {
    await endQuietly(client);
  }
}
