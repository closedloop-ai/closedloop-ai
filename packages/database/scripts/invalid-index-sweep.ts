/**
 * Post-deploy INVALID-index sweep (ISS-4601).
 *
 * WHY: `CREATE INDEX CONCURRENTLY … IF NOT EXISTS` whose build is cancelled or
 * crashes leaves an INVALID index of the same name behind. The failure surfaces
 * as P3018; `migrate-deploy-recovery.ts` resolves the migration rolled back and
 * retries, the retry's `IF NOT EXISTS` no-ops onto the invalid remnant and
 * SUCCEEDS, Prisma records the migration APPLIED, and the deploy goes GREEN. From
 * then on nothing is pending, so `prisma migrate deploy` will never rebuild it —
 * the index exists, is recorded applied, and is permanently unusable. It reads as
 * healthy from every angle except `pg_index.indisvalid`. The migration cannot
 * self-heal (`IF NOT EXISTS` is what makes it idempotent, and an in-file `DO`
 * guard forces Prisma's whole-file transaction wrap → SQLSTATE 25001), and
 * ISS-4565's migration header only documents the check for a human who has no
 * reason to look after a green deploy. This sweep is that check, automated.
 *
 * WHAT: one catalog query against the target schema after `migrate deploy`. It is
 * schema-wide, not migration-scoped — it needs no knowledge of which migration
 * built what, so it also surfaces an invalid index left by a much older migration
 * on prod, which is equally invisible today.
 *
 * WARN, NEVER FAIL — deliberate (the policy call ISS-4601 left open):
 *  - The condition is STICKY. It clears only when an operator runs `DROP INDEX
 *    CONCURRENTLY` + a direct rebuild by hand. A fail-closed sweep would
 *    therefore fail EVERY subsequent deploy on that database until then —
 *    including the deploy carrying the fix — converting a degraded perf index
 *    into a total deploy lockout. That is strictly worse than the bug.
 *  - The sweep is schema-wide, so it can name an index THIS deploy did not
 *    create. Failing a deploy for a pre-existing condition it did not cause is
 *    the wrong blast radius.
 *  - `CONCURRENTLY` exists precisely to avoid availability impact; making its
 *    failure mode a deploy outage inverts the intent.
 *  - Fail-closed is already applied where it IS justified: `preview-plain-index.ts`
 *    throws on an unusable CORRECTNESS index (a unique upsert conflict target).
 *    This sweep is the fail-open complement for everything else.
 * The deploy still stops reporting UNQUALIFIED success: the report below is
 * printed, `migrate.ts` qualifies its terminal line, and the count rides the
 * existing `migrate_deploy` Datadog event so a monitor can alert on it.
 *
 * BEST-EFFORT, AND HONEST ABOUT IT: a sweep that could not run returns `null`
 * ("unknown"), never `[]` ("clean") — an empty array is a claim we would not have
 * earned. Never throws into the deploy.
 *
 * Self-contained (no `@repo/*`): `packages/database` is packaged into `apps/mcp`
 * through a narrow Docker context — same rule as `migrate-telemetry.ts` and
 * `pool-telemetry.ts`. No I/O at module load; the client factory is injected so
 * this is unit-testable without a database.
 */

import { z } from "zod";
import {
  CREATE_INDEX_HEAD_REGEX,
  clampTimeoutMs,
  createSqlClient,
  endQuietly,
  quoteIdentifier,
  type SqlClient,
} from "./db-utils";

/**
 * One row of the sweep, validated at the pg boundary rather than cast.
 *
 * `schema`/`name` are the index's IDENTITY and must be strings — a row without
 * them cannot be reported at all. The other three are DESCRIPTIVE and genuinely
 * nullable at runtime: `pg_get_indexdef` returns NULL (it does not error) for an
 * index dropped between the catalog scan and the function call, which takes
 * `table` and `definition` with it. Typing them non-nullable was a lie the
 * report then printed (`on null`) — so they degrade to `null` and the report
 * says so, per AGENTS.md "never emit a plausible-but-wrong value".
 *
 * `ready` is `pg_index.indisready`: TRUE once the FIRST build pass finished;
 * `indisvalid` only flips true after the SECOND (validation) pass. BOTH remnant
 * states are therefore reachable, and the report labels each — it previously
 * described `ready = false` as "never finished its second pass", which inverts
 * the semantics, and printed no label at all for the ready=true case. Verified
 * against a real Postgres (see the integration suite):
 *   - `ready = TRUE`  — the first pass completed and the build was then
 *     cancelled while waiting for old snapshots, or during validation.
 *   - `ready = false` — the first pass itself never finished. This is what a
 *     `CREATE UNIQUE INDEX CONCURRENTLY` over duplicate keys produces: the
 *     duplicate is detected during that first build scan.
 * Both need the same recovery; this only sharpens the report.
 */
