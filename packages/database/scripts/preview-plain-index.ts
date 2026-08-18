/**
 * Plain-builds the CONCURRENTLY indexes a preview schema genuinely needs
 * (correctness/unique indexes) WITHOUT `CONCURRENTLY` (ISS-4437).
 *
 * WHY: `CREATE INDEX CONCURRENTLY` waits instance-wide for every open transaction
 * on the shared stage Postgres to drain (twice) before it returns. Under preview
 * fanout, many `preview_*` `migrate deploy`s run at once and their CONCURRENTLY
 * builds deadlock (SQLSTATE 40P01) on Prisma's per-DB migration advisory lock
 * (72707369) → P3018 → a schema reset+replay that holds the FEA-3065 serialize
 * lock for minutes → peer deploys fail open and P1002. A `preview_*` schema is
 * ephemeral and small, so building these indexes PLAIN (transactional) is cheap,
 * while CONCURRENTLY buys zero availability benefit there and is the deadlock
 * cause. The pipeline runs this AFTER the data clone (so a fail-then-retry keeps
 * its data); it is duplicate-safe because `public` enforces the same unique
 * constraint, so the cloned rows never collide on the unique upsert index.
 *
 * A SECOND fail-closed case arrived with the strict UTF-8 decode (ISS-4600): a
 * `migration.sql` whose invalid bytes sit only inside a `--` comment used to parse
 * fine here and produce correct plain builds, and now throws out of
 * `readMigrationSql` — after the data clone, classified as a migrate FAILURE.
 * That is the right call for this module (its indexes are correctness
 * constraints, and a file we cannot read byte-exactly is not one to guess at),
 * and it is LATENT in the pipeline: the prestamp reads the same file first and
 * refuses earlier, with the more actionable message. Noted so the behavior
 * change is not rediscovered from a red deploy.
 *
 * That duplicate-safety premise holds only once the migration has landed on
 * `public`. On the PR that INTRODUCES a new unique-index entry to the list,
 * `public` does not yet enforce it, so cloned rows may genuinely contain
 * duplicates and this plain `CREATE UNIQUE INDEX` fails — loudly and fail-closed,
 * with Postgres's own duplicate-key error. Before ISS-4600 that case never got
 * this far (the prestamp refused earlier, with a more actionable message), so if
 * you add a new UNIQUE entry here, land it on `public` before relying on its
 * branch previews, or preflight the duplicates. Perf-only (non-unique) additions
 * are unaffected.
 *
 * HOW: the migrations named by PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS are
 * pre-stamped as applied (see preview-prestamp.ts) so `migrate deploy` skips their
 * CONCURRENTLY build; this helper then rebuilds their indexes plain over a raw pg
 * connection (no advisory lock), `CONCURRENTLY` stripped and `IF NOT EXISTS`
 * forced (idempotent). Runs on EVERY preview deploy (not gated on the at-head
 * probe): the probe reads only `_prisma_migrations` names, not real indexes, so a
 * schema whose earlier build failed would otherwise report at-head and stay broken
 * forever. Cheap no-op when the indexes already exist.
 *
 * FAIL-CLOSED: unlike the perf-index pre-stamp (fail-open — a missing perf index
 * only costs a seq scan), these indexes are correctness constraints (upsert
 * conflict targets the runtime + backfill `ON CONFLICT` depend on). After building
 * we VERIFY each index via `pg_index` (valid, ready, unique-for-unique, right key
 * columns) and THROW if any is unusable, so a build failure fails the deploy
 * loudly instead of silently marking the migration applied with the index absent.
 *
 * No I/O at module load; the pg client and SQL source are injected so this is
 * unit-testable without a database or the real migrations tree. Sibling-lib
 * pattern, see preview-prestamp.ts.
 */

import {
  CREATE_INDEX_HEAD_REGEX,
  clampTimeoutMs,
  createSqlClient,
  readMigrationSql as defaultReadMigrationSql,
  endQuietly,
  quoteIdentifier,
  type SqlClient,
} from "./db-utils";
import { PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS } from "./preview-heavy-migrations";
import { isPreviewSchema } from "./preview-schema";

const SQL_LINE_COMMENT_REGEX = /--[^\n]*/g;
const SQL_BLOCK_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
// A statement that starts a `CREATE [UNIQUE] INDEX CONCURRENTLY ...` build.
const CONCURRENT_INDEX_STATEMENT_REGEX =
  /^create\s+(?:unique\s+)?index\s+concurrently\b/i;
