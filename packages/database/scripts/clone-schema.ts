import type pg from "pg";
import { createSslClient, quoteIdentifier } from "./db-utils";

const CLONE_SKIP_TABLES = new Set([
  "_prisma_migrations",
  "preview_schemas",
  "preview_schemas_observations",
]);

/**
 * Bounds a single clone statement. The clone is the only step in the migrate
 * pipeline that copies unbounded data, and before ISS-5285 it ran with no
 * timeout at all: a stalled `INSERT ... SELECT` blocked until Vercel killed the
 * whole build ~45 minutes later, emitting no error and no partial progress.
 * Generous by default (a real clone of a large `public` is minutes, not
 * seconds); override with CLONE_STATEMENT_TIMEOUT_MS.
 */
export const DEFAULT_CLONE_STATEMENT_TIMEOUT_MS = 600_000;

/**
 * Bounds how long a clone statement waits on a *lock* specifically. Much
 * tighter than the statement budget: waiting on a lock means `public` is
 * concurrently holding DDL (an api-stage deploy migrating the same tables), and
 * the clone is fail-soft, so giving up quickly and leaving the schema empty is
 * strictly better than stacking behind that DDL. Override with
 * CLONE_LOCK_TIMEOUT_MS.
 */
export const DEFAULT_CLONE_LOCK_TIMEOUT_MS = 60_000;

/**
 * Bounds the CONNECT. The SQL timeouts above only start applying once a session
 * exists, and pg defaults `connectionTimeoutMillis` to `0` (wait forever), so a
 * blackholed endpoint would still hang the build outside every other bound.
 * Override with CLONE_CONNECT_TIMEOUT_MS.
 */
export const DEFAULT_CLONE_CONNECT_TIMEOUT_MS = 30_000;

/**
 * One table's columns, in ordinal order, scoped through `pg_catalog`.
 *
 * ISS-5285: this replaces two `information_schema.columns` reads per table
 * (once for the target schema, once for `public`) — see `getTablesInFkOrder`
 * for why that view's cost scales with the instance's total schema count
 * rather than the one schema asked about. `$1` is the schema, `$2` the table.
 *
 * `is_enum` / `enum_type` drive the enum cast below. `pg_type.typtype = 'e'` is
 * strictly more precise than `information_schema`'s `data_type =
 * 'USER-DEFINED'`, which also covers composites and domains — neither of which
 * the `::text::<schema>.<type>` round-trip would be correct for.
 *
 * An ARRAY of an enum needs the same bridge, and neither catalog spells it out
 * directly: the column's own `pg_type` row is the array wrapper (`typtype =
 * 'b'`), so the enum-ness lives one hop away through `typelem`. `information_
 * schema` is no better here — it reports `data_type = 'ARRAY'` with `udt_name =
 * '_CustomFieldEntityType'` — which is why `custom_fields.entity_types`
 * (`CustomFieldEntityType[]`) was never cast, before this change or after the
 * first draft of it. The LEFT JOIN resolves the element type so an array of an
 * enum bridges through `text[]`.
 *
 * `attgenerated` / `attidentity` are the raw flags the `information_schema`
 * `is_generated` / `is_identity` columns are derived from, and they preserve
 * the ALWAYS-vs-BY-DEFAULT distinction that `is_identity` flattens away.
 */
const COLUMNS_SQL = `SELECT
     a.attname AS column_name,
     (t.typtype = 'e') AS is_enum,
     (el.typtype = 'e') AS is_enum_array,
     CASE WHEN el.typtype = 'e' THEN el.typname ELSE t.typname END AS enum_type,
     a.attgenerated AS generated,
     a.attidentity AS identity
   FROM pg_catalog.pg_attribute a
   JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
   JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
   LEFT JOIN pg_catalog.pg_type el ON el.oid = t.typelem
   WHERE c.relnamespace = to_regnamespace($1)
     AND c.relname = $2
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum`;

type ColInfo = {
  column_name: string;
  /** The column's own type is an enum. */
  is_enum: boolean;
  /** The column is an ARRAY whose ELEMENT type is an enum. */
  is_enum_array: boolean;
  /** The enum type name to cast to — the element type for an enum array. */
  enum_type: string;
  /** `pg_attribute.attgenerated`: `'s'` = STORED generated, `''` = ordinary. */
  generated: string;
  /** `pg_attribute.attidentity`: `'a'` = ALWAYS, `'d'` = BY DEFAULT, `''` = none. */
  identity: string;
};

