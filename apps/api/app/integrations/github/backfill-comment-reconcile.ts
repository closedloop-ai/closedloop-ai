import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  GitHubCommentReconcileStatus,
  type PrefetchedReconcileLists,
  reconcilePullRequestComments,
} from "@/app/comments/service/github/github-comment-reconcile";

/** The three comment lists the sweep read for one pull request. */
export type BackfillCommentLists = Omit<
  PrefetchedReconcileLists,
  "fetchProvenance"
>;

/**
 * PLN-2122 Step 4: the comments of every pull request the sweep projected are
 * written by the comment reconcile, from the lists the sweep already read, once
 * the projection transaction has committed. A list the provider failed is
 * already one of the sweep's metadata failures; a reconcile that throws is
 * logged and adds its own entry, so the sweep reports `degraded` and the next
 * pull request still reconciles. A pull request whose lease another run holds
 * gets none of these lists written; it is logged, not counted, because that
 * run reads and writes its own.
 */
export async function reconcileProjectedComments(
  repositoryFullName: string,
  projected: readonly { number: number; pullRequestDetailId: string }[],
  commentListsByNumber: ReadonlyMap<number, BackfillCommentLists>,
  fetchProvenance: PrefetchedReconcileLists["fetchProvenance"]
): Promise<string[]> {
  const failures: string[] = [];
  for (const pullRequest of projected) {
    const lists = commentListsByNumber.get(pullRequest.number);
    if (!lists) {
      continue;
    }
    try {
      const result = await reconcilePullRequestComments({
        pullRequestDetailId: pullRequest.pullRequestDetailId,
        prefetched: { ...lists, fetchProvenance },
      });
      if (result.status === GitHubCommentReconcileStatus.Claimed) {
        log.info("[github-backfill] pull request comment reconcile skipped", {
          repositoryFullName,
          pullRequestNumber: pullRequest.number,
          pullRequestDetailId: pullRequest.pullRequestDetailId,
          status: result.status,
        });
      }
    } catch (error) {
      log.warn("[github-backfill] pull request comment reconcile failed", {
        repositoryFullName,
        pullRequestNumber: pullRequest.number,
        pullRequestDetailId: pullRequest.pullRequestDetailId,
        error: parseError(error),
      });
      failures.push(
        `${repositoryFullName}#${pullRequest.number}:comments:rejected`
      );
    }
  }
  return failures;
}