// The UNIQUE variant — its plain build must land a UNIQUE index (the upsert
// conflict target the runtime ON CONFLICT depends on), so we verify indisunique.
const CONCURRENT_UNIQUE_INDEX_STATEMENT_REGEX =
  /^create\s+unique\s+index\s+concurrently\b/i;
// Captures the quoted index name from such a statement.
const CONCURRENT_INDEX_NAME_REGEX =
  /^create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?"([^"]+)"/i;
// The `CONCURRENTLY` keyword to strip (with its leading whitespace).
const CONCURRENTLY_KEYWORD_REGEX = /\s+concurrently\b/i;
const IF_NOT_EXISTS_REGEX = /\bif\s+not\s+exists\b/i;
// Every double-quoted identifier in a statement — in a CREATE INDEX these are, in
// order, [index name, table name, ...key columns], so the columns are the rest.
const QUOTED_IDENTIFIER_REGEX = /"([^"]+)"/g;
// Captures the key-column list from a `pg_get_indexdef` string — the group after
// `USING <method> (...)`, e.g. `USING btree (organization_id, entity_type)`. Used
// so the column check reads the ACTUAL indexed columns, not tokens that also
// happen to appear in the (column-derived) index name.
const INDEXDEF_COLUMNS_REGEX = /using\s+\w+\s*\(([^)]*)\)/i;
const COLUMN_LEADING_TOKEN_REGEX = /\s+/;

type PlainIndexLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export type PlainIndexDeps = {
  /** Client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (databaseUrl: string) => SqlClient;
  /** Reads a migration's `migration.sql`; defaults to the on-disk read. Injected in tests. */
  readMigrationSql?: (migrationName: string) => string;
  logger?: PlainIndexLogger;
  /**
   * Upper bound (ms) on the lock acquire + each build, threaded from the caller's
   * remaining budget (the migrator walk's admission deadline) so one slow/blocked
   * build cannot run past it and stall the schemas queued behind it. Omitted →
   * the fixed defaults. Floored so it can never become `0` (which in Postgres
   * DISABLES the timeout).
   */
  budgetMs?: number;
};

/** One plain (CONCURRENTLY-stripped) index build derived from a migration statement. */
export type PlainIndexBuild = {
  /** The index name, verified valid + ready after the build. */
  name: string;
  /** The executable plain DDL (`CONCURRENTLY` removed, `IF NOT EXISTS` forced). */
  sql: string;
  /** True for `CREATE UNIQUE INDEX` — verified `indisunique` after the build. */
  unique: boolean;
  /** The key column identifiers — verified present in the built index's definition. */
  columns: string[];
};

/** Per-index state read back from `pg_index`/`pg_get_indexdef` for the verify. */
type IndexValidityRow = {
  name: string;
  valid: boolean;
  ready: boolean;
  unique: boolean;
  /** `pg_get_indexdef` output — compared against the expected key columns. */
  def: string;
};

/**
 * Parses the `CREATE [UNIQUE] INDEX CONCURRENTLY` statements out of a migration's
 * SQL and returns their plain (CONCURRENTLY-stripped, IF NOT EXISTS-forced) form,
 * index name, and uniqueness. Comments are stripped first.
 *
 * FAIL-CLOSED on shape: a plain-build migration's contract is "pure CONCURRENTLY
 * index builds only". Any OTHER executable fragment (a table/column/data change,
 * a DROP/ALTER, anything non-index) THROWS — because the whole migration is
 * pre-stamped as applied on preview, silently dropping such a fragment would skip
 * that shape change and diverge the preview from `public`. Also throws if a
 * CONCURRENTLY-index statement's name cannot be parsed. Pure; unit-testable.
 */
