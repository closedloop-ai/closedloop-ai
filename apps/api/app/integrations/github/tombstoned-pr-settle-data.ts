import type { Prisma } from "@repo/database";
import type { GitHubSinglePullRequestResult } from "@repo/github";
import { buildPullRequestDetailUpdate } from "@/app/branches/github-projection-writer";
import type { GitHubFetchProvenance } from "@/lib/github-fetch-provenance";

/** Map a tombstoned PR refresh without promoting a superseded row. */
export function tombstonedPullRequestSettleData(
  pullRequest: GitHubSinglePullRequestResult,
  now: Date,
  fetchProvenance: GitHubFetchProvenance
): Prisma.PullRequestDetailUncheckedUpdateInput {
  return {
    lastVerifiedAt: now,
    ...buildPullRequestDetailUpdate(
      {
        additions: pullRequest.additions,
        authorLogin: measuredAuthorLogin(pullRequest),
        authorProviderUserId: pullRequest.authorProviderUserId,
        authorActorType: pullRequest.authorActorType,
        baseBranch: pullRequest.baseBranch,
        changedFiles: pullRequest.changedFiles,
        closedAt: parseNullableDate(pullRequest.closedAt),
        deletions: pullRequest.deletions,
        fetchProvenance,
        githubCreatedAt: parseNullableDate(pullRequest.createdAt),
        htmlUrl: pullRequest.htmlUrl,
        isDraft: pullRequest.isDraft,
        mergeCommitSha: pullRequest.mergeCommitSha,
        mergedAt: parseNullableDate(pullRequest.mergedAt),
        number: pullRequest.number,
        prState: pullRequest.state,
        title: pullRequest.title,
      },
      { setCurrent: false }
    ),
  };
}

/** Preserve the provider's missing date as an explicit absent lifecycle time. */
export function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function measuredAuthorLogin(
  pullRequest: Pick<
    GitHubSinglePullRequestResult,
    "authorActorType" | "authorLogin" | "authorProviderUserId"
  >
): string | null | undefined {
  if (
    pullRequest.authorProviderUserId === null ||
    pullRequest.authorActorType === null
  ) {
    return pullRequest.authorLogin;
  }
  return pullRequest.authorLogin ?? undefined;
}
