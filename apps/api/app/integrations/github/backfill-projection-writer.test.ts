import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubReadModelSource,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubBackfillPullRequestMetadata } from "./backfill-projection-writer";

const resolveExternalGitHubAuthorMock = vi.fn();
const softDeleteGitHubCommentProjectionMock = vi.fn();
const upsertGitHubIssueCommentThreadMock = vi.fn();
const upsertGitHubReviewCommentThreadMock = vi.fn();
const persistBranchStatusChecksFromRollupMock = vi.fn();
const recomputeAndUpdateAggregateMock = vi.fn();

const dbMock = {
  branchDetail: {
    findMany: vi.fn(),
  },
  pullRequestDetail: {
    findMany: vi.fn(),
  },
};
const txMock = {
  branchDetail: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  pullRequestDetail: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  gitHubPRReview: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  gitHubCommentProjection: {
    findMany: vi.fn(),
  },
  gitHubCommentThreadProjection: {
    findMany: vi.fn(),
  },
  branchStatusCheck: {
    findMany: vi.fn(),
  },
};
const withDbMock = Object.assign(
  vi.fn((callback) => callback(dbMock)),
  {
    tx: vi.fn((callback) => callback(txMock)),
  }
);

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind: {
    ISSUE_COMMENT: "ISSUE_COMMENT",
    REVIEW_THREAD: "REVIEW_THREAD",
  },
  GitHubLegacyCommentState: {
    PENDING: "PENDING",
    ADDRESSED: "ADDRESSED",
  },
  ThreadStatus: {
    OPEN: "OPEN",
    RESOLVED: "RESOLVED",
  },
  withDb: withDbMock,
}));

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange: vi.fn(),
  persistBranchStatusChecksFromRollup: persistBranchStatusChecksFromRollupMock,
}));

vi.mock("@/app/comments/external-authors", () => ({
  normalizeExternalGitHubAuthor: (author: { id?: number | null } | null) => ({
    providerUserId: String(author?.id ?? "ghost"),
    isGhost: author?.id == null,
  }),
  resolveExternalGitHubAuthorInTransaction: resolveExternalGitHubAuthorMock,
}));

vi.mock("@/app/comments/github-diff-side", () => ({
  normalizeGitHubDiffSide: (side: string | null | undefined) => side ?? null,
}));

vi.mock("@/app/comments/github-projection", () => ({
  softDeleteGitHubCommentProjection: softDeleteGitHubCommentProjectionMock,
  upsertGitHubIssueCommentThread: upsertGitHubIssueCommentThreadMock,
  upsertGitHubReviewCommentThread: upsertGitHubReviewCommentThreadMock,
}));

vi.mock("@/lib/review-decision-utils", () => ({
  recomputeAndUpdateAggregate: recomputeAndUpdateAggregateMock,
}));

const { githubBackfillProjectionWriter } = await import(
  "./backfill-projection-writer"
);