export function parsePlainIndexBuilds(sql: string): PlainIndexBuild[] {
  const code = sql
    .replace(SQL_BLOCK_COMMENT_REGEX, " ")
    .replace(SQL_LINE_COMMENT_REGEX, " ");
  const builds: PlainIndexBuild[] = [];
  for (const fragment of code.split(";")) {
    const statement = fragment.trim();
    if (statement.length === 0) {
      continue;
    }
    if (!CONCURRENT_INDEX_STATEMENT_REGEX.test(statement)) {
      throw new Error(
        `preview-plain-index: a plain-build migration may contain only CREATE [UNIQUE] INDEX CONCURRENTLY statements; got: ${statement.slice(0, 80)}`
      );
    }
    const nameMatch = statement.match(CONCURRENT_INDEX_NAME_REGEX);
    if (!nameMatch) {
      throw new Error(
        `preview-plain-index: cannot parse index name from statement: ${statement.slice(0, 80)}`
      );
    }
    const plainNoConcurrently = statement.replace(
      CONCURRENTLY_KEYWORD_REGEX,
      " "
    );
    const plain = IF_NOT_EXISTS_REGEX.test(plainNoConcurrently)
      ? plainNoConcurrently
      : plainNoConcurrently.replace(
          CREATE_INDEX_HEAD_REGEX,
          "$1 IF NOT EXISTS "
        );
    const identifiers = [...statement.matchAll(QUOTED_IDENTIFIER_REGEX)].map(
      (m) => m[1]
    );
    builds.push({
      name: nameMatch[1],
      sql: plain,
      unique: CONCURRENT_UNIQUE_INDEX_STATEMENT_REGEX.test(statement),
      // [0]=index name, [1]=table name, rest = key columns.
      columns: identifiers.slice(2),
    });
  }
  return builds;
}

function parseIndexValidityRows(
  result: unknown
): Map<string, IndexValidityRow> {
  const rows = (result as { rows?: IndexValidityRow[] } | null)?.rows ?? [];
  const byName = new Map<string, IndexValidityRow>();
  for (const row of rows) {
    if (typeof row.name === "string") {
      byName.set(row.name, row);
    }
  }
  return byName;
}

// Distinct advisory-lock namespace — NOT Prisma's migrate lock 72707369, NOT the
// FEA-3065 serialize gate 30650000 — so the per-schema plain-build lock never
// contends with the migrate gate. Second key = hashtext(schema): same schema
// serializes (no CREATE INDEX catalog-write race between two same-branch deploys),
// other schemas run free. A rare hashtext collision only over-serializes; it never
// mis-scopes correctness.
const PLAIN_INDEX_LOCK_NAMESPACE = 72_707_370;

// Bounded waits so the plain-build can never hang: unlike the migrate serialize
// gate (which sets statement_timeout before acquiring), the per-schema advisory
// lock here would otherwise wait forever on a stalled same-schema holder. A
// timeout fails the deploy CLOSED (throws → retried) rather than hanging — which
// especially protects the migrator walk's admission budget. `statement_timeout`
// also caps the `pg_advisory_lock` SELECT itself and each index build.
const PLAIN_INDEX_LOCK_TIMEOUT_MS = 30_000;
const PLAIN_INDEX_STATEMENT_TIMEOUT_MS = 120_000;

// Reads real index state from pg_index — NOT pg_indexes, which only proves a
// same-named relation exists. An INVALID/not-ready index left by an interrupted
// prior CONCURRENTLY build passes a name check yet is unusable by ON CONFLICT.
// `pg_get_indexdef` lets us also catch a same-named index on the WRONG columns.
const INDEX_VALIDITY_SQL = `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS "unique", pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`;

/**
 * The key-column identifiers of a `pg_get_indexdef` string (the `USING <method>
 * (...)` group), leading token of each comma-separated item so an opclass suffix
 * is ignored. Empty when the shape is unrecognized.
 */
function indexKeyColumns(def: string): string[] {
  const match = def.match(INDEXDEF_COLUMNS_REGEX);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((item) => item.trim().split(COLUMN_LEADING_TOKEN_REGEX)[0])
    .filter((token) => token.length > 0);
}

/**
 * True when an existing same-named index matches the intended build: same
 * uniqueness AND every expected key column is in the index's ACTUAL key-column
 * list (parsed from `pg_get_indexdef`, NOT a substring scan of the whole def —
 * these index names are column-derived, so a naive `def.includes(col)` would
 * always match). Catches a missing/renamed column, the realistic drift.
 */
function indexDefinitionMatches(
  build: PlainIndexBuild,
  row: IndexValidityRow
): boolean {
  if (build.unique !== row.unique) {
    return false;
  }
  const actual = new Set(indexKeyColumns(row.def));
  return build.columns.every((column) => actual.has(column));
}

/**
 * Drops any same-named index that already exists but is INVALID/not-ready (an
 * interrupted prior CONCURRENTLY build) OR whose definition (uniqueness/columns)
 * does not match the intended build, so the plain `CREATE ... IF NOT EXISTS` below
 * rebuilds it instead of no-op-ing onto an unusable or wrong index.
 */
