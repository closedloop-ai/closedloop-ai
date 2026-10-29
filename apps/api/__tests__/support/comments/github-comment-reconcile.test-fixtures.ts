import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import {
  type GitHubCommentScope,
  seedGitHubCommentScope,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import {
  type PrefetchedReconcileLists,
  reconcilePullRequestComments,
} from "@/app/comments/service/github/github-comment-reconcile";
import { backfillFetchProvenance } from "@/lib/github-fetch-provenance";

/** A provider list result as the listers return it. */
export function list<T>(items: T[], complete = true) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: { items, complete },
  } as const;
}

/** Three complete, empty lists read now, with any of them replaced. */
export function lists(
  over: Partial<Omit<PrefetchedReconcileLists, "fetchProvenance">> = {}
): PrefetchedReconcileLists {
  return {
    issueComments: list([]),
    reviewComments: list([]),
    reviews: list([]),
    listedAt: new Date(),
    fetchProvenance: backfillFetchProvenance(),
    ...over,
  };
}

export function reconcile(
  scope: GitHubCommentScope,
  prefetched?: PrefetchedReconcileLists
) {
  return reconcilePullRequestComments({
    pullRequestDetailId: scope.pullRequestDetailId,
    ...(prefetched ? { prefetched } : {}),
  });
}

/** The pull request's reconcile lease and stamps. */
export async function marker(scope: GitHubCommentScope) {
  return await withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id: scope.pullRequestDetailId },
      select: {
        commentsReconciledAt: true,
        commentsReconcileClaimedAt: true,
        commentsReconcileAttemptedAt: true,
      },
    })
  );
}

export async function seed(): Promise<GitHubCommentScope> {
  return await seedGitHubCommentScope(await createTestOrganization());
}
