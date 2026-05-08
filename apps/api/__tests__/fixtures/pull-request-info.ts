import {
  type PullRequestInfo,
  PullRequestState,
} from "@repo/api/src/types/document";

/** Builds a minimal PullRequestInfo fixture with repoFullName populated. */
export function buildPullRequestInfo(
  overrides: Partial<PullRequestInfo> = {}
): PullRequestInfo {
  return {
    id: "pr-art-1",
    number: 1,
    title: "feat: add something",
    htmlUrl: "https://github.com/owner/repo/pull/1",
    state: PullRequestState.Open,
    headBranch: "feat/add-something",
    baseBranch: "main",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    checksStatus: null,
    reviewDecision: null,
    externalLinkId: "pr-art-1",
    repoFullName: "owner/repo",
    ...overrides,
  };
}