async function dropUnusablePreviewIndexes(
  client: SqlClient,
  schema: string,
  builds: PlainIndexBuild[]
): Promise<void> {
  const existing = parseIndexValidityRows(
    await client.query(INDEX_VALIDITY_SQL, [schema, builds.map((b) => b.name)])
  );
  for (const build of builds) {
    const row = existing.get(build.name);
    if (
      row &&
      !(row.valid && row.ready && indexDefinitionMatches(build, row))
    ) {
      await client.query(
        `DROP INDEX IF EXISTS ${quoteIdentifier(schema)}.${quoteIdentifier(build.name)}`
      );
    }
  }
}

/** Returns per-index reasons the built indexes are not usable (empty = all good). */
function collectIndexProblems(
  builds: PlainIndexBuild[],
  byName: Map<string, IndexValidityRow>
): string[] {
  const problems: string[] = [];
  for (const build of builds) {
    const row = byName.get(build.name);
    if (!row) {
      problems.push(`${build.name} (missing)`);
    } else if (!row.valid) {
      problems.push(`${build.name} (invalid)`);
    } else if (!row.ready) {
      problems.push(`${build.name} (not ready)`);
    } else if (build.unique && !row.unique) {
      problems.push(`${build.name} (not unique)`);
    } else if (!indexDefinitionMatches(build, row)) {
      problems.push(`${build.name} (definition mismatch)`);
    }
  }
  return problems;
}

/**
 * Builds the plain (non-CONCURRENTLY) form of every index declared by the
 * PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS on `schema`, then verifies each
 * landed VALID, READY, and (for UNIQUE builds) UNIQUE via `pg_index`. No-op for
 * `public`/null. Serialized per-schema (advisory lock) so concurrent same-branch
 * deploys don't race the catalog writes. FAIL-CLOSED: a build error or any
 * unusable index throws, so a deploy never proceeds with the correctness/upsert
 * index silently absent or invalid.
 */
export async function plainBuildPreviewConcurrentIndexes(
  databaseUrl: string,
  schema: string | null,
  deps: PlainIndexDeps = {}
): Promise<void> {
  if (!(schema && isPreviewSchema(schema))) {
    return;
  }

  const createClient = deps.createClient ?? createSqlClient;
  const readMigrationSql = deps.readMigrationSql ?? defaultReadMigrationSql;
  const logger = deps.logger ?? { log: console.log, warn: console.warn };

  const builds = PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS.flatMap(
    (migrationName) => parsePlainIndexBuilds(readMigrationSql(migrationName))
  );
  if (builds.length === 0) {
    return;
  }
  const expectedNames = builds.map((b) => b.name);

  // Client created inside the try so a synchronous factory/URL-parse throw is
  // still surfaced (fail-closed) with the connection cleaned up. The session-level
  // advisory lock releases automatically when the connection closes below.
  let client: SqlClient | null = null;
  try {
    client = createClient(databaseUrl);
    await client.connect();
    // Raw pg.Client ignores `?schema=`, so target the preview schema explicitly.
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    // Bound every wait so this can never hang (the advisory-lock acquire and each
    // index build): a timeout fails CLOSED (throws → deploy retried) rather than
    // blocking a peer deploy or the walk forever. Capped at the caller's remaining
    // budget so one slow build can't overrun the walk's admission deadline.
    const lockTimeoutMs = clampTimeoutMs(
      PLAIN_INDEX_LOCK_TIMEOUT_MS,
      deps.budgetMs
    );
    const statementTimeoutMs = clampTimeoutMs(
      PLAIN_INDEX_STATEMENT_TIMEOUT_MS,
      deps.budgetMs
    );
    await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET statement_timeout = '${statementTimeoutMs}ms'`);
    // Per-schema serialization: a sibling holds it only for this fast build+verify;
    // a crashed holder's session lock auto-releases, and lock_timeout bounds the wait.
    await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [
      PLAIN_INDEX_LOCK_NAMESPACE,
      schema,
    ]);
    await dropUnusablePreviewIndexes(client, schema, builds);
    for (const build of builds) {
      await client.query(build.sql);
    }
    const byName = parseIndexValidityRows(
      await client.query(INDEX_VALIDITY_SQL, [schema, expectedNames])
    );
    const problems = collectIndexProblems(builds, byName);
    if (problems.length > 0) {
      throw new Error(
        `preview-plain-index: index(es) not usable on ${schema} after plain build: ${problems.join(", ")}`
      );
    }
    logger.log(
      `↪ Plain-built ${expectedNames.length} preview index(es) on ${schema} (CONCURRENTLY stripped, ISS-4437): ${expectedNames.join(", ")}`
    );
  } finally {
    await endQuietly(client);
  }
}
