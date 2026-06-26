/**
 * @file migration-runner.ts
 * @description FEA-1791 / PLN-886 Phase 2 — forward-only migration runner for
 * the desktop SQLite store, modelled on `prisma migrate deploy`.
 *
 * On open the runner:
 *  1. ensures the `_desktop_migrations` tracking table exists;
 *  2. baselines a pre-runner install (legacy tables present, tracking table
 *     empty) — re-asserts the frozen legacy DDL once, then records the
 *     BASELINE_MIGRATIONS as applied WITHOUT executing them;
 *  3. self-heals a pre-collapse history (a migration squash declared via
 *     `collapsedMigrations`): a DB that recorded the genesis plus ALL the
 *     migrations later folded into it is schema-identical to a fresh genesis, so
 *     its stale tracking rows are rewritten to the collapsed genesis WITHOUT
 *     executing any DDL — this is what would otherwise trip checksum drift;
 *  4. refuses to continue on checksum drift (a recorded migration was altered)
 *     or downgrade (the DB has a migration this bundle doesn't know);
 *  5. applies pending migrations in order, each inside its own transaction so a
 *     failure rolls the migration back wholesale (Postgres DDL is transactional).
 *
 * There are no down-migrations: the policy is forward-only on user machines.
 */

import {
  DesktopMigrationError,
  MigrationRefusalKind,
} from "../migration-refusal.js";

