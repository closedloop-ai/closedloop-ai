/**
 * Lock-free "at-head" probe for preview schemas (FEA-3071 Slice 1).
 *
 * WHY: every `apps/api` deploy runs `prisma migrate deploy` in `prebuild`, which
 * takes Prisma's per-DATABASE migration advisory lock (72707369). Preview
 * schemas are per-branch and long-lived, so a preview REDEPLOY with nothing
 * pending still enters the serialize gate + `migrate deploy` and takes that lock
 * for no reason. Under the shared stage instance this baseline traffic stacks
 * the FEA-3065 gate; past ~10 concurrent migrates waiters fail open and collide
 * on Prisma's lock → P1002. This probe lets a preview that is ALREADY at head
 * skip the gate + migrate entirely, taking ZERO advisory-lock acquisitions.
 *
 * It is deliberately NOT the storm fix: when a migration lands on `main` every
 * rebased preview is behind and this probe returns false, so they still queue
 * (that is FEA-3071 Slice 2, the merge-triggered migrator). This slice removes
 * the steady-state baseline and is the correctness foundation Slice 2 builds on.
 *
 * CORRECTNESS (per the Codex review of PLN-1508):
 *  - Schema-qualified read: a raw `pg.Client` ignores the URL `?schema=` param,
 *    so an unqualified `_prisma_migrations` query would read `public` and falsely
 *    mark previews at head. We qualify `"<schema>"."_prisma_migrations"`.
 *  - "Applied" means `finished_at IS NOT NULL AND rolled_back_at IS NULL`. A row
 *    existing is not enough — a failed row (stale `started_at`, null `finished_at`)
 *    or a rolled-back row must NOT count as applied. Furthermore, ANY unresolved
 *    (in-flight/failed) row — both timestamps null — forces not-at-head, so the
 *    gated migrate and its P3009 preview reset still run against partial DDL
 *    rather than being silently skipped. Rows are Zod-parsed (no unvalidated
 *    casts); a malformed shape degrades to the same safe not-at-head fallback.
 *  - The FEA-3817/3915 prestamp skip-list migrations are treated as satisfied:
 *    they are never built on preview (pre-stamped, lock-free), so requiring an
 *    applied row for them would false-negative and needlessly re-take the lock.
 *  - INVALID-index caveat: a cancelled `CREATE INDEX CONCURRENTLY` can leave an
 *    invalid same-named index that a row-only probe cannot see. Acceptable here —
 *    the skip-list only ever covers perf-only, non-unique indexes; unique /
 *    correctness indexes are never skippable, so are never masked by this probe.
 *
 * FAIL-OPEN: any uncertainty (missing table on a fresh schema, connect/query
 * error) returns false → the normal gated migrate runs. We only ever SKIP when
 * we can positively prove at-head; we never skip on doubt.
 *
 * No I/O at module load; the pg client and the migrations-dir reader are injected
 * so the decision is unit-testable without a database. Sibling-lib pattern, see
 * preview-prestamp.ts / migration-lock.ts.
 */

import { readdirSync } from "node:fs";
import {
  createSqlClient,
  defaultMigrationsDir,
  endQuietly,
  MigrationRowSchema,
  quoteIdentifier,
  type SqlClient,
} from "./db-utils";
import { PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS } from "./preview-heavy-migrations";
import { isPreviewSchema } from "./preview-schema";

type PreviewAtHeadLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export type PreviewAtHeadDeps = {
  /** pg client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (databaseUrl: string) => SqlClient;
  /** Migration directory names — defaults to reading the prisma/migrations dir. */
  listMigrationDirs?: () => string[];
  logger?: PreviewAtHeadLogger;
};

/**
 * The migrations that a preview schema at head still lacks: every migration
 * directory that is neither applied nor a preview-skippable (pre-stamped) one.
 * Pure — the I/O wrapper supplies the inputs. Empty result ⇒ at head.
 */
export function previewPendingMigrations(
  allMigrationDirs: readonly string[],
  appliedMigrationNames: ReadonlySet<string>,
  prestampSkippable: ReadonlySet<string>
): string[] {
  return allMigrationDirs.filter(
    (name) => !(appliedMigrationNames.has(name) || prestampSkippable.has(name))
  );
}

