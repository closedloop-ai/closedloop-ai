import type { PullRequest } from "@octokit/webhooks-types";
import { mapPullRequestAuthor } from "@repo/github/pull-request-author";
import { buildPullRequestDetailUpdate } from "@/app/branches/github-projection-writer";
import { pullRequestState } from "./pull-request-lifecycle-decision";

/**
 * Build a PullRequestDetail update payload from a webhook pull_request payload.
 * Only covers fields that may change on edit/reopen/sync.
 *
 * ISS-8155: the columns come from the shared projection builder, not a parallel
 * literal. This lane and the branch-owned projection lane are both the webhook
 * producer, so a field mapped in only one of them is a drift the type system
 * could not see — which is how `authorLogin` became webhook-only.
 *
 * `setCurrent: false` because this lane refreshes the row it was handed; the
 * current-PR pointer is owned by `writeExistingBranchPullRequestProjection`.
 */
export function pullRequestToDetailUpdate(pullRequest: PullRequest) {
  return {
    ...buildPullRequestDetailUpdate(
      {
        number: pullRequest.number,
        title: pullRequest.title,
        htmlUrl: pullRequest.html_url,
        baseBranch: pullRequest.base.ref,
        prState: pullRequestState(pullRequest),
        isDraft: pullRequest.draft ?? false,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changedFiles: pullRequest.changed_files,
        // FEA-3552: the GitHub PR createdAt drives the rail's "PR opened" dot.
        githubCreatedAt: pullRequest.created_at
          ? new Date(pullRequest.created_at)
          : null,
        // PLN-1535 M1: keep the reconciler's watermark live on webhook-fed
        // (tier-1) rows. `updated_at` bumps on every PR change, so persisting it
        // on each handled action means a tier-1 sweep is pure gap-repair.
        githubUpdatedAt: pullRequest.updated_at
          ? new Date(pullRequest.updated_at)
          : null,
        closedAt: pullRequest.closed_at
          ? new Date(pullRequest.closed_at)
          : null,
        mergedAt: pullRequest.merged_at
          ? new Date(pullRequest.merged_at)
          : null,
        mergeCommitSha: pullRequest.merge_commit_sha ?? null,
        // PLN-1535 M3: the PR author, so the Postgres-served PR list renders a
        // real login. Persisting it on every handled action also self-heals rows
        // created before the column existed.
        ...mapPullRequestAuthor(pullRequest.user),
      },
      { setCurrent: false }
    ),
    // The webhook payload is authoritative for the row it updates, so a cleared
    // description must clear the column. The shared builder preserves omission
    // instead, for the provenance-poorer producers that share it.
    body: pullRequest.body ?? null,
  };
}
