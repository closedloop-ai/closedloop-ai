import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import { gitHubConfirmedHeadBranch } from "@repo/api/src/types/pull-request-github-head";

/** The head a GitHub read reported for one PR. */
export type PullRequestGitHubHead = {
  branchName: string;
  /** GitHub's head repository. Absent when the read could not report one. */
  repositoryFullName: string | null | undefined;
  /** GitHub's `updated_at` on that read; null when the read reported none. */
  updatedAt: Date | null;
};

/** The head fields every GitHub PR read (GraphQL or REST) reports. */
export type GitHubPullRequestHeadRead = Pick<
  GitHubReadModelPullRequest,
  "headBranch" | "headRepository"
> & { updatedAt?: string | null };

/** Where a PR is filed: its own repository and the Branch it sits under. */
export type PullRequestFiling = {
  repositoryFullName: string | null;
  branch: { branchName: string; repositoryFullName: string } | null;
};

export function pullRequestGitHubHead(
  read: GitHubPullRequestHeadRead
): PullRequestGitHubHead {
  const updatedAt = read.updatedAt ? new Date(read.updatedAt) : null;
  return {
    branchName: read.headBranch,
    repositoryFullName: read.headRepository?.repository.fullName,
    updatedAt:
      updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
  };
}

/**
 * ISS-12344 decision record (thread th_1__bTDiF9jNPx9ebLHmn0): a PR moves when
 * GitHub confirmed a head in the PR's own repository (a fork head is skipped)
 * and the Branch it sits under has another name or belongs to another
 * repository.
 */
export function needsGitHubHeadRefile(
  filing: PullRequestFiling,
  head: PullRequestGitHubHead
): boolean {
  const confirmed = gitHubConfirmedHeadBranch({
    headBranch: head.branchName,
    headRepositoryFullName: head.repositoryFullName,
    repositoryFullName: filing.repositoryFullName,
  });
  if (!(confirmed && filing.repositoryFullName && filing.branch)) {
    return false;
  }
  return (
    filing.branch.branchName !== confirmed ||
    normalizeRepoFullName(filing.branch.repositoryFullName) !==
      normalizeRepoFullName(filing.repositoryFullName)
  );
}