const INVALID_INDEX_ROW_SCHEMA = z.object({
  schema: z.string(),
  name: z.string(),
  table: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  ready: z
    .boolean()
    .nullish()
    .transform((value) => value ?? null),
  definition: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});

/** One index Postgres is carrying but ignoring for query planning. */
export type InvalidIndex = z.infer<typeof INVALID_INDEX_ROW_SCHEMA>;

/**
 * The driver envelope. A result that does not even carry a `rows` array is
 * UNKNOWN, not clean — parsing it as `[]` would claim a verified-clean sweep
 * this run did not earn, so this throws into the caller's catch, which reports
 * `null`.
 */
const SWEEP_RESULT_SCHEMA = z.object({ rows: z.array(z.unknown()) });

type SweepLogger = {
  warn: (message: string) => void;
};

export type InvalidIndexSweepDeps = {
  /** Client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (
    databaseUrl: string,
    opts?: { connectionTimeoutMillis?: number }
  ) => SqlClient;
  logger?: SweepLogger;
  /**
   * Upper bound (ms) on the connect and on the catalog query, threaded from the
   * caller's remaining budget (the FEA-3071 walk's admission deadline) so one
   * blocked sweep cannot overrun it. Omitted → the fixed defaults below.
   */
  budgetMs?: number;
};

// This is the LAST step of a deploy, so an unbounded wait here would not fail the
// build, it would HANG it — the failure mode the "never throws" contract in the
// header does not cover on its own. `pg_get_indexdef` takes AccessShareLock on
// each index, so a concurrent AccessExclusive holder (an operator `DROP INDEX`, an
// `ALTER TABLE`) really can block it, and pg defaults `connectionTimeoutMillis` to
// 0 = wait forever. Both are bounded here. That is NOT the local convention: of
// the siblings in this directory only clone-schema.ts bounds the connect —
// preview-plain-index.ts, migration-lock.ts and preview-at-head.ts bound
// `statement_timeout` alone and leave the connect unbounded.
const SWEEP_CONNECT_TIMEOUT_MS = 15_000;
const SWEEP_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Reads `pg_index` directly. `pg_indexes` cannot answer this: it only proves a
 * same-named relation exists, which an invalid remnant also satisfies.
 * `pg_get_indexdef` still renders a full definition for an invalid index, so the
 * rebuild statement in the report is the real one, not a reconstruction.
 *
 * Three predicates keep IN-FLIGHT work out of the report. Both `CREATE INDEX
 * CONCURRENTLY` and `DROP INDEX CONCURRENTLY` clear `indisvalid` for minutes
 * while they wait for old snapshots to drain, and neither is distinguishable
 * from an abandoned remnant by `indisvalid` alone — so without these the sweep
 * would tell an operator to rebuild an index they are deliberately dropping, and
 * would inflate `invalid_index_count` on the alerting event while doing it:
 *
 *  - `pg_stat_progress_create_index` anti-join → a BUILD running right now. Its
 *    role visibility is best-effort (a role without `pg_read_all_stats` sees only
 *    its own backends), which is why the report also hedges in text.
 *  - `i.indislive` → a DROP that has passed its second phase; the index is no
 *    longer a live catalog object and must not be reported as a remnant.
 *  - the `pg_locks` anti-join → a DROP still in its FIRST phase, which is the
 *    window `indislive` cannot see: `index_drop` clears `indisvalid`, then takes
 *    a session-level ShareUpdateExclusiveLock on the index and waits. A running
 *    CIC takes only RowExclusiveLock on the index, so this predicate is specific
 *    to the drop and does not duplicate the progress view. `pg_locks` is visible
 *    to every role, so it also covers the progress view's blind spot.
 */
