/**
 * Shared raw-SQL transaction-double helpers for the branch materialization
 * retry lane (`branch-materialization-retry-*.test.ts`, ISS-11280). Every one
 * of those suites drives a `TransactionClient` double through `$queryRaw`/
 * `$executeRaw` and needs the same three things: a typed stand-in for the
 * `Prisma.Sql` shape, a way to pick a specific bound call out of the mock's
 * call history, and a single cast point for the double's `TransactionClient`
 * shape. Four sibling files had each re-declared their own copy before this
 * extraction; keeping one copy means the four suites can't drift on what a
 * "matching" query call looks like.
 */
import type { TransactionClient } from "@repo/database";

export type SqlLike = {
  sql: string;
  values: unknown[];
};

/** The first recorded call to `mock` whose composed SQL contains `marker`. */
export function findQuery(
  mock: { mock: { calls: unknown[][] } },
  marker: string
): SqlLike | undefined {
  return mock.mock.calls
    .map((call) => call[0] as SqlLike)
    .find((query) => query.sql.includes(marker));
}

/** Every recorded call to `mock` whose composed SQL contains `marker`. */
export function findAllQueries(
  mock: { mock: { calls: unknown[][] } },
  marker: string
): SqlLike[] {
  return mock.mock.calls
    .map((call) => call[0] as SqlLike)
    .filter((query) => query.sql.includes(marker));
}

export function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Every retry function under test takes the same `TransactionClient` first argument. */
export function asRetryTx(tx: unknown): TransactionClient {
  return tx as unknown as TransactionClient;
}
