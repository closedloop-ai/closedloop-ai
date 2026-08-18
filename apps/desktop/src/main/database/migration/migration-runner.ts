/**
 * @file migration-runner.ts
 * @description Forward-only migration runner for the desktop SQLite store,
 * modelled on `prisma migrate deploy`.
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
} from "../../lifecycle/migration-refusal.js";

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

  assertHistoryIsForwardCompatible(
    applied,
    options.migrations,
    options.collapsedMigrations
  );

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
 *
 * ISS-6169: each class is resolved COMPLETELY and in a stable order rather than
 * by throwing on the first offending row. `applied` arrives in SQLite's physical
 * row order — `readAppliedMigrations` reads the tracking table with no ORDER BY,
 * and because it selects `checksum` (outside the name-only covering index) the
 * planner runs a plain table SCAN, so rows come back in rowid/insertion order.
 * That order is not stable across installs or even across runs on one machine:
 * rebaselining deletes and re-inserts tracking rows, and a repack renumbers
 * them. Reporting the first miss therefore made the verdict a function of row
 * order rather than of the history, so one downgraded install named a different
 * migration on consecutive launches and never revealed how many were unknown.
 *
 * Each class takes the stable key it actually has. A migration the bundle SHIPS
 * carries the bundle's own application order, so drift is reported in that
 * order; name order is NOT a substitute, because
 * `20260619220000_add_genai_prices_pricing_source` is mapped by
 * `scripts/migration-order.mjs` onto its legacy `0004` slot, and sorting by name
 * would strand it behind every `00NN_` migration that ran after it. A migration
 * the bundle does NOT ship has no bundle position to preserve, so lexicographic
 * order is the only stable key available for the downgrade verdict.
 *
 * When a history trips BOTH drift and downgrade, the tiebreak turns on where the
 * unknown names came from — because neither signal is decisive alone.
 *
 * A merged migration is NEARLY immutable, and the sanctioned exception is a
 * declared squash ({@link CollapsedMigration}, e.g. `COLLAPSED_MIGRATIONS` in
 * `baseline-schema.ts`, where FEA-2038 kept the `0001_init` NAME and gave it a
 * NEW checksum). So drift does NOT prove the store is not ahead: a store created
 * by a build that collapsed its genesis reads as drift against every bundle that
 * predates the collapse, including bundles it is genuinely ahead of. Symmetrically,
 * an unknown name does not prove ahead-ness either — a squash leaves orphaned
 * superseded rows on stores that are BEHIND.
 *
 * What DOES discriminate is whether a declared squash explains the unknown name.
 * A recorded migration that is not in the bundle AND is not one of the names this
 * bundle declares superseded is positive evidence the store came from a newer
 * build — no squash this bundle knows about could have produced it — so
 * `Downgrade` wins and the drift is carried into the message instead of being
 * discarded. When every unknown name IS a declared superseded row, the history is
 * the pre/partial-collapse shape and drift wins, keeping the update prompt away
 * from stores that are actually behind.
 *
 * Whoever declares the NEXT collapse inherits this: the tiebreak reads
 * `collapsedMigrations`, so a squash must be declared here for its orphans to be
 * recognized as orphans rather than as evidence the store is ahead.
 */
