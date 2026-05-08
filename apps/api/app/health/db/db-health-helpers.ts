import { createHash, timingSafeEqual } from "node:crypto";

export type CheckResult = {
  status: "ok" | "error";
  latencyMs?: number;
  total?: number;
  pending?: number;
  count?: number;
  note?: string;
  error?: string;
};

export const GENERIC_ERRORS = {
  connectivity: "db_connectivity_check_failed",
  migrations: "db_migration_check_failed",
  tables: "db_table_count_check_failed",
} as const;

export function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("does not exist") &&
    normalized.includes("_prisma_migrations")
  );
}

export function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) {
    return false;
  }

  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();

  const actualDigest = digest(actual);
  const expectedDigest = digest(expected);
  return timingSafeEqual(actualDigest, expectedDigest);
}
