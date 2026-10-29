import { GitHubPRState } from "@repo/api/src/types/github";

/** Shared PR projection input for writer and payload contract tests. */
export function pullRequestInput() {
  return {
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "acme/app",
    githubId: "github-pr-123",
    number: 123,
    title: "Shared writer",
    body: "Body",
    htmlUrl: "https://github.com/acme/app/pull/123",
    headBranch: "feature/shared",
    baseBranch: "main",
    headSha: "new-sha",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 44,
    deletions: 6,
    changedFiles: 3,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
}
