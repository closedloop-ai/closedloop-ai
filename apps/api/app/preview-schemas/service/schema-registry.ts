import { Prisma, withDb } from "@repo/database";

/**
 * Reads `public.preview_schemas` for a given schema name.
 *
 * Returns `{ registryRow, registryTableMissing }` for use with
 * `categorizeSchema()`. SQLSTATE 42P01 (undefined_table) indicates the
 * registry table is absent; schemas are classified without a row
 * in that edge case. Any other error is rethrown so the caller can skip the
 * schema rather than misclassify it.
 *
 * The `branch` column is included so the branch-aware pass can cross-reference
 * against live GitHub branches without a second query.
 */
export async function readRegistryRow(schemaName: string): Promise<{
  registryRow: { lastSeenAt: Date; branch: string | null } | null;
  registryTableMissing: boolean;
}> {
  try {
    const rows = await withDb((db) =>
      db.$queryRaw<{ last_seen_at: string; branch: string | null }[]>(
        Prisma.sql`
          SELECT last_seen_at, branch
          FROM public.preview_schemas
          WHERE schema_name = ${schemaName}
          ORDER BY last_seen_at DESC
          LIMIT 1
        `
      )
    );

    if (rows.length === 0) {
      return { registryRow: null, registryTableMissing: false };
    }

    return {
      registryRow: {
        lastSeenAt: new Date(rows[0].last_seen_at),
        branch: rows[0].branch ?? null,
      },
      registryTableMissing: false,
    };
  } catch (err) {
    // SQLSTATE 42P01 = undefined_table
    if ((err as { code?: string }).code === "42P01") {
      return { registryRow: null, registryTableMissing: true };
    }
    throw err;
  }
}

/**
 * Lists all schemas in `pg_namespace` whose names start with `preview_`.
 */
export async function listPreviewSchemas(): Promise<string[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ nspname: string }[]>(Prisma.sql`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname LIKE 'preview_%'
      ORDER BY nspname
    `)
  );
  return rows.map((r) => r.nspname);
}
