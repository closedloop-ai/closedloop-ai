import { Prisma, withDb } from "@repo/database";

export type AppliedMigrationRow = {
  name: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
};

type MigrationRecord = {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
};

/**
 * ISS-11782/ISS-11783: what `prisma migrate deploy` has recorded on the schema
 * this function serves. Every row is returned, failed and rolled-back ones
 * included, because the callers' question is whether each migration directory
 * of a SHA was applied, and a row with no `finished_at` or a `rolled_back_at`
 * answers it "no". Named `public` rather than left to the connection's
 * search_path: the stage gate asks about `public`, never a preview schema.
 */
export const appliedMigrationsService = {
  async list(): Promise<AppliedMigrationRow[]> {
    const rows = await withDb((db) =>
      db.$queryRaw<MigrationRecord[]>(Prisma.sql`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "public"."_prisma_migrations"
        ORDER BY migration_name
      `)
    );
    return rows.map((row) => ({
      name: row.migration_name,
      finishedAt: toIso(row.finished_at),
      rolledBackAt: toIso(row.rolled_back_at),
    }));
  },
};

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}