export type CloneDeps = {
  createClient?: (
    databaseUrl: string,
    opts?: { connectionTimeoutMillis?: number }
  ) => pg.Client;
  logger?: Pick<Console, "log" | "warn" | "error">;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

/**
 * Lists `public`'s base tables, scoped through `pg_catalog` by namespace OID.
 *
 * ISS-5285: this used to read `information_schema.tables`. Every
 * `information_schema` view is defined over the WHOLE catalog with per-row
 * privilege checks applied before the caller's `table_schema` filter can prune
 * anything, so its cost scales with the total number of schemas on the
 * instance, not with the one schema being asked about. Preview schemas
 * accumulate (387 → 464 in a day, ~+75/day from per-SHA merge-queue schemas),
 * which turned this lookup from ~2 minutes into never-returning. Scoping by
 * `relnamespace` is an index lookup and is independent of the schema count.
 */
async function getTablesInFkOrder(
  client: pg.Client,
  logger: Pick<Console, "warn">
): Promise<string[]> {
  const { rows: tables } = await client.query(
    `SELECT c.relname AS table_name
     FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
     ORDER BY c.relname`
  );

  const allTables: string[] = tables
    .map((r: { table_name: string }) => r.table_name)
    .filter((name: string) => !CLONE_SKIP_TABLES.has(name));

  // Build dependency graph: child -> set of parent tables.
  //
  // ISS-5285: `information_schema.constraint_column_usage` was the single worst
  // offender here — it is the most expensive view in `information_schema` (it
  // joins pg_constraint against pg_attribute/pg_class across every schema and
  // filters by privilege per row). `pg_constraint` carries both sides of a
  // foreign key as OIDs (`conrelid` → child, `confrelid` → parent), so the same
  // answer is one namespace-scoped scan with no cross-schema work.
  // Scope BOTH endpoints explicitly. `connamespace` happens to equal the child
  // table's namespace for a table constraint, but saying so directly is what
  // makes the edge set provably the one the topological sort needs.
  const { rows: fks } = await client.query(
    `SELECT child.relname AS child, parent.relname AS parent
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
     JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
     WHERE con.contype = 'f'
       AND child.relnamespace = 'public'::regnamespace
       AND parent.relnamespace = 'public'::regnamespace`
  );

  const deps = new Map<string, Set<string>>();
  for (const table of allTables) {
    deps.set(table, new Set());
  }
  // An edge whose endpoints aren't both in the clone set cannot constrain the
  // order, so it is dropped — but it is dropped LOUDLY. A silently-missing edge
  // is exactly how a child gets cloned before its parent and the whole clone
  // dies on a foreign-key violation, which is unreadable after the fact.
  const droppedEdges: string[] = [];
  for (const { child, parent } of fks as { child: string; parent: string }[]) {
    if (child === parent) {
      continue;
    }
    if (deps.has(child) && deps.has(parent)) {
      deps.get(child)?.add(parent);
    } else {
      droppedEdges.push(`${child}->${parent}`);
    }
  }
  if (droppedEdges.length > 0) {
    logger.warn(
      `  ⚠️  ${droppedEdges.length} FK edge(s) outside the clone set, ordering not constrained by them: ${droppedEdges.join(", ")}`
    );
  }

  // Topological sort (Kahn's algorithm)
  const ordered: string[] = [];
  const remaining = new Map(deps);
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, parents]) => [...parents].every((p) => !remaining.has(p)))
      .map(([name]) => name);

    if (ready.length === 0) {
      // Circular dependency: no order can satisfy every FK, so the remainder
      // goes out in name order and some INSERT may fail. Say so — this is the
      // other way a clone dies on a foreign-key violation.
      const cyclic = [...remaining.keys()].sort();
      logger.warn(
        `  ⚠️  FK cycle among ${cyclic.length} table(s); cloning them in name order, FK violations possible: ${cyclic.join(", ")}`
      );
      ordered.push(...cyclic);
      break;
    }
    ready.sort();
    for (const name of ready) {
      remaining.delete(name);
      ordered.push(name);
    }
  }

  return ordered;
}