/**
 * Reads the Prisma migration directory names from `migrationsDir` — by default
 * `prisma/migrations` relative to `process.cwd()`. The prebuild entrypoint
 * (`tsx scripts/migrate.ts`) runs from `packages/database`, the same base
 * `prisma migrate deploy` uses to locate `prisma/migrations`, so this resolves
 * the identical set Prisma applies. ISS-6810: a caller running from elsewhere
 * (the ensure route's function, cwd `apps/api`) names the directory per run.
 *
 * IMPORTANT: do NOT resolve this via `import.meta.dirname`. At deploy time this
 * module is loaded through tsx's CJS transform, where `import.meta.dirname` is
 * `undefined`; a module-level `join(undefined, …)` throws at import and crashes
 * the entire migrate run (public and preview alike). Keeping it cwd-relative and
 * inside the function — evaluated lazily and only within the probe's try/catch —
 * keeps any resolution failure on the fail-open path.
 */
export function defaultListMigrationDirs(
  migrationsDir: string = defaultMigrationsDir()
): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

type MigrationState = {
  /** Migrations with a finished, non-rolled-back row. */
  applied: Set<string>;
  /**
   * True when a row is in-flight/failed (started, neither finished nor rolled
   * back) OR the result/row shape is malformed. Prisma's `migrate deploy` still
   * has work (or a P3009 preview reset) to do in that state, so the schema is
   * NOT provably at head and the probe must fall through to the gated migrate.
   */
  hasUnresolved: boolean;
};

/**
 * Parses `_prisma_migrations` rows with Zod (no unvalidated casts over unknown
 * shapes). A malformed result or row degrades to the safe fallback
 * (`hasUnresolved: true`) so the probe never skips migrate on ambiguous state.
 */
function parseMigrationState(result: unknown): MigrationState {
  const applied = new Set<string>();
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    return { applied, hasUnresolved: true };
  }

  let hasUnresolved = false;
  for (const raw of rows) {
    const parsed = MigrationRowSchema.safeParse(raw);
    if (!parsed.success) {
      hasUnresolved = true;
      continue;
    }
    const row = parsed.data;
    if (row.rolled_back_at !== null) {
      // Rolled back ⇒ not applied; Prisma re-applies it. If it is a local
      // migration it surfaces as pending below; otherwise it is irrelevant.
      continue;
    }
    if (row.finished_at === null) {
      // Started but neither finished nor rolled back — a partial/failed migration.
      hasUnresolved = true;
      continue;
    }
    applied.add(row.migration_name);
  }
  return { applied, hasUnresolved };
}

/**
 * Returns true only when `schema` is a preview schema PROVABLY at migration head
 * (no pending, non-skippable migration). No advisory lock is taken. Any error or
 * ambiguity returns false so the caller runs the normal gated migrate.
 * No-op (false) for `public`/null — those always migrate inline.
 */
export async function probePreviewSchemaAtHead(
  databaseUrl: string,
  schema: string | null,
  deps: PreviewAtHeadDeps = {}
): Promise<boolean> {
  if (!(schema && isPreviewSchema(schema))) {
    return false;
  }

  const logger = deps.logger ?? { log: console.log, warn: console.warn };
  const listMigrationDirs = deps.listMigrationDirs ?? defaultListMigrationDirs;
  const createClient = deps.createClient ?? createSqlClient;
  const qualifiedTable = `${quoteIdentifier(schema)}."_prisma_migrations"`;

  let client: SqlClient | null = null;
  try {
    const allMigrationDirs = listMigrationDirs();
    if (allMigrationDirs.length === 0) {
      // Can't prove at-head with an empty migration set — migrate normally.
      return false;
    }

    client = createClient(databaseUrl);
    await client.connect();
    // Read the FULL row state (not just applied rows): an in-flight/failed row
    // — finished_at AND rolled_back_at both null — means Prisma still has work
    // (or a P3009 preview reset) pending, so we must not declare at head even
    // when every local migration name has an applied row.
    const result = await client.query(
      `SELECT "migration_name", "finished_at", "rolled_back_at" FROM ${qualifiedTable}`
    );

    const { applied, hasUnresolved } = parseMigrationState(result);
    if (hasUnresolved) {
      return false;
    }

    const pending = previewPendingMigrations(
      allMigrationDirs,
      applied,
      new Set(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS)
    );
    return pending.length === 0;
  } catch (error) {
    // Fail-open: a fresh schema whose `_prisma_migrations` table does not exist
    // yet throws here and is correctly treated as "behind".
    logger.warn(
      `⚠️ At-head probe for ${schema} failed (running normal gated migrate): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  } finally {
    await endQuietly(client);
  }
}
