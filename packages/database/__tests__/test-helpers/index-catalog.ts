/**
 * Shared `pg_index` catalog reader for migration integration suites.
 *
 * A parsed `migration.sql` pins the shape somebody WROTE; this asks Postgres
 * what it actually BUILT, which is a different question — nothing else in the
 * repo executes that DDL, because the API-side suites replace the store with a
 * fake Prisma client and an index changes plan choice rather than results. A
 * migration whose statement never ran, or ran and left an INVALID index, ships
 * green everywhere else.
 *
 * Extracted from `iss9618-cloud-routine-sweep-indexes.integration.test.ts` when
 * ISS-9671 needed the identical query. Every new index migration owes a focused
 * test (`packages/database/AGENTS.md`), so this will keep getting reused, and a
 * second hand-rolled copy is how two suites end up disagreeing about what
 * "the index exists" means.
 */

import type { PrismaClient } from "../../generated/client";

export type IndexCatalogRow = {
  indexdef: string;
  indisvalid: boolean;
  indisunique: boolean;
};

/** Minimal surface these helpers need, so callers can pass an ephemeral ctx. */
type QueryableContext = {
  prisma: Pick<PrismaClient, "$queryRawUnsafe">;
};

const INDEX_CATALOG_QUERY = `SELECT pg_get_indexdef(i.indexrelid) AS indexdef,
            i.indisvalid,
            i.indisunique
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = $1
        AND c.relname = $2`;

/**
 * The one catalog row for `indexName` on `table`, or an error naming it.
 *
 * Throws rather than asserting: every assertion a caller makes reads vacuously —
 * or crashes on `undefined` with an unhelpful message — against a missing index,
 * and naming the absent index is what makes a `CREATE INDEX` statement that
 * never ran legible in the failure.
 */
export async function indexCatalogRow(
  ctx: QueryableContext,
  table: string,
  indexName: string
): Promise<IndexCatalogRow> {
  const rows = await ctx.prisma.$queryRawUnsafe<IndexCatalogRow[]>(
    INDEX_CATALOG_QUERY,
    table,
    indexName
  );
  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one "${indexName}" index on "${table}", found ${rows.length}. Did its migration's CREATE INDEX statement survive, and did migrate deploy run against this database?`
    );
  }
  return rows[0];
}
