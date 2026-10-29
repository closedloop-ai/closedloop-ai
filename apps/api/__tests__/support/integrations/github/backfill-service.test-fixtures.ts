import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { BranchViewCheckKind } from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubProviderBudgetState,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
// The SUBPATH, not the barrel: the suites consuming these fixtures mock
// `@repo/github`, and importing the barrel from a module their `vi.mock` factory
// transitively loads deadlocks on the factory's own hoisted closure variables.
// `provider-result` resolves to a different module id, so it is untouched.
import { GitHubProviderResultStatus } from "@repo/github/provider-result";

/**
 * Values kept as literals below are GitHub's own wire strings with no canonical
 * const in this repo — the rollup `state`/`conclusion`/`status`, and REST's
 * `author_association` / `side`. Everything with a repo-owned const uses it.
 */

/**
 * Provider payloads and repository rows the bounded backfill sweep's suites
 * drive. Extracted from `backfill-service.test.ts` so the suite's `beforeEach`
 * reads as the wiring it is rather than as 150 lines of sample JSON.
 */

/** The two ACTIVE-installation repository rows the sweep selects, in order. */
export function backfillInstallationRepositories() {
  return [
    {
      id: "repo-1",
      fullName: "closedloop-ai/closedloop-ai",
      owner: "closedloop-ai",
      name: "closedloop-ai",
    },
    {
      id: "repo-2",
      fullName: "closedloop-ai/other",
      owner: "closedloop-ai",
      name: "other",
    },
  ];
}

export function backfillBundledPullRequests() {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests: [
        {
          githubId: "1",
          number: 1,
          title: "PR 1",
          htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/1",
          headBranch: "main",
          baseBranch: "main",
          headSha: "abc",
          state: GitHubPRState.Open,
          isDraft: false,
          additions: null,
          deletions: null,
          changedFiles: null,
          reviewDecision: ReviewDecision.Approved,
          checksStatus: ChecksStatus.Passing,
          statusCheckRollup: "SUCCESS",
          openedAt: null,
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          updatedAt: "2026-07-05T00:00:00.000Z",
          author: "octocat",
          source: GitHubReadModelSource.Provider,
        },
      ],
      rateLimit: {
        cost: 1,
        remaining: 1000,
        resetAt: null,
        state: GitHubProviderBudgetState.Available,
      },
    },
  };
}

export function backfillIssueComments() {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      items: [
        {
          id: 1001,
          node_id: "issue-node-1001",
          user: {
            id: 501,
            login: "octocat",
            node_id: "user-node-501",
            avatar_url: "https://avatars.githubusercontent.com/u/501",
          },
          body: "Issue comment",
          author_association: "MEMBER",
          created_at: "2026-07-05T00:00:00.000Z",
          updated_at: "2026-07-05T00:01:00.000Z",
          html_url:
            "https://github.com/closedloop-ai/closedloop-ai/pull/1#issuecomment-1001",
          deleted_at: null,
          is_deleted: false,
          is_updated: true,
        },
      ],
      complete: true,
    },
  };
}

export function backfillReviewComments() {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      items: [
        {
          id: 2001,
          node_id: "review-node-2001",
          path: "app.ts",
          line: 10,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          original_line: 10,
          original_start_line: null,
          body: "Review comment",
          user: {
            id: 502,
            login: "reviewer",
            node_id: "user-node-502",
            avatar_url: "https://avatars.githubusercontent.com/u/502",
          },
          author_association: "MEMBER",
          created_at: "2026-07-05T00:02:00.000Z",
          updated_at: "2026-07-05T00:03:00.000Z",
          html_url:
            "https://github.com/closedloop-ai/closedloop-ai/pull/1#discussion_r2001",
          commit_id: "abc",
          pull_request_review_id: 3001,
          review_thread_node_id: "thread-node-2001",
          review_thread_is_resolved: false,
          in_reply_to_id: null,
          deleted_at: null,
          is_deleted: false,
          is_updated: true,
        },
      ],
      complete: true,
    },
  };
}

export function backfillReviews() {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      items: [
        {
          id: 3001,
          user: {
            login: "reviewer",
            avatar_url: "https://avatars.githubusercontent.com/u/502",
          },
          state: "APPROVED",
          body: "Approved",
          submitted_at: "2026-07-05T00:04:00.000Z",
          html_url:
            "https://github.com/closedloop-ai/closedloop-ai/pull/1#pullrequestreview-3001",
        },
      ],
      complete: true,
    },
  };
}

export function backfillStatusCheckRollup() {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      ok: true,
      state: "SUCCESS",
      checks: [
        {
          id: "check-1",
          providerNodeId: "check-node-1",
          kind: BranchViewCheckKind.CheckRun,
          name: "unit",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          targetUrl: "https://github.com/checks/1",
          position: 0,
        },
      ],
      totalCount: 1,
      truncated: false,
    },
  };
}

/** One change per counter, so a dropped counter shows up as a missing 1. */
export function backfillProjectionDiff() {
  return {
    branchProjectionChangeCount: 1,
    pullRequestProjectionChangeCount: 1,
    lifecycleAtomProjectionChangeCount: 1,
    branchLastActivityProjectionChangeCount: 1,
    reviewDecisionProjectionChangeCount: 1,
    checkProjectionChangeCount: 1,
    issueCommentProjectionChangeCount: 1,
    reviewCommentProjectionChangeCount: 1,
    reviewThreadProjectionChangeCount: 1,
    reviewProjectionChangeCount: 1,
    statusCheckProjectionChangeCount: 1,
    skippedBranchCount: 0,
  };
}

/** A bundled provider PR row, as the GraphQL bundle read returns it. */
export function bundledPullRequest(number: number) {
  return {
    githubId: String(number),
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/closedloop-ai/closedloop-ai/pull/${number}`,
    headBranch: "main",
    baseBranch: "main",
    headSha: `sha-${number}`,
    state: "OPEN",
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewDecision: "APPROVED",
    checksStatus: "PASSING",
    statusCheckRollup: "SUCCESS",
    openedAt: null,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-07-05T00:00:00.000Z",
    author: "octocat",
    source: "provider",
  };
}

/** One row of the branch-canonical PR candidate set. */
export function makeCanonicalDetailRow(
  overrides: Partial<{
    id: string;
    number: number;
    htmlUrl: string;
    prState: string;
    mergedAt: Date | null;
    repositoryId: string | null;
    repositoryFullName: string;
    repository: { fullName: string };
  }> = {}
) {
  return {
    id: "pr-live",
    branchArtifactId: "branch-1",
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repository: { fullName: "closedloop-ai/closedloop-ai" },
    number: 150,
    title: "Live PR",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/150",
    prState: "OPEN",
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: new Date("2026-08-02T00:00:00.000Z"),
    fetchMechanism: "webhook",
    githubId: "gh-1",
    additions: 4,
    deletions: 2,
    changedFiles: 1,
    ...overrides,
  };
}
