/**
 * @file schema-snapshot.ts
 * @description Shared structural-introspection helper for the desktop Prisma
 * schema guards (baseline equivalence + migrations/schema agreement). Captures
 * everything that defines the shape of the SQLite schema: tables, columns
 * (type/nullability/default), index definitions, and foreign keys.
 *
 * Foreign keys are compared so the consolidated hand-written SQLite DDL can't
 * silently drop or drift an FK relative to schema.prisma while the guard still
 * passes (the SQLite collapse carries no CHECK constraints, so FKs are the
 * remaining table-level constraint to verify).
 *
 * Post SQLite migration: introspection reads the SQLite catalog
 * (`sqlite_master` + `pragma_table_info` + `pragma_foreign_key_list`) over a
 * libSQL handle rather than the Postgres `information_schema`/`pg_*` catalogs
 * SQLite exposed.
 */
import type { SqliteExecutor } from "../../src/main/database/libsql-executor.js";

export type SchemaSnapshot = {
  tables: string[];
  columns: Record<string, unknown>[];
  indexes: Record<string, unknown>[];
  foreignKeys: Record<string, unknown>[];
};

// PSL cannot express partial / expression indexes; the prior Postgres guard
// excluded them from the schema↔migrations comparison. SQLite's collapsed
// 0001_init no longer carries the Postgres-only CHECK constraints or the
// COALESCE expression index, so this set is currently empty but is retained as
// the exclusion seam for any future hand-carried index.
const PSL_INEXPRESSIBLE_INDEXES = new Set<string>([]);

export async function snapshotSchema(
  db: SqliteExecutor
): Promise<SchemaSnapshot> {
  const tableRows = await db.query<{ name: string }>(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> '_desktop_migrations'
     ORDER BY name`
  );
  const tables = tableRows.rows.map((row) => row.name);

  const columns: Record<string, unknown>[] = [];
  for (const tableName of tables) {
    const info = await db.query<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>('SELECT name, type, "notnull", dflt_value FROM pragma_table_info($1)', [
      tableName,
    ]);
    const sorted = [...info.rows].sort((a, b) => a.name.localeCompare(b.name));
    for (const col of sorted) {
      columns.push({
        table_name: tableName,
        column_name: col.name,
        data_type: col.type,
        is_nullable: col.notnull === 0 ? "YES" : "NO",
        column_default: col.dflt_value ?? null,
      });
    }
  }

  // The auto-created index for a unique/primary key shows up as
  // `sqlite_autoindex_*`; compare only the named indexes the DDL declares.
  const indexRows = await db.query<{ name: string; sql: string | null }>(
    `SELECT name, sql
     FROM sqlite_master
     WHERE type = 'index'
       AND name NOT LIKE 'sqlite_autoindex_%'
     ORDER BY name`
  );
  const indexes = indexRows.rows.map((row) => ({
    indexname: row.name,
    indexdef: normalizeSql(row.sql),
  }));

  const foreignKeys: Record<string, unknown>[] = [];
  for (const tableName of tables) {
    const fkInfo = await db.query<{
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>(
      'SELECT "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list($1)',
      [tableName]
    );
    for (const fk of fkInfo.rows) {
      foreignKeys.push({
        table_name: tableName,
        column_name: fk.from,
        referenced_table: fk.table,
        referenced_column: fk.to,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
        match: fk.match,
      });
    }
  }
  // Order-independent: pragma row order isn't a schema property.
  foreignKeys.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );

  return { tables, columns, indexes, foreignKeys };
}

/**
 * Expression / partial indexes that PSL cannot express are hand-carried in
 * migration SQL. Guards comparing schema.prisma output against migration output
 * must exclude them; fidelity of the hand-carried artifacts is covered by
 * focused migration source tests.
 */
export function withoutPslInexpressibleArtifacts(
  snapshot: SchemaSnapshot
): SchemaSnapshot {
  return {
    ...snapshot,
    indexes: snapshot.indexes.filter(
      (row) => !PSL_INEXPRESSIBLE_INDEXES.has(String(row.indexname))
    ),
  };
}

/** Collapse whitespace in index DDL so cosmetic formatting never causes drift. */
function normalizeSql(sql: string | null): string {
  if (!sql) {
    return "";
  }
  return sql.replace(/\s+/g, " ").trim();
}