export const INVALID_INDEX_SWEEP_SQL = `SELECT n.nspname AS schema, c.relname AS name, t.relname AS "table", i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND NOT i.indisvalid AND i.indislive
    AND NOT EXISTS (
      SELECT 1 FROM pg_stat_progress_create_index p
       WHERE p.index_relid = i.indexrelid
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_locks l
       WHERE l.locktype = 'relation'
         AND l.relation = i.indexrelid
         AND l.mode = 'ShareUpdateExclusiveLock'
         AND l.pid <> pg_backend_pid()
    )
  ORDER BY c.relname`;

/**
 * The schema `prisma migrate deploy` actually targeted — which is NOT always the
 * `schema` argument, and is never reliably `public`.
 *
 * `resolveSchemaName` returns `null` whenever `PGSCHEMA` is unset and the deploy
 * is not a Vercel preview, and `addSchemaToUrl` then leaves `DATABASE_URL`
 * untouched — so Prisma migrates whatever that URL's own `?schema=` names.
 * Defaulting to `public` there would sweep a schema nobody migrated, find
 * nothing, and print "✓ Migrations completed successfully" about it: exactly the
 * false green this module exists to remove.
 *
 * The URL parameter therefore WINS over the argument, mirroring `addSchemaToUrl`,
 * which only sets `schema` when the URL does not already carry one. `public` is
 * the last resort — the real default search path when neither names a schema.
 *
 * Deliberately NOT `SELECT current_schema()`: the raw `pg` driver ignores
 * `?schema=` (it is a Prisma-only parameter), so the sweep's own connection
 * always reports the default search path regardless of what Prisma migrated.
 */
export function resolveSweepSchema(
  databaseUrl: string,
  schema: string | null
): string {
  return readUrlSchemaParam(databaseUrl) ?? schema ?? "public";
}

function readUrlSchemaParam(databaseUrl: string): string | null {
  try {
    const param = new URL(databaseUrl).searchParams.get("schema");
    return param && param.length > 0 ? param : null;
  } catch {
    // An unparseable URL is the connect's problem, not the resolver's.
    return null;
  }
}

/**
 * The concurrency-safe rebuild form of a `pg_get_indexdef` definition — the
 * definition never carries `CONCURRENTLY`, but the rebuild must, or it takes
 * ACCESS EXCLUSIVE on a hot table (ISS-4565 (b)).
 *
 * `pg_get_indexdef` returns NULL rather than erroring for an index dropped
 * between the catalog scan and this call, so `null` is reachable: say so instead
 * of throwing, which would discard every other finding in the batch.
 */
function concurrentRebuildStatement(definition: string | null): string {
  if (definition === null) {
    return "-- definition unavailable (index dropped mid-sweep); re-run the detection query";
  }
  return definition.replace(CREATE_INDEX_HEAD_REGEX, "$1 CONCURRENTLY ");
}

/**
 * Which build pass the remnant died in. `indisready` is TRUE once the FIRST pass
 * finished, so `ready = true` is the CANONICAL case (cancelled during or after
 * validation) and gets a label of its own — before ISS-4601's review it printed
 * nothing at all for the very state the module was written for.
 */
function describeReadyState(ready: boolean | null): string {
  if (ready === null) {
    return "";
  }
  return ready
    ? " (built, but its validation pass never finished)"
    : " (its first build pass never finished)";
}

/** The table name, or an honest stand-in — never the string `null` (AGENTS.md). */
function describeTable(table: string | null): string {
  return table ?? "(table unknown — index dropped mid-sweep)";
}

/**
 * Escapes a value for a single-quoted SQL string literal. `quoteIdentifier`
 * escapes double quotes only, so embedding its result in a `'…'` literal — as the
 * `::regclass` verification line below does — lets an index name containing an
 * apostrophe terminate the literal early and break the operator's pasted recipe
 * AFTER its DROP line has already run.
 */
