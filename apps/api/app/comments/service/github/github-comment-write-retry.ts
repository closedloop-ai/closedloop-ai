import { log } from "@repo/observability/log";
import {
  getPrismaDriverAdapterSqlState,
  getPrismaErrorCode,
  getPrismaRawQuerySqlState,
} from "@/lib/db-utils";

/** One retry: the per-comment locks make a second collision unlikely. */
export const GITHUB_COMMENT_WRITE_ATTEMPTS = 2;

/**
 * Prisma's unique violation and its write-conflict-or-deadlock rollback, read
 * from `code`, which every adapter sets (the pg adapter leaves `meta.target`
 * unset, ISS-7536).
 */
const RETRYABLE_PRISMA_CODES: ReadonlySet<string> = new Set(["P2002", "P2034"]);
/** unique_violation, deadlock_detected, serialization_failure. */
const RETRYABLE_SQL_STATES: ReadonlySet<string> = new Set([
  "23505",
  "40P01",
  "40001",
]);

/**
 * Runs a GitHub comment write transaction, and runs it once more in a fresh
 * transaction when it rolled back on a unique violation, a deadlock or a
 * serialization failure: two writers racing to create the same row, which the
 * second attempt finds. `write` must open the outermost transaction; inside
 * an ambient one the rolled-back transaction cannot be retried.
 */
export async function withGitHubCommentWriteRetry<T>(
  write: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (
        attempt >= GITHUB_COMMENT_WRITE_ATTEMPTS ||
        !isRetryableGitHubCommentWriteError(error)
      ) {
        throw error;
      }
      log.warn("[comments/github] Retrying a conflicted comment write", {
        attempt,
        code: getPrismaErrorCode(error) ?? null,
      });
    }
  }
}

export function isRetryableGitHubCommentWriteError(error: unknown): boolean {
  const code = getPrismaErrorCode(error);
  if (code !== undefined && RETRYABLE_PRISMA_CODES.has(code)) {
    return true;
  }
  const sqlState =
    getPrismaDriverAdapterSqlState(error) ?? getPrismaRawQuerySqlState(error);
  return sqlState !== undefined && RETRYABLE_SQL_STATES.has(sqlState);
}
