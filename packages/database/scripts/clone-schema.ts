import type pg from "pg";
import { createSslClient, quoteIdentifier } from "./db-utils";

const CLONE_SKIP_TABLES = new Set(["_prisma_migrations", "preview_schemas"]);

type ColInfo = {
  column_name: string;
  data_type: string;
  udt_name: string;
};

/**
 * Returns table names from `public` in topological order (parents before children)
 * so that inserts respect FK constraints without needing superuser privileges.
 */
async function getTablesInFkOrder(client: pg.Client): Promise<string[]> {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );

  const allTables: string[] = tables
    .map((r: { table_name: string }) => r.table_name)
    .filter((name: string) => !CLONE_SKIP_TABLES.has(name));

  // Build dependency graph: child -> set of parent tables
  const { rows: fks } = await client.query(
    `SELECT
       tc.table_name AS child,
       ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
       AND tc.constraint_schema = ccu.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'`
  );

  const deps = new Map<string, Set<string>>();
  for (const table of allTables) {
    deps.set(table, new Set());
  }
  for (const { child, parent } of fks as { child: string; parent: string }[]) {
    if (child !== parent && deps.has(child) && deps.has(parent)) {
      deps.get(child)!.add(parent);
    }
  }

  // Topological sort (Kahn's algorithm)
  const ordered: string[] = [];
  const remaining = new Map(deps);
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, parents]) => [...parents].every((p) => !remaining.has(p)))
      .map(([name]) => name);

    if (ready.length === 0) {
      // Circular dependency — append whatever is left
      ordered.push(...remaining.keys());
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

export async function cloneDataFromPublic(databaseUrl: string, schema: string) {
  console.log(`↪ Cloning data from public schema into ${schema}...`);
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const tableNames = await getTablesInFkOrder(client);

    if (tableNames.length === 0) {
      console.log("  No tables to clone.");
      return;
    }

    const quoted = quoteIdentifier(schema);

    for (const table of tableNames) {
      const quotedTable = quoteIdentifier(table);
      // Query column names from both schemas and only clone columns that exist in both.
      // This handles cases where migrations add new columns to the target schema
      // that don't exist yet in the public (source) schema.
      const { rows: targetCols } = await client.query(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table]
      );
      if (targetCols.length === 0) {
        console.warn(`  ${table}: skipped (missing in target schema)`);
        continue;
      }
      const { rows: sourceCols } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const sourceColSet = new Set(
        sourceCols.map((c: { column_name: string }) => c.column_name)
      );
      // Only clone columns that exist in both source and target
      const cols = (targetCols as ColInfo[]).filter((c) =>
        sourceColSet.has(c.column_name)
      );
      if (cols.length === 0) {
        console.warn(`  ${table}: skipped (no overlapping columns)`);
        continue;
      }
      const insertCols = cols
        .map((c: ColInfo) => quoteIdentifier(c.column_name))
        .join(", ");
      // For USER-DEFINED types (enums), cast through text to bridge schema-scoped types
      const selectCols = cols
        .map((c: ColInfo) => {
          const col = quoteIdentifier(c.column_name);
          if (c.data_type === "USER-DEFINED") {
            return `${col}::text::${quoted}.${quoteIdentifier(c.udt_name)}`;
          }
          return col;
        })
        .join(", ");
      const { rowCount } = await client.query(
        `INSERT INTO ${quoted}.${quotedTable} (${insertCols}) SELECT ${selectCols} FROM "public".${quotedTable}`
      );
      console.log(`  ${table}: ${rowCount ?? 0} rows`);
    }

    console.log(`✓ Cloned ${tableNames.length} tables into ${schema}`);
  } catch (error) {
    console.error(
      "⚠️  Data clone failed (schema will start empty):",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await client.end();
  }
}