function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The operator-facing report: every invalid index by name, plus the ISS-4565
 * recovery recipe rendered for that specific index. Pure, so the exact text is
 * asserted in tests rather than eyeballed in a build log.
 *
 * `DROP INDEX CONCURRENTLY` and `CREATE INDEX CONCURRENTLY` cannot run inside a
 * transaction, so BOTH recipes are explicitly psql-autocommit, never a migration.
 */
export function formatInvalidIndexReport(indexes: InvalidIndex[]): string {
  const lines = [
    `⚠️  ${indexes.length} INVALID index(es) found after migrate deploy — Postgres is carrying them but IGNORING them for query planning (ISS-4601).`,
    "   FIRST, confirm no build is in flight — a running `CREATE INDEX CONCURRENTLY` is also indisvalid=false, and dropping it destroys work that was about to finish:",
    "       SELECT * FROM pg_stat_progress_create_index;",
    // This sweep is schema-wide and reads no migration history, so it CANNOT know
    // which of these two cases an index is in. Asserting the first unconditionally
    // (as it did before review) walks an operator whose migration is still pending
    // into a wedged deploy, so the report states both and how to tell them apart.
    "   THEN check whether the index's owning migration is recorded applied — the recovery differs, and guessing wrong wedges the next deploy:",
    "       SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 20;",
    // Ahead of BOTH recipes, because both now emit a CONCURRENTLY statement: an
    // operator reads top-down, and a warning printed below the drop it governs
    // arrives after the paste that already failed with SQLSTATE 25001.
    "   BOTH recovery recipes below are psql in AUTOCOMMIT — no CONCURRENTLY statement may run inside a transaction, so never from a migration file.",
    "   (a) RECORDED APPLIED — the common case: a P3018 retry no-opped `CREATE INDEX CONCURRENTLY … IF NOT EXISTS` onto the remnant. Nothing is pending, so `prisma migrate deploy` will NOT repair it and a re-run is a no-op. Use the per-index recipe below.",
    "   (b) NOT RECORDED APPLIED — the migration is fail-closed (a plain `CREATE INDEX CONCURRENTLY`, no `IF NOT EXISTS`; e.g. 20260722000000_prd536_g7_session_transcript_identity_index). Do NOT hand-rebuild it: drop the remnant and let Prisma rebuild it, or the next deploy hits SQLSTATE 42P07 and stops as `partial_committed_ddl_artifact`:",
    ...lockSafeDropLines("<schema>.<index>"),
    "       then, ONLY once that DROP has succeeded, re-run `prisma migrate deploy`, which rebuilds it CONCURRENTLY. Re-running it over a surviving remnant just hits the 42P07 above again.",
    "   Recipe for case (a), per index:",
  ];
  for (const index of indexes) {
    const qualified = `${quoteIdentifier(index.schema)}.${quoteIdentifier(index.name)}`;
    lines.push(
      `   • ${index.schema}.${index.name} on ${describeTable(index.table)}${describeReadyState(index.ready)}`,
      ...lockSafeDropLines(qualified),
      `       ${concurrentRebuildStatement(index.definition)};`,
      `       SELECT indisvalid FROM pg_index WHERE indexrelid = ${quoteSqlLiteral(qualified)}::regclass;  -- repeat if still false`
    );
  }
  return lines.join("\n");
}

/**
 * The migrate step's terminal line. ISS-4601's first acceptance criterion is that
 * a deploy leaving an invalid index does not report UNQUALIFIED success, so the
 * bare `✓ Migrations completed successfully` is reachable only from a sweep that
 * actually ran and actually found nothing. A sweep that could not run reports
 * UNVERIFIED — it must not borrow the clean wording it did not earn.
 */
export function formatMigrateCompletionLine(
  indexes: InvalidIndex[] | null
): string {
  if (indexes === null) {
    return "⚠️  Migrations completed, but the INVALID-index sweep did not run — index state UNVERIFIED (ISS-4601)";
  }
  if (indexes.length > 0) {
    const named = indexes
      .map((index) => `${index.schema}.${index.name}`)
      .join(", ");
    return `⚠️  Migrations completed, but ${indexes.length} INVALID index(es) remain — NOT a clean deploy (ISS-4601): ${named}`;
  }
  return "✓ Migrations completed successfully";
}