describe("githubBackfillProjectionWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.branchDetail.findMany.mockResolvedValue([
      {
        artifactId: "branch-artifact-1",
        branchName: "feature/test",
        currentPullRequestDetailId: null,
        checksStatus: ChecksStatus.Unknown,
        currentPullRequestDetail: null,
      },
    ]);
    dbMock.pullRequestDetail.findMany.mockResolvedValue([]);
    txMock.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      branchName: "feature/test",
      baseBranch: null,
      baseBranchSource: null,
      headSha: null,
      headShaSource: null,
      checksStatus: ChecksStatus.Unknown,
      checksDetailProviderState: null,
      checksDetailUpdatedAt: null,
      currentPullRequestDetailId: null,
    });
    txMock.pullRequestDetail.findFirst.mockResolvedValue(null);
    txMock.pullRequestDetail.findUnique.mockResolvedValue(null);
    txMock.pullRequestDetail.update.mockResolvedValue({});
    txMock.pullRequestDetail.upsert.mockResolvedValue({ id: "pr-detail-1" });
    txMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
    txMock.branchDetail.update.mockResolvedValue({});
    txMock.gitHubPRReview.upsert.mockResolvedValue({});
    txMock.gitHubPRReview.findMany.mockResolvedValue([]);
    txMock.gitHubCommentProjection.findMany.mockResolvedValue([]);
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([]);
    txMock.branchStatusCheck.findMany.mockResolvedValue([]);
    resolveExternalGitHubAuthorMock.mockResolvedValue({
      user: { id: "user-1" },
      externalAuthor: { id: "external-author-1" },
    });
    upsertGitHubIssueCommentThreadMock.mockResolvedValue({
      threadId: "issue-thread-1",
      commentIds: ["issue-comment-1"],
      createdGithubCommentIds: ["1001"],
    });
    upsertGitHubReviewCommentThreadMock.mockResolvedValue({
      threadId: "review-thread-1",
      commentIds: ["review-comment-1"],
      createdGithubCommentIds: ["2001"],
    });
    softDeleteGitHubCommentProjectionMock.mockResolvedValue({
      comments: 0,
      threads: 0,
    });
    persistBranchStatusChecksFromRollupMock.mockResolvedValue({
      status: "updated",
      checksStatusChanged: false,
      previousChecksStatus: ChecksStatus.Unknown,
      nextChecksStatus: ChecksStatus.Passing,
    });
    recomputeAndUpdateAggregateMock.mockResolvedValue(undefined);
  });

  it("computes a dry-run projection diff without mutating rows", async () => {
    const diff = await githubBackfillProjectionWriter.diff({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
      },
      pullRequests: [readModelPullRequest()],
    });

    expect(diff).toEqual({
      branchProjectionChangeCount: 1,
      pullRequestProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 0,
      reviewCommentProjectionChangeCount: 0,
      reviewThreadProjectionChangeCount: 0,
      reviewProjectionChangeCount: 0,
      statusCheckProjectionChangeCount: 0,
      skippedBranchCount: 0,
    });
    expect(txMock.pullRequestDetail.upsert).not.toHaveBeenCalled();
  });

  it("writes provider PR fields through the shared projection writer", async () => {
    const diff = await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
      },
      pullRequests: [readModelPullRequest()],
    });

    expect(diff.pullRequestProjectionChangeCount).toBe(1);
    expect(withDbMock.tx).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5000,
      timeout: 30_000,
    });
    expect(txMock.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId_number: {
            repositoryId: "repo-1",
            number: 42,
          },
        },
        create: expect.objectContaining({
          branchArtifactId: "branch-artifact-1",
          githubId: "4242",
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          reviewDecision: ReviewDecision.Approved,
        }),
        update: expect.objectContaining({
          additions: 1,
          deletions: 0,
          changedFiles: 1,
        }),
      })
    );
    expect(txMock.branchDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "branch-artifact-1" },
        data: expect.objectContaining({
          currentPullRequestDetailId: "pr-detail-1",
        }),
      })
    );
    expect(txMock.branchDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "branch-artifact-1" },
        data: expect.objectContaining({
          baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        }),
      })
    );
    expect(txMock.branchDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "branch-artifact-1" },
        data: expect.objectContaining({
          checksStatus: ChecksStatus.Passing,
        }),
      })
    );
  });

  it("treats whole-second and millisecond-equivalent GitHub timestamps as unchanged", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValue([
      {
        ...existingPullRequest(),
        closedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
    ]);

    const diff = await githubBackfillProjectionWriter.diff({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
      },
      pullRequests: [
        {
          ...readModelPullRequest(),
          closedAt: "2026-07-05T00:00:00Z",
        },
      ],
    });

    expect(diff.pullRequestProjectionChangeCount).toBe(0);
  });

  it("writes comments, review rows, review threads, and per-check rows through shared writers", async () => {
    const diff = await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
      },
      pullRequests: [readModelPullRequest()],
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff).toMatchObject({
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
    });
    expect(upsertGitHubIssueCommentThreadMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        organizationId: "org-1",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        fetchProvenance: expectedBackfillFetchProvenance(),
      })
    );
    expect(upsertGitHubReviewCommentThreadMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        reviewThreadId: "thread-node-2001",
        resolutionStatus: "RESOLVED",
        fetchProvenance: expectedBackfillFetchProvenance(),
      })
    );
    expect(softDeleteGitHubCommentProjectionMock).toHaveBeenCalledTimes(2);
    expect(txMock.gitHubPRReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          pullRequestId_authorLogin: {
            pullRequestId: "pr-detail-1",
            authorLogin: "reviewer",
          },
        },
        create: expect.objectContaining({
          state: ReviewDecision.Approved,
          ...expectedBackfillStoredProvenance(),
        }),
        update: expect.objectContaining(expectedBackfillStoredProvenance()),
      })
    );
    expect(recomputeAndUpdateAggregateMock).toHaveBeenCalledWith(
      txMock,
      "pr-detail-1"
    );
    expect(persistBranchStatusChecksFromRollupMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        organizationId: "org-1",
        headSha: "abc123",
        fetchProvenance: expectedGraphqlBackfillFetchProvenance(),
      })
    );
  });

  it("does not soft-delete comment projections for incomplete provider pages", async () => {
    await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
      },
      pullRequests: [readModelPullRequest()],
      pullRequestMetadata: [
        {
          ...pullRequestMetadata(),
          issueComments: [],
          issueCommentsComplete: false,
          reviewComments: [],
          reviewCommentsComplete: false,
        },
      ],
    });

    expect(upsertGitHubIssueCommentThreadMock).not.toHaveBeenCalled();
    expect(upsertGitHubReviewCommentThreadMock).not.toHaveBeenCalled();
    expect(softDeleteGitHubCommentProjectionMock).not.toHaveBeenCalled();
  });

  it("counts stale per-check rows deleted by the shared status-check writer", async () => {
    txMock.pullRequestDetail.findUnique.mockResolvedValue(
      existingPullRequest()
    );
    txMock.branchStatusCheck.findMany.mockResolvedValue([
      {
        providerKey: "check-1",
        kind: "check_run",
        providerNodeId: "check-node-1",
        name: "unit",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        targetUrl: "https://github.com/checks/1",
        position: 0,
      },
      {
        providerKey: "stale-check",
        kind: "check_run",
        providerNodeId: "stale-node",
        name: "old e2e",
        status: "COMPLETED",
        conclusion: "FAILURE",
        targetUrl: "https://github.com/checks/stale",
        position: 1,
      },
    ]);

    const diff = await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
      },
      pullRequests: [readModelPullRequest()],
      pullRequestMetadata: [statusCheckOnlyMetadata()],
    });

    expect(diff.statusCheckProjectionChangeCount).toBe(1);
    expect(persistBranchStatusChecksFromRollupMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        headSha: "abc123",
        rollup: expect.objectContaining({
          checks: [expect.objectContaining({ id: "check-1" })],
        }),
      })
    );
  });
});

