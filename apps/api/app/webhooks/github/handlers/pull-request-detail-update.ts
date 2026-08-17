import type { PullRequest } from "@octokit/webhooks-types";
import { pullRequestState } from "./pull-request-lifecycle-decision";

/**
 * Build a PullRequestDetail update payload from a webhook pull_request payload.
 * Only covers fields that may change on edit/reopen/sync.
 */
export function pullRequestToDetailUpdate(pullRequest: PullRequest) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    htmlUrl: pullRequest.html_url,
    body: pullRequest.body ?? null,
    prState: pullRequestState(pullRequest),
    isDraft: pullRequest.draft ?? false,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    // FEA-3552: the GitHub PR createdAt drives the rail's "PR opened" dot.
    githubCreatedAt: pullRequest.created_at
      ? new Date(pullRequest.created_at)
      : null,
    // PLN-1535 M1: keep the reconciler's watermark live on webhook-fed (tier-1)
    // rows. `updated_at` bumps on every PR change, so persisting it on each
    // handled action means a tier-1 sweep is pure gap-repair.
    githubUpdatedAt: pullRequest.updated_at
      ? new Date(pullRequest.updated_at)
      : null,
    closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
    mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
    mergeCommitSha: pullRequest.merge_commit_sha ?? null,
    // PLN-1535 M3: the PR author, so the Postgres-served PR list renders a real
    // login. Persisting it on every handled action also self-heals rows created
    // before the column existed (they read null until their next PR event).
    authorLogin: pullRequest.user?.login ?? null,
  };
}