/**
 * Validates the driver result at the boundary instead of casting it. A row that
 * carries no usable identity is dropped (it cannot be named in the report); an
 * envelope with no `rows` array at all throws, so the caller reports UNKNOWN
 * rather than a fabricated "verified clean".
 */
function parseInvalidIndexRows(result: unknown): InvalidIndex[] {
  const envelope = SWEEP_RESULT_SCHEMA.parse(result);
  const indexes: InvalidIndex[] = [];
  for (const row of envelope.rows) {
    const parsed = INVALID_INDEX_ROW_SCHEMA.safeParse(row);
    if (parsed.success) {
      indexes.push(parsed.data);
    }
  }
  return indexes;
}

/**
 * Sweeps `schema` (default `public`) for INVALID indexes and prints the recovery
 * report when any are found. Returns the indexes found, or `null` when the sweep
 * itself could not run — callers must not read `null` as "clean".
 *
 * Never throws: this runs on the deploy critical path and its whole purpose is to
 * ADD a signal, so it must not be able to remove one by failing the deploy.
 */
export async function sweepInvalidIndexes(
  databaseUrl: string,
  schema: string | null,
  deps: InvalidIndexSweepDeps = {}
): Promise<InvalidIndex[] | null> {
  const createClient = deps.createClient ?? createSqlClient;
  const logger = deps.logger ?? { warn: console.warn };
  const target = resolveSweepSchema(databaseUrl, schema);

  let client: SqlClient | null = null;
  try {
    client = createClient(databaseUrl, {
      connectionTimeoutMillis: clampTimeoutMs(
        SWEEP_CONNECT_TIMEOUT_MS,
        deps.budgetMs
      ),
    });
    // ONE deadline, spent once. Clamping both bounds to `budgetMs` independently
    // would let a single sweep consume up to 2× the caller's remaining admission
    // budget (the FEA-3071 walk's), so the query only gets what the connect left.
    const connectStartedAt = Date.now();
    await client.connect();
    const remainingBudgetMs =
      deps.budgetMs === undefined
        ? undefined
        : Math.max(0, deps.budgetMs - (Date.now() - connectStartedAt));
    await client.query(
      `SET statement_timeout = '${clampTimeoutMs(SWEEP_STATEMENT_TIMEOUT_MS, remainingBudgetMs)}ms'`
    );
    const indexes = parseInvalidIndexRows(
      await client.query(INVALID_INDEX_SWEEP_SQL, [target])
    );
    if (indexes.length > 0) {
      logger.warn(formatInvalidIndexReport(indexes));
    }
    return indexes;
  } catch (error) {
    // Unknown, NOT clean. The caller reports it as unchecked rather than green.
    logger.warn(
      `⚠️  Could not sweep ${target} for INVALID indexes (ISS-4601); deploy state UNVERIFIED: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  } finally {
    await endQuietly(client);
  }
}

/**
 * The lock-bounded concurrent drop — the ONLY drop form this report may emit
 * (ISS-6397). Case (b) shipped a plain `DROP INDEX` justified as "an unused
 * invalid index is instant". That is true of EXECUTION and irrelevant: the
 * hazard is lock ACQUISITION. A non-concurrent drop takes ACCESS EXCLUSIVE on
 * the PARENT TABLE, so behind one open transaction holding ACCESS SHARE (an
 * ordinary `SELECT`) it queues — and every subsequent query on that table then
 * queues behind it. Both call sites route through here so a third recipe cannot
 * reintroduce a blocking drop.
 *
 * The `lock_timeout` that makes the drop safe also makes FAILURE an expected
 * outcome, and the remnant survives it — so the timeout line is emitted HERE,
 * beside the statement it qualifies, rather than at either call site. Every step
 * a recipe appends after this one (case (b)'s `migrate deploy`, case (a)'s
 * rebuild) assumes the index is gone and hits SQLSTATE 42P07 when it is not.
 */
function lockSafeDropLines(target: string): string[] {
  return [
    "       SET lock_timeout = '5s';",
    `       DROP INDEX CONCURRENTLY IF EXISTS ${target};`,
    "       -- That DROP can FAIL on lock_timeout after 5s, and the invalid index SURVIVES the failure. Retry it, or confirm the index is gone, before running anything below — the steps below assume it succeeded.",
  ];
}