/** Minimal SQLite surface the runner needs (satisfied by SqliteClient). */
type MigrationExecutor = {
  exec(query: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
};

export type MigrationDb = MigrationExecutor & {
  transaction<T>(callback: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
};

/** One embedded migration from the build-time manifest. */
export type EmbeddedMigration = {
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
};

/**
 * Declares a post-hoc migration squash: the SQL of `supersededNames` was folded
 * verbatim into `genesisName` AFTER those migrations had already been applied to
 * some databases. A DB that recorded `genesisName` plus ALL of `supersededNames`
 * is schema-identical to a fresh `genesisName` (the fold preserved their SQL
 * under `IF NOT EXISTS` / `ADD COLUMN`), so the runner can self-heal it by
 * rewriting the tracking rows to the collapsed genesis WITHOUT executing any DDL.
 * Without this, the changed genesis checksum trips `ChecksumDrift` and bricks the
 * DB. A PARTIAL pre-collapse history (only some superseded rows present) is left
 * untouched — the fold's other DDL may never have run, so the drift/downgrade
 * guard must still surface it rather than the runner falsely claiming it applied.
 */
export type CollapsedMigration = {
  readonly genesisName: string;
  readonly supersededNames: readonly string[];
};

export type RunMigrationsOptions = {
  /** Ordered, embedded migrations (the build-time manifest). */
  migrations: readonly EmbeddedMigration[];
  /** Idempotent legacy DDL re-asserted once when baselining an old install. */
  baselineStatements: readonly string[];
  /** Migration names the baseline snapshot already represents. */
  baselineMigrations: readonly string[];
  /**
   * Post-hoc migration squashes the runner should self-heal before the history
   * guard runs (see {@link CollapsedMigration}). Omit when nothing was squashed.
   */
  collapsedMigrations?: readonly CollapsedMigration[];
  /** Sentinel legacy table proving a pre-runner install (default: "sessions"). */
  legacySentinelTable?: string;
  now?: () => string;
  log?: (message: string) => void;
};

export type MigrationOutcome = {
  /** Migration names recorded as applied via baselining (not executed). */
  readonly baselined: readonly string[];
  /** Migration names actually executed this run. */
  readonly applied: readonly string[];
  /**
   * Superseded migration names whose stale tracking rows were folded into a
   * collapsed genesis this run (rebaselined, not executed). Empty on most runs.
   */
  readonly rebaselined: readonly string[];
};

const TRACKING_TABLE = '"_desktop_migrations"';

const CREATE_TRACKING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
  "name" TEXT PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "applied_at" TEXT NOT NULL
);`;

export async function runDesktopMigrations(
  db: MigrationDb,
  options: RunMigrationsOptions
): Promise<MigrationOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => undefined);
  const sentinel = options.legacySentinelTable ?? "sessions";

  await db.exec(CREATE_TRACKING_TABLE_SQL);

  let applied = await readAppliedMigrations(db);

  let baselined: readonly string[] = [];
  if (applied.size === 0 && (await tableExists(db, sentinel))) {
    baselined = await baselineExistingInstall(db, options, now, log);
    applied = await readAppliedMigrations(db);
  }

  // Self-heal a pre-collapse history BEFORE the forward-compat guard: a DB that
  // recorded a genesis plus every migration later folded into it is rewritten to
  // the collapsed genesis (no DDL), so the changed genesis checksum no longer
  // reads as drift. Re-read the applied set when anything was rebaselined.
  const rebaselined = await reconcileCollapsedMigrations(
    db,
    options.migrations,
    options.collapsedMigrations,
    applied,
    log
  );
  if (rebaselined.length > 0) {
    applied = await readAppliedMigrations(db);
  }

  assertHistoryIsForwardCompatible(applied, options.migrations);

  const appliedNow = await applyPendingMigrations(
    db,
    options.migrations,
    applied,
    now,
    log
  );

  return { baselined, applied: appliedNow, rebaselined };
}

/**
 * Self-heal databases stuck on a pre-collapse migration history (see
 * {@link CollapsedMigration}). For each declared squash, when the DB recorded the
 * genesis AND every superseded migration as applied, the schema is provably at
 * the genesis shape — so rewrite the tracking table to the collapsed genesis in
 * one transaction (drop the superseded rows, advance the genesis checksum to the
 * bundle) WITHOUT running any DDL. Returns the superseded names that were folded.
 *
 * Deliberately conservative — it does nothing (leaving the history guard to act)
 * when:
 *  - the bundle doesn't ship the genesis, or the genesis isn't recorded here;
 *  - no superseded row is recorded (this DB never ran them — its drift, if any,
 *    is unrelated to the squash);
 *  - only SOME superseded rows are recorded (partial history — the fold's other
 *    DDL may be missing, so claiming it applied would risk silent corruption);
 *  - a configured superseded name is somehow still in the bundle (inconsistent
 *    config — dropping its row would make the runner re-execute a live migration).
 */
async function reconcileCollapsedMigrations(
  db: MigrationDb,
  migrations: readonly EmbeddedMigration[],
  collapsed: readonly CollapsedMigration[] | undefined,
  applied: ReadonlyMap<string, string>,
  log: (message: string) => void
): Promise<readonly string[]> {
  if (!collapsed || collapsed.length === 0) {
    return [];
  }
  const byName = new Map(migrations.map((m) => [m.name, m]));
  const rebaselined: string[] = [];
  for (const { genesisName, supersededNames } of collapsed) {
    const genesis = byName.get(genesisName);
    if (!(genesis && applied.has(genesisName))) {
      continue;
    }

    const stillShipped = supersededNames.filter((name) => byName.has(name));
    if (stillShipped.length > 0) {
      log(
        `collapsed-migration reconcile skipped for ${genesisName}: superseded name(s) still in the bundle (${stillShipped.join(", ")})`
      );
      continue;
    }

    const present = supersededNames.filter((name) => applied.has(name));
    if (present.length === 0) {
      continue;
    }
    if (present.length !== supersededNames.length) {
      log(
        `collapsed-migration reconcile skipped for ${genesisName}: partial pre-collapse history (${present.length}/${supersededNames.length} superseded migrations recorded)`
      );
      continue;
    }

    await db.transaction(async (tx) => {
      for (const name of supersededNames) {
        await tx.query(`DELETE FROM ${TRACKING_TABLE} WHERE "name" = $1`, [
          name,
        ]);
      }
      await tx.query(
        `UPDATE ${TRACKING_TABLE} SET "checksum" = $1 WHERE "name" = $2`,
        [genesis.checksum, genesisName]
      );
    });
    rebaselined.push(...supersededNames);
    log(
      `rebaselined ${supersededNames.length} superseded migration(s) into ${genesisName} and advanced its checksum (no DDL executed)`
    );
  }
  return rebaselined;
}

async function readAppliedMigrations(
  db: MigrationDb
): Promise<Map<string, string>> {
  const result = await db.query<{ name: string; checksum: string }>(
    `SELECT "name", "checksum" FROM ${TRACKING_TABLE}`
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function tableExists(
  db: MigrationDb,
  tableName: string
): Promise<boolean> {
  const result = await db.query<{ present: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = $1
     ) AS present`,
    [tableName]
  );
  // SQLite returns 0/1 for EXISTS (no native boolean).
  return result.rows[0]?.present === 1;
}