function assertHistoryIsForwardCompatible(
  applied: ReadonlyMap<string, string>,
  migrations: readonly EmbeddedMigration[],
  collapsed: readonly CollapsedMigration[] | undefined
): void {
  const bundledNames = new Set(migrations.map((m) => m.name));

  // Walking the bundle IS the application order, so the earliest divergence —
  // the one `describeDriftedMigrations` gives the checksum pair to — is reported
  // first without needing a comparator here.
  const drifted = migrations.flatMap((migration) => {
    const recorded = applied.get(migration.name);
    if (recorded === undefined || recorded === migration.checksum) {
      return [];
    }
    return [{ name: migration.name, recorded, bundled: migration.checksum }];
  });

  const unknown = [...applied.keys()]
    .filter((name) => !bundledNames.has(name))
    .sort();
  // An unknown name that no declared squash accounts for cannot be a squash
  // orphan, so it is positive evidence the store came from a newer build.
  const supersededNames = new Set(
    (collapsed ?? []).flatMap((entry) => entry.supersededNames)
  );
  const unexplained = unknown.filter((name) => !supersededNames.has(name));

  if (unexplained.length > 0) {
    throw new DesktopMigrationError(
      MigrationRefusalKind.Downgrade,
      describeUnknownMigrations(unknown, drifted)
    );
  }
  if (drifted.length > 0) {
    throw new DesktopMigrationError(
      MigrationRefusalKind.ChecksumDrift,
      describeDriftedMigrations(drifted)
    );
  }
  if (unknown.length > 0) {
    throw new DesktopMigrationError(
      MigrationRefusalKind.Downgrade,
      describeUnknownMigrations(unknown, [])
    );
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

const DUPLICATE_COLUMN_PATTERN = /duplicate column name/i;
const NO_SUCH_COLUMN_PATTERN = /no such column/i;
const DROP_COLUMN_STATEMENT_PATTERN = /\bDROP\s+COLUMN\b/i;

/**
 * The GATE for entering the statement-by-statement heal: the whole-migration
 * re-apply failed with an error that MIGHT only mean "already applied". SQLite
 * can express neither `ADD COLUMN IF NOT EXISTS` (fails `duplicate column name`)
 * nor `DROP COLUMN IF EXISTS` (fails `no such column`), so both are candidates.
 *
 * Deliberately looser than {@link isAlreadyAppliedStatement}: this only decides
 * whether to RETRY per-statement, and that retry re-throws anything it cannot
 * actually attribute to an already-applied change. A `no such column` raised for
 * some other reason therefore still surfaces — just one transaction later.
 */
function isIdempotentReapplyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    DUPLICATE_COLUMN_PATTERN.test(message) ||
    NO_SUCH_COLUMN_PATTERN.test(message)
  );
}

/**
 * True when THIS statement failed only because its schema change is already
 * present — or because the history itself later removes what it references — so
 * skipping it heals the store instead of hiding a defect.
 *
 * `no such column` is tolerated in exactly two cases:
 *
 *  1. On a `DROP COLUMN` statement: the column is already gone.
 *  2. On ANY statement naming a column that a LATER migration in this same
 *     manifest drops (`laterDroppedColumns`). Re-applying the whole history
 *     against a store that already carries the FINAL schema runs the earlier
 *     migration against a table the later one has already narrowed — so
 *     `0001_init`'s `CREATE INDEX … ON artifacts(enrichment_state)` and
 *     `0011`'s `UPDATE … WHERE enrichment_state = 'final'` both fail on a store
 *     that has run the drop. The end state the earlier statement was reaching
 *     for is superseded by a migration that has already run, so skipping it is
 *     the only outcome that converges.
 *
 * The tolerance is keyed on the COLUMN NAME, not on `table.column`: SQLite's
 * `no such column: <name>` does not name the table, and inferring it would mean
 * parsing the table out of arbitrary DDL and DML — where a parse MISS denies
 * tolerance and refuses boot, the exact failure this heal exists to prevent. The
 * narrowing that makes a bare name safe is an invariant on the manifest instead:
 * no two migrations may drop the same column name from different tables, which
 * `migration-manifest-drop-uniqueness.test.ts` enforces. Within that invariant a
 * name identifies one column, so a genuine typo, or a reference to a column
 * nothing drops, still surfaces.
 *
 * Everywhere else `no such column` means the migration references a column that
 * genuinely is not there — a real, unrecoverable defect — and swallowing it
 * would record the migration as applied over a schema that never received it.
 */
function isAlreadyAppliedStatement(
  statement: string,
  error: unknown,
  laterDroppedColumns: ReadonlySet<string>
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (DUPLICATE_COLUMN_PATTERN.test(message)) {
    return true;
  }
  if (!NO_SUCH_COLUMN_PATTERN.test(message)) {
    return false;
  }
  if (DROP_COLUMN_STATEMENT_PATTERN.test(statement)) {
    return true;
  }
  const missing = MISSING_COLUMN_NAME_PATTERN.exec(message)?.[1];
  return missing !== undefined && laterDroppedColumns.has(missing);
}

/**
 * The column name SQLite names in `no such column: <name>`. Qualified forms
 * (`a.enrichment_state`) keep only the trailing identifier, which is what
 * {@link collectDroppedColumns} records.
 */
const MISSING_COLUMN_NAME_PATTERN = /no such column:\s*"?(?:[\w"]+\.)?"?(\w+)/i;

/** Every column dropped by an `ALTER TABLE … DROP COLUMN` in this SQL. */
const DROP_COLUMN_TARGET_PATTERN =
  /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi;

