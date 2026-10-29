import { Prisma, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  GitHubCommentReconcileStatus,
  olderThanReconcileFreshnessFloorSql,
  reconcileLeaseIsFreeSql,
  reconcilePullRequestComments,
} from "@/app/comments/service/github/github-comment-reconcile";
import { mapWithDbConcurrency } from "@/lib/db-fanout";

/** PLN-2122 Step 5: due pull requests reconciled per cron run. */
export const RECONCILE_PR_COMMENTS_BATCH = 25;

export const RECONCILE_PR_COMMENTS_RUN_EVENT = "comments.reconcile_run";

/** A pull request whose reconcile threw: isolated, counted, and logged. */
const RECONCILE_FAILED = "failed";

export const PullRequestCommentReconcileRunStatus = {
  Ok: "ok",
  /** A pull request's reconcile threw or hit a provider error. */
  Degraded: "degraded",
} as const;
export type PullRequestCommentReconcileRunStatus =
  (typeof PullRequestCommentReconcileRunStatus)[keyof typeof PullRequestCommentReconcileRunStatus];

export type PullRequestCommentReconcileRunSummary = {
  event: typeof RECONCILE_PR_COMMENTS_RUN_EVENT;
  status: PullRequestCommentReconcileRunStatus;
  due: number;
  /**
   * Eligible pull requests never reconciled, or last reconciled before the
   * freshness floor, when the run ends. Leased and backing-off ones count.
   */
  overdue: number;
  reconciled: number;
  partial: number;
  claimedElsewhere: number;
  providerErrors: number;
  failed: number;
  appliedEvents: number;
  signals: number;
  reasons: string[];
};

const LOG_PREFIX = "[reconcile-pr-comments]";

/**
 * The current-PR rule the comment webhooks check
 * (`isBranchCurrentPullRequest`), in SQL: a branch with no current-PR pointer
 * accepts its PRs.
 */
const ELIGIBLE_PULL_REQUEST_SQL = Prisma.sql`
  pr."pr_state" = 'OPEN'
  AND pr."repository_full_name" IS NOT NULL
  AND (
    b."current_pull_request_detail_id" IS NULL
    OR b."current_pull_request_detail_id" = pr."id"
  )
`;

/**
 * One cron run: up to `RECONCILE_PR_COMMENTS_BATCH` due open pull requests
 * that are current for their branch, never-attempted ones first and then the
 * least recently attempted, each reconciled with its failure isolated from the
 * others.
 */
export async function runPullRequestCommentReconcile(): Promise<PullRequestCommentReconcileRunSummary> {
  const due = await selectDuePullRequests(RECONCILE_PR_COMMENTS_BATCH);
  const outcomes = await mapWithDbConcurrency(
    due,
    async (pullRequestDetailId) => {
      try {
        return await reconcilePullRequestComments({ pullRequestDetailId });
      } catch (error) {
        log.warn(`${LOG_PREFIX} pull request reconcile failed`, {
          pullRequestDetailId,
          error: parseError(error),
        });
        return RECONCILE_FAILED;
      }
    }
  );
  const overdue = await countOverduePullRequests();
  return summarize(due.length, overdue, outcomes);
}

/**
 * Eligible pull requests neither reconciled nor attempted within the freshness
 * floor, with held leases skipped. The attempt floor keeps a PR whose reconcile
 * fails on every run (no credential, a list at its ceiling) from being retried
 * every run while the batch has room. Ordered by the last attempt,
 * never-attempted first, so failing PRs cannot hold the batch either; among
 * never-attempted PRs the plan's oldest `commentsReconciledAt` first still
 * applies, and the id breaks ties so the order is total.
 * `pull_request_detail_comments_reconcile_due_idx` seeks `pr_state` and the
 * attempt floor, so the scan reads only the rows past that floor.
 */
async function selectDuePullRequests(limit: number): Promise<string[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT pr."id"
      FROM "pull_request_detail" AS pr
      JOIN "branch_detail" AS b ON b."artifact_id" = pr."branch_artifact_id"
      WHERE ${ELIGIBLE_PULL_REQUEST_SQL}
        AND ${olderThanFreshnessFloorSql("comments_reconciled_at")}
        AND ${olderThanFreshnessFloorSql("comments_reconcile_attempted_at")}
        AND ${reconcileLeaseIsFreeSql(Prisma.raw('pr."comments_reconcile_claimed_at"'))}
      ORDER BY
        pr."comments_reconcile_attempted_at" ASC NULLS FIRST,
        pr."comments_reconciled_at" ASC NULLS FIRST,
        pr."id" ASC
      LIMIT ${limit}
    `)
  );
  return rows.map((row) => row.id);
}

async function countOverduePullRequests(): Promise<number> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ overdue: number }[]>(Prisma.sql`
      SELECT count(*)::int AS "overdue"
      FROM "pull_request_detail" AS pr
      JOIN "branch_detail" AS b ON b."artifact_id" = pr."branch_artifact_id"
      WHERE ${ELIGIBLE_PULL_REQUEST_SQL}
        AND ${olderThanFreshnessFloorSql("comments_reconciled_at")}
    `)
  );
  const [row] = rows;
  if (!row) {
    throw new Error("overdue pull request count returned no row");
  }
  return row.overdue;
}

function summarize(
  due: number,
  overdue: number,
  outcomes: readonly (
    | Awaited<ReturnType<typeof reconcilePullRequestComments>>
    | typeof RECONCILE_FAILED
  )[]
): PullRequestCommentReconcileRunSummary {
  const summary: PullRequestCommentReconcileRunSummary = {
    event: RECONCILE_PR_COMMENTS_RUN_EVENT,
    status: PullRequestCommentReconcileRunStatus.Ok,
    due,
    overdue,
    reconciled: 0,
    partial: 0,
    claimedElsewhere: 0,
    providerErrors: 0,
    failed: 0,
    appliedEvents: 0,
    signals: 0,
    reasons: [],
  };
  const reasons = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome === RECONCILE_FAILED) {
      summary.failed += 1;
      continue;
    }
    summary.appliedEvents += outcome.appliedEvents;
    summary.signals += outcome.signals;
    for (const reason of outcome.reasons) {
      reasons.add(reason);
    }
    if (outcome.errorCode) {
      reasons.add(outcome.errorCode);
    }
    countStatus(summary, outcome.status);
  }
  summary.reasons = [...reasons].sort();
  summary.status =
    summary.failed + summary.providerErrors > 0
      ? PullRequestCommentReconcileRunStatus.Degraded
      : PullRequestCommentReconcileRunStatus.Ok;
  return summary;
}

const SUMMARY_FIELD_BY_STATUS = {
  [GitHubCommentReconcileStatus.Reconciled]: "reconciled",
  [GitHubCommentReconcileStatus.Partial]: "partial",
  [GitHubCommentReconcileStatus.Claimed]: "claimedElsewhere",
  [GitHubCommentReconcileStatus.ProviderError]: "providerErrors",
} as const satisfies Record<
  GitHubCommentReconcileStatus,
  keyof PullRequestCommentReconcileRunSummary
>;

function countStatus(
  summary: PullRequestCommentReconcileRunSummary,
  status: GitHubCommentReconcileStatus
): void {
  summary[SUMMARY_FIELD_BY_STATUS[status]] += 1;
}

function olderThanFreshnessFloorSql(
  column: "comments_reconciled_at" | "comments_reconcile_attempted_at"
): Prisma.Sql {
  return olderThanReconcileFreshnessFloorSql(Prisma.raw(`pr."${column}"`));
}
