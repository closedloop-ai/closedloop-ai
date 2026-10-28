import { Prisma, type TransactionClient, withDb } from "@repo/database";
import {
  olderThanReconcileFreshnessFloorSql,
  reconcileLeaseIsFreeSql,
} from "./github-comment-reconcile";

/** What a read needs to know about a pull request's last comment reconciles. */
export type PullRequestCommentsReconcileMarker = {
  /** The last complete reconcile; `null` when none ever completed. */
  reconciledAt: Date | null;
  /**
   * The latest reconcile attempt did not complete, and no run holds the lease:
   * it was claimed after the last complete reconcile (or none completed), and
   * the lease is free again (Kerensa, 2026-10-05: such a pull request's comments
   * are stale). A partial run never stamps `reconciledAt`, so it counts here.
   */
  latestAttemptFailed: boolean;
  /**
   * No reconcile was attempted within the freshness floor the cron's due scan
   * holds a pull request to, so a read may start one.
   */
  attemptDue: boolean;
};

export async function readPullRequestCommentsReconcileMarker(
  organizationId: string,
  pullRequestDetailId: string
): Promise<PullRequestCommentsReconcileMarker | null> {
  const rows = await withDb((db) =>
    db.$queryRaw<PullRequestCommentsReconcileMarker[]>(Prisma.sql`
      SELECT
        "comments_reconciled_at" AS "reconciledAt",
        ${latestAttemptFailedSql()} AS "latestAttemptFailed",
        ${olderThanReconcileFreshnessFloorSql(Prisma.raw('"comments_reconcile_attempted_at"'))} AS "attemptDue"
      FROM "pull_request_detail"
      WHERE "id" = ${pullRequestDetailId}::uuid
        AND "organization_id" = ${organizationId}::uuid
    `)
  );
  return rows[0] ?? null;
}

/**
 * Of these pull requests, the ones whose latest reconcile attempt failed, as
 * {@link PullRequestCommentsReconcileMarker.latestAttemptFailed} decides it.
 */
export async function readPullRequestsWithFailedLatestAttempt(
  db: Pick<TransactionClient, "$queryRaw">,
  organizationId: string,
  pullRequestDetailIds: readonly string[]
): Promise<ReadonlySet<string>> {
  if (pullRequestDetailIds.length === 0) {
    return new Set();
  }
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "pull_request_detail"
    WHERE "id" = ANY(${[...pullRequestDetailIds]}::uuid[])
      AND "organization_id" = ${organizationId}::uuid
      AND ${latestAttemptFailedSql()}
  `);
  return new Set(rows.map((row) => row.id));
}

function latestAttemptFailedSql(): Prisma.Sql {
  return Prisma.sql`(
    "comments_reconcile_attempted_at" IS NOT NULL
    AND (
      "comments_reconciled_at" IS NULL
      OR "comments_reconcile_attempted_at" > "comments_reconciled_at"
    )
    AND ${reconcileLeaseIsFreeSql(Prisma.raw('"comments_reconcile_claimed_at"'))}
  )`;
}