function collectDroppedColumns(sql: string): string[] {
  const dropped: string[] = [];
  for (const match of sql.matchAll(DROP_COLUMN_TARGET_PATTERN)) {
    dropped.push(match[1]);
  }
  return dropped;
}

/**
 * For each migration index, the columns dropped by any migration AFTER it.
 * Built once per run so the per-statement heal can tell "this column is gone
 * because the history removes it" from "this column never existed".
 */
function buildLaterDroppedColumns(
  migrations: readonly EmbeddedMigration[]
): ReadonlySet<string>[] {
  const suffix: ReadonlySet<string>[] = new Array(migrations.length);
  let accumulated = new Set<string>();
  for (let index = migrations.length - 1; index >= 0; index--) {
    suffix[index] = accumulated;
    const dropped = collectDroppedColumns(migrations[index].sql);
    if (dropped.length > 0) {
      accumulated = new Set([...accumulated, ...dropped]);
    }
  }
  return suffix;
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
  const laterDroppedColumns = buildLaterDroppedColumns(migrations);
  for (const [index, migration] of migrations.entries()) {
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
      // re-applied ADD COLUMN throws `duplicate column name`, and a re-applied
      // DROP COLUMN throws `no such column`. The whole-migration attempt above
      // rolled back, so RE-APPLY statement-by-statement, skipping ONLY the
      // statements whose change is already present — every other statement
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
            if (
              !isAlreadyAppliedStatement(
                statement,
                statementError,
                laterDroppedColumns[index]
              )
            ) {
              throw statementError;
            }
            // Change already present — skip this one, continue the remaining
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

/** A recorded migration whose bundled SQL no longer matches what was applied. */
type DriftedMigration = {
  readonly name: string;
  readonly recorded: string;
  readonly bundled: string;
};

/** Render a stably-ordered migration-name list for a refusal message. */
function quoteNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * ISS-6169: the COMPLETE, stably-ordered downgrade verdict. Naming every unknown
 * migration (not just the first row SQLite happened to return) is what makes the
 * message reproducible across launches and lets a reader see how far ahead the
 * store actually is. Log/diagnostic surface only — the user-facing copy and the
 * telemetry projection are fixed strings built from the refusal KIND
 * (`userFacingMigrationRefusal`), so migration names never reach either.
 *
 * `alsoDrifted` carries the drift signal when a history trips both classes.
 * Downgrade is the verdict there (see `assertHistoryIsForwardCompatible`), and
 * the drift is what points a reader at the squash in the newer build, so it is
 * appended rather than dropped on the floor.
 */
function describeUnknownMigrations(
  names: readonly string[],
  alsoDrifted: readonly DriftedMigration[]
): string {
  const subject =
    names.length === 1
      ? `migration ${quoteNames(names)}`
      : `${names.length} migrations this version of Closedloop does not include: ${quoteNames(names)}`;
  const clause =
    names.length === 1
      ? `${subject}, which this version of Closedloop does not include.`
      : `${subject}.`;
  const drift =
    alsoDrifted.length === 0
      ? ""
      : ` ${alsoDrifted.length} recorded migration(s) also no longer match this build's SQL (${quoteNames(alsoDrifted.map((entry) => entry.name))}), which a migration squash in that newer build would explain.`;
  return `The local database has ${clause}${drift} The database was created by a newer version — please update Closedloop.`;
}

/**
 * ISS-6169: the COMPLETE checksum-drift verdict, in the bundle's application
 * order. Every drifted name is listed; the checksum PAIR is shown for the first
 * one only, since one worked example is enough to diagnose a drift and repeating
 * it per migration says nothing new. That makes the caller's ordering
 * load-bearing rather than cosmetic: `drifted[0]` must be the EARLIEST diverging
 * migration, because a later one is as likely to be a consequence as a cause.
 * Log/diagnostic surface only, same as the downgrade twin.
 */
function describeDriftedMigrations(
  drifted: readonly DriftedMigration[]
): string {
  const names = drifted.map((entry) => entry.name);
  const [first] = drifted;
  const detail =
    drifted.length === 1
      ? `Migration ${quoteNames(names)} was modified after being applied`
      : `${drifted.length} migrations were modified after being applied (${quoteNames(names)}); the first of them, "${first.name}",`;
  return `${detail} (recorded checksum ${first.recorded.slice(0, 12)}, bundled ${first.bundled.slice(0, 12)}). Refusing to continue to avoid corrupting the local database.`;
}
