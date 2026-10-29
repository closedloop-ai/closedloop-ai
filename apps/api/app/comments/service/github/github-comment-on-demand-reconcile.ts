import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
  type GitHubCommentReconcileResult,
  reconcilePullRequestComments,
} from "./github-comment-reconcile";

/** PLN-2122 decision 5: how long a first view waits for its reconcile. */
export const ON_DEMAND_RECONCILE_BUDGET_MS = 8000;

const LOG_PREFIX = "[branch-comments]";

/**
 * PLN-2122 decision 5: the first view of an unsynced pull request starts its
 * reconcile and waits for it within the budget. `null` when the run is still
 * going at the budget (it continues under `waitUntil`, and its commits signal
 * the branch channel) or when it threw, which is logged: either way the
 * caller serves the stored rows.
 */
export async function reconcilePullRequestCommentsOnView(
  pullRequestDetailId: string
): Promise<GitHubCommentReconcileResult | null> {
  const run = reconcilePullRequestComments({
    pullRequestDetailId,
    requireAttemptDue: true,
  }).catch((error: unknown) => {
    log.error(`${LOG_PREFIX} on-demand comment reconcile failed`, {
      pullRequestDetailId,
      error: parseError(error),
    });
    return null;
  });
  waitUntil(run);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ON_DEMAND_RECONCILE_BUDGET_MS);
  });
  try {
    return await Promise.race([run, budget]);
  } finally {
    clearTimeout(timer);
  }
}