async function baselineExistingInstall(
  db: MigrationDb,
  options: RunMigrationsOptions,
  now: () => string,
  log: (message: string) => void
): Promise<readonly string[]> {
  const byName = new Map(options.migrations.map((m) => [m.name, m]));
  const appliedAt = now();
  await db.transaction(async (tx) => {
    // Re-assert the frozen legacy DDL once. Idempotent: a no-op on installs
    // already at the cutover shape, and a forward repair on older installs.
    for (const statement of options.baselineStatements) {
      await tx.exec(statement);
    }
    for (const name of options.baselineMigrations) {
      const migration = byName.get(name);
      if (!migration) {
        throw new DesktopMigrationError(
          MigrationRefusalKind.BaselineMissing,
          `Baseline migration "${name}" is missing from the bundled manifest — the build is inconsistent.`
        );
      }
      // Record as applied WITHOUT executing the migration SQL: the legacy
      // install already has this structure. ON CONFLICT guards a crash/retry.
      await tx.query(
        `INSERT INTO ${TRACKING_TABLE} ("name", "checksum", "applied_at")
         VALUES ($1, $2, $3) ON CONFLICT ("name") DO NOTHING`,
        [migration.name, migration.checksum, appliedAt]
      );
    }
  });
  log(
    `baselined existing install: recorded ${options.baselineMigrations.length} migration(s) as applied without executing`
  );
  return [...options.baselineMigrations];
}

/**
 * Refuse on a history the bundle can't honour:
 * - downgrade: the DB recorded a migration this bundle doesn't ship (the app
 *   was downgraded under an upgraded database);
 * - checksum drift: a recorded migration's SQL no longer matches the bundle;
 * - history gap: the applied set is not a contiguous prefix of the bundle (a
 *   later migration is recorded while an earlier one is missing), which would
 *   apply the earlier migration out of order on top of a newer schema.
 * Each implies the bundle and the on-disk DB disagree about history; applying
 * pending migrations on top risks silent corruption, so we stop.
 */
function assertHistoryIsForwardCompatible(
  applied: ReadonlyMap<string, string>,
  migrations: readonly EmbeddedMigration[]
): void {
  const byName = new Map(migrations.map((m) => [m.name, m]));
  for (const [name, checksum] of applied) {
    const migration = byName.get(name);
    if (!migration) {
      throw new DesktopMigrationError(
        MigrationRefusalKind.Downgrade,
        `The local database has migration "${name}", which this version of Closedloop does not include. ` +
          "The database was created by a newer version — please update Closedloop."
      );
    }
    if (migration.checksum !== checksum) {
      throw new DesktopMigrationError(
        MigrationRefusalKind.ChecksumDrift,
        `Migration "${name}" was modified after being applied (recorded checksum ${checksum.slice(0, 12)}, ` +
          `bundled ${migration.checksum.slice(0, 12)}). Refusing to continue to avoid corrupting the local database.`
      );
    }
  }

  // Applied migrations must form a contiguous prefix of the ordered bundle.
  // Once we pass a pending (not-yet-applied) migration, no later migration may
  // already be applied — that gap means a pending earlier migration would run
  // out of order against a newer recorded schema.
  let sawPending = false;
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      if (sawPending) {
        throw new DesktopMigrationError(
          MigrationRefusalKind.HistoryGap,
          `Migration "${migration.name}" is recorded as applied, but an earlier migration in the bundle is not. ` +
            "The local migration history has a gap; refusing to continue to avoid out-of-order application."
        );
      }
    } else {
      sawPending = true;
    }
  }
}

