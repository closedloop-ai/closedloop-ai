import {
  rewriteVibeCorpusText,
  VIBE_SEED_SESSION_TITLES,
} from "@repo/api/src/vibe-seed-corpus";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { rewriteInvocationOutbox } from "./invocation-outbox-rewrite";

/**
 * ISS-12135: the vibe store presents the corpus as Acme Co's work. Every text
 * value the importer wrote from the corpus (names, working directories, branch
 * and repository names, commit messages, tool inputs and outputs, metadata
 * JSON) goes through `rewriteVibeCorpusText`, and the sessions get their Acme
 * titles. The rewrite happens here, in the store, because the vibe Desktop
 * syncs this store onto the rows the web seed wrote from it: a rewrite applied
 * only on the web side would be undone by the next Desktop sync.
 *
 * Keys are left alone (a primary key, an `*_id` or `*_key` column) so no row
 * loses its identity or a reference to another row, and so are the tables
 * that hold the product's own catalog or the importer's bookkeeping rather
 * than corpus content. The one exception is a component's name
 * ({@link COMPONENT_NAME_COLUMNS}, and inside the invocation outbox's JSON,
 * `invocation-outbox-rewrite.ts`).
 */

const SKIPPED_TABLES: ReadonlySet<string> = new Set([
  "_desktop_migrations",
  "sqlite_sequence",
  "pack_catalog",
  "pack_catalog_history",
  "pack_install_runs",
  "agent_packs",
  "skills",
  "project_pack_associations",
  "collector_ingest_stores",
  "ingest_batch_resume_cursor",
  "sync_state",
  "transcript_sync_state",
]);
const KEY_COLUMN = /(?:^id|_id|_key)$/;

/**
 * The key columns that carry a component's name (`mcp__closedloop__search`)
 * rather than a row reference. Every component table repeats the name, so all
 * of them are rewritten by the same function and still agree, and the
 * components inventory names a tool the way Insights does: Insights reads the
 * rewritten tool names on the store's events.
 */
const COMPONENT_NAME_COLUMNS: readonly TextColumns[] = [
  { table: "agent_components", columns: ["external_id", "component_key"] },
  { table: "agent_component_versions", columns: ["component_key"] },
  { table: "agent_component_invocations", columns: ["component_key"] },
  { table: "agent_component_session_usage", columns: ["component_key"] },
];

type TextColumns = {
  readonly table: string;
  readonly columns: readonly string[];
};

export type CorpusRewriteResult = {
  readonly valuesRewritten: number;
  readonly sessionsRetitled: number;
};

export async function rewriteStoreCorpus(
  db: SqliteAgentDatabase
): Promise<CorpusRewriteResult> {
  let valuesRewritten = 0;
  for (const { table, columns } of [
    ...(await listRewritableColumns(db)),
    ...COMPONENT_NAME_COLUMNS,
  ]) {
    valuesRewritten += await rewriteTable(db, table, columns);
  }
  valuesRewritten += await rewriteInvocationOutbox(db);
  let sessionsRetitled = 0;
  for (const [id, name] of VIBE_SEED_SESSION_TITLES) {
    const updated = await db.prisma.write((client) =>
      client.session.updateMany({ where: { id }, data: { name } })
    );
    sessionsRetitled += updated.count;
  }
  return { valuesRewritten, sessionsRetitled };
}

async function listRewritableColumns(
  db: SqliteAgentDatabase
): Promise<TextColumns[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { tableName: string; columnName: string; columnType: string; pk: number }[]
  >(
    `SELECT m.name AS tableName, p.name AS columnName, p.type AS columnType, p.pk AS pk
       FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        AND m.sql NOT LIKE '%WITHOUT ROWID%'`
  );
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    if (
      SKIPPED_TABLES.has(row.tableName) ||
      row.columnType.toUpperCase() !== "TEXT" ||
      Number(row.pk) > 0 ||
      KEY_COLUMN.test(row.columnName)
    ) {
      continue;
    }
    byTable.set(row.tableName, [
      ...(byTable.get(row.tableName) ?? []),
      row.columnName,
    ]);
  }
  return [...byTable].map(([table, columns]) => ({ table, columns }));
}

async function rewriteTable(
  db: SqliteAgentDatabase,
  table: string,
  columns: readonly string[]
): Promise<number> {
  const selected = columns.map((column) => `"${column}"`).join(", ");
  const rows = await db.prisma.client.$queryRawUnsafe<
    Record<string, unknown>[]
  >(`SELECT rowid AS "__rowid", ${selected} FROM "${table}"`);
  let rewritten = 0;
  await db.prisma.write(async (client) => {
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value !== "string") {
          continue;
        }
        const next = rewriteVibeCorpusText(value);
        if (next === value) {
          continue;
        }
        await client.$executeRawUnsafe(
          `UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`,
          next,
          row.__rowid
        );
        rewritten += 1;
      }
    }
  });
  return rewritten;
}