function readModelPullRequest() {
  return {
    githubId: "4242",
    number: 42,
    title: "Backfilled PR",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    headBranch: "feature/test",
    baseBranch: "main",
    headSha: "abc123",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: ReviewDecision.Approved,
    checksStatus: ChecksStatus.Passing,
    statusCheckRollup: "SUCCESS",
    openedAt: "2026-07-05T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-07-05T01:00:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

function existingPullRequest() {
  return {
    id: "pr-detail-1",
    githubId: "4242",
    number: 42,
    title: "Backfilled PR",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: ReviewDecision.Approved,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
}

function statusCheckOnlyMetadata(): GitHubBackfillPullRequestMetadata {
  return {
    ...pullRequestMetadata(),
    issueComments: [],
    issueCommentsComplete: false,
    reviewComments: [],
    reviewCommentsComplete: false,
    reviews: [],
  };
}

function pullRequestMetadata(): GitHubBackfillPullRequestMetadata {
  return {
    number: 42,
    issueComments: [
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
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-1001",
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      },
    ],
    issueCommentsComplete: true,
    reviewComments: [
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
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2001",
        commit_id: "abc123",
        pull_request_review_id: 3001,
        review_thread_node_id: "thread-node-2001",
        review_thread_is_resolved: true,
        in_reply_to_id: null,
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      },
    ],
    reviewCommentsComplete: true,
    reviews: [
      {
        id: 3001,
        user: {
          login: "reviewer",
          avatar_url: "https://avatars.githubusercontent.com/u/502",
        },
        state: ReviewDecision.Approved,
        body: "Approved",
        submitted_at: "2026-07-05T00:04:00.000Z",
        html_url:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#pullrequestreview-3001",
      },
    ],
    statusCheckRollup: {
      ok: true,
      state: "SUCCESS",
      checks: [
        {
          id: "check-1",
          providerNodeId: "check-node-1",
          kind: "check_run",
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

function expectedBackfillFetchProvenance() {
  return expect.objectContaining({
    credentialType: GitHubFetchCredentialType.GitHubApp,
    mechanism: GitHubFetchMechanism.Backfill,
    trigger: GitHubFetchTrigger.Backfill,
    observedAt: expect.any(Date),
    resultReason: GitHubSyncResultReason.Success,
  });
}

function expectedGraphqlBackfillFetchProvenance() {
  return expect.objectContaining({
    credentialType: GitHubFetchCredentialType.GitHubApp,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    observedAt: expect.any(Date),
    resultReason: GitHubSyncResultReason.Success,
  });
}

function expectedBackfillStoredProvenance() {
  return {
    fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
    fetchCredentialOwnerId: null,
    fetchMechanism: GitHubFetchMechanism.Backfill,
    fetchTrigger: GitHubFetchTrigger.Backfill,
    fetchObservedAt: expect.any(Date),
    fetchResultReason: GitHubSyncResultReason.Success,
  };
}