/**
 * True when re-applying a migration failed only because the schema change is
 * already present — the SQLite analogue of `IF NOT EXISTS` for `ADD COLUMN`,
 * which SQLite cannot express in SQL. Treated as a successful no-op heal.
 */
const DUPLICATE_COLUMN_PATTERN = /duplicate column name/i;
function isIdempotentReapplyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DUPLICATE_COLUMN_PATTERN.test(message);
}

const LINE_COMMENT_PATTERN = /--[^\n]*/g;
/**
 * Split a migration into its individual statements for the idempotent-heal retry
 * (so a `duplicate column` on one ALTER cannot skip later statements). Strips
 * line comments and splits on `;`. Desktop migrations are plain DDL — no
 * triggers, and no semicolons inside string literals (asserted by the migration
 * guard tests) — so this split is exact for them.
 */
function splitSqlStatements(sql: string): string[] {
  return sql
    .replace(LINE_COMMENT_PATTERN, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function applyPendingMigrations(
  db: MigrationDb,
  migrations: readonly EmbeddedMigration[],
  applied: ReadonlyMap<string, string>,
  now: () => string,
  log: (message: string) => void
): Promise<readonly string[]> {
  const appliedNow: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }
    // Each migration in its own transaction: a failure mid-migration rolls back
    // wholesale, leaving the DB at the prior version with no tracking row written.
    try {
      await db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query(
          `INSERT INTO ${TRACKING_TABLE} ("name", "checksum", "applied_at")
           VALUES ($1, $2, $3)`,
          [migration.name, migration.checksum, now()]
        );
      });
    } catch (error) {
      if (!isIdempotentReapplyError(error)) {
        throw error;
      }
      // Idempotent heal for an untracked/partial store (tracking wiped but schema
      // already present). SQLite cannot express `ADD COLUMN IF NOT EXISTS`, so a
      // re-applied ADD COLUMN throws `duplicate column name`. The whole-migration
      // attempt above rolled back, so RE-APPLY statement-by-statement, skipping
      // ONLY the statements whose column already exists — every other statement
      // still runs. This guarantees a multi-statement migration can never be
      // recorded as applied while partially applied (the tracking row is written
      // only after the full statement list is processed inside one transaction).
      // CREATE TABLE/INDEX migrations self-heal via their own IF NOT EXISTS and
      // never reach here.
      await db.transaction(async (tx) => {
        for (const statement of splitSqlStatements(migration.sql)) {
          try {
            await tx.exec(statement);
          } catch (statementError) {
            if (!isIdempotentReapplyError(statementError)) {
              throw statementError;
            }
            // Column already present — skip this one, continue the remaining
            // statements so the schema ends fully in sync.
          }
        }
        await tx.query(
          `INSERT INTO ${TRACKING_TABLE} ("name", "checksum", "applied_at")
           VALUES ($1, $2, $3)
           ON CONFLICT ("name") DO NOTHING`,
          [migration.name, migration.checksum, now()]
        );
      });
      log(
        `migration ${migration.name} re-applied idempotently (already present)`
      );
    }
    appliedNow.push(migration.name);
    log(`applied migration ${migration.name}`);
  }
  return appliedNow;
}