/**
 * Clones every table's data from `public` into `schema` (FK-topological order,
 * enum-aware casts). Fail-soft: on error it logs and swallows so a migrate never
 * fails on a bad clone. Returns `true` on a clean clone, `false` when the clone
 * was attempted but failed (schema left empty/partial) — callers that reset a
 * schema use this to avoid treating a failed restore as a success.
 *
 * ISS-5285: the connection is opened INSIDE the try. It used to be opened
 * outside, so a connect failure — exactly what an expired RDS IAM token produces
 * after a long-running earlier step — escaped this function un-swallowed,
 * defeating the fail-soft contract above, and leaked the client because the
 * `finally` that ends it belonged to the try it never entered.
 */
export async function cloneDataFromPublic(
  databaseUrl: string,
  schema: string,
  deps: CloneDeps = {}
): Promise<boolean> {
  const logger = deps.logger ?? console;
  const createClient = deps.createClient ?? createSslClient;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  logger.log(`↪ Cloning data from public schema into ${schema}...`);
  const startedAt = now();
  let client: pg.Client | undefined;
  try {
    client = createClient(databaseUrl, {
      connectionTimeoutMillis: resolveCloneConnectTimeoutMs(env, logger),
    });
    await client.connect();

    // Bound every statement below BEFORE issuing any of them, so a stalled
    // catalog query or INSERT surfaces as a swallowed clone failure in seconds
    // rather than a silent 45-minute build. Mirrors preview-plain-index.ts.
    await client.query(
      `SET lock_timeout = '${resolveCloneLockTimeoutMs(env, logger)}ms'`
    );
    await client.query(
      `SET statement_timeout = '${resolveCloneStatementTimeoutMs(env, logger)}ms'`
    );

    const tableNames = await getTablesInFkOrder(client, logger);

    if (tableNames.length === 0) {
      logger.log("  No tables to clone.");
      return true;
    }

    const quoted = quoteIdentifier(schema);

    await client.query("BEGIN");
    try {
      const { rows: targetFks } = await client.query(
        `SELECT table_rel.relname AS table_name, con.conname AS constraint_name
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class table_rel ON table_rel.oid = con.conrelid
         WHERE con.contype = 'f'
           AND table_rel.relnamespace = to_regnamespace($1)
           AND NOT con.condeferrable
         ORDER BY table_rel.relname, con.conname`,
        [schema]
      );
      for (const { table_name, constraint_name } of targetFks as {
        table_name: string;
        constraint_name: string;
      }[]) {
        await client.query(
          `ALTER TABLE ${quoted}.${quoteIdentifier(table_name)} ALTER CONSTRAINT ${quoteIdentifier(constraint_name)} DEFERRABLE INITIALLY IMMEDIATE`
        );
      }
      await client.query("SET CONSTRAINTS ALL DEFERRED");

      for (const table of tableNames) {
        const quotedTable = quoteIdentifier(table);
        // Query column names from both schemas and only clone columns that exist in both.
        // This handles cases where migrations add new columns to the target schema
        // that don't exist yet in the public (source) schema.
        const { rows: targetCols } = await client.query(COLUMNS_SQL, [
          schema,
          table,
        ]);
        if (targetCols.length === 0) {
          logger.warn(`  ${table}: skipped (missing in target schema)`);
          continue;
        }
        const { rows: sourceCols } = await client.query(COLUMNS_SQL, [
          "public",
          table,
        ]);
        const sourceColSet = new Set(
          sourceCols.map((c: { column_name: string }) => c.column_name)
        );
        // Only clone columns that exist in both source and target, and that the
        // server does not compute for itself. Filtering the TARGET column list is
        // what matters and is sufficient: the INSERT list and the SELECT list are
        // both derived from it below.
        const cols = (targetCols as ColInfo[]).filter(
          (c) => sourceColSet.has(c.column_name) && isCloneableColumn(c)
        );
        if (cols.length === 0) {
          logger.warn(`  ${table}: skipped (no overlapping columns)`);
          continue;
        }
        const insertCols = cols
          .map((c: ColInfo) => quoteIdentifier(c.column_name))
          .join(", ");
        // Enums are schema-scoped types, so bridge them through text. An array of
        // an enum bridges through `text[]` to the target schema's element type.
        const selectCols = cols
          .map((c: ColInfo) => {
            const col = quoteIdentifier(c.column_name);
            const enumType = `${quoted}.${quoteIdentifier(c.enum_type)}`;
            if (c.is_enum) {
              return `${col}::text::${enumType}`;
            }
            if (c.is_enum_array) {
              return `${col}::text[]::${enumType}[]`;
            }
            return col;
          })
          .join(", ");
        const tableStartedAt = now();
        const { rowCount } = await client.query(
          `INSERT INTO ${quoted}.${quotedTable} (${insertCols}) SELECT ${selectCols} FROM "public".${quotedTable}`
        );
        logger.log(
          `  ${table}: ${rowCount ?? 0} rows (${now() - tableStartedAt}ms)`
        );
      }
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const { table_name, constraint_name } of targetFks as {
        table_name: string;
        constraint_name: string;
      }[]) {
        await client.query(
          `ALTER TABLE ${quoted}.${quoteIdentifier(table_name)} ALTER CONSTRAINT ${quoteIdentifier(constraint_name)} NOT DEFERRABLE`
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // Preserve the original clone failure for the fail-soft log below.
      });
      throw error;
    }

    logger.log(
      `✓ Cloned ${tableNames.length} tables into ${schema} (${now() - startedAt}ms)`
    );
    return true;
  } catch (error) {
    logger.error(
      `⚠️  Data clone failed after ${now() - startedAt}ms (schema will start empty): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  } finally {
    // `client` is undefined only if createClient itself threw. `end()` on a
    // client whose `connect()` failed is what releases the half-open socket, and
    // it must not turn a swallowed clone failure into a thrown one.
    if (client) {
      await client.end().catch(() => {
        // Intentionally ignored — see above.
      });
    }
  }
}

/**
 * A column is cloneable unless Postgres refuses an explicit value for it.
 *
 * Two cases, and only two:
 *  - `attgenerated = 's'` — a `GENERATED ALWAYS AS (...) STORED` column.
 *    Postgres rejects any explicit value ("cannot insert a non-DEFAULT value
 *    into column"), which aborts the whole clone.
 *    `search_documents.tsv` (FEA-3857, migration 20260723030000) is this case,
 *    and is why every preview clone has failed since 2026-07-23.
 *  - `attidentity = 'a'` — `GENERATED ALWAYS AS IDENTITY`, likewise rejected
 *    without `OVERRIDING SYSTEM VALUE`.
 *
 * `attidentity = 'd'` (`GENERATED BY DEFAULT AS IDENTITY`) is deliberately NOT
 * excluded: Postgres accepts an explicit value for it, and dropping it would
 * silently re-number the cloned rows — which, for an identity primary key,
 * breaks every foreign key pointing at the original value. `information_schema`
 * cannot express this distinction (`is_identity` is `'YES'` for both), which is
 * one more reason this reads `pg_attribute` directly.
 */
export function isCloneableColumn(col: {
  generated: string;
  identity: string;
}): boolean {
  return col.generated !== "s" && col.identity !== "a";
}

function resolveCloneStatementTimeoutMs(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "warn">
): number {
  return resolvePositiveIntEnv(
    "CLONE_STATEMENT_TIMEOUT_MS",
    env.CLONE_STATEMENT_TIMEOUT_MS,
    DEFAULT_CLONE_STATEMENT_TIMEOUT_MS,
    logger
  );
}

function resolveCloneConnectTimeoutMs(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "warn">
): number {
  return resolvePositiveIntEnv(
    "CLONE_CONNECT_TIMEOUT_MS",
    env.CLONE_CONNECT_TIMEOUT_MS,
    DEFAULT_CLONE_CONNECT_TIMEOUT_MS,
    logger
  );
}

function resolveCloneLockTimeoutMs(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "warn">
): number {
  return resolvePositiveIntEnv(
    "CLONE_LOCK_TIMEOUT_MS",
    env.CLONE_LOCK_TIMEOUT_MS,
    DEFAULT_CLONE_LOCK_TIMEOUT_MS,
    logger
  );
}

/**
 * Parses a positive-integer ms override, falling back to `fallback`. An
 * unparseable value is REPORTED rather than silently swallowed: a typo'd
 * timeout that quietly reverts to the default is exactly the kind of
 * "misconfiguration that looks like it worked" this fix exists to make visible.
 */
function resolvePositiveIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  logger: Pick<Console, "warn">
): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  logger.warn(
    `⚠️  Ignoring invalid ${name}="${raw}" (want a positive number of ms); using ${fallback}ms.`
  );
  return fallback;
}
