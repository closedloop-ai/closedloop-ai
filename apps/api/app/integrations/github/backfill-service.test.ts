import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import { GitHubProviderBudgetState } from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBranchesMock = vi.fn();
const getPullRequestsMock = vi.fn();
const artifactFindManyMock = vi.fn();
const findManyMock = vi.fn();
const organizationFindUniqueMock = vi.fn();
const organizationUpdateMock = vi.fn();
const executeRawMock = vi.fn();
const queryBundledPullRequestsMock = vi.fn();
const listIssueCommentsMock = vi.fn();
const listReviewCommentsMock = vi.fn();
const listReviewsMock = vi.fn();
const queryStatusCheckRollupMock = vi.fn();
const projectionDiffMock = vi.fn();
const projectionWriteMock = vi.fn();

vi.mock("@repo/database", () => ({
  ArtifactType: {
    BRANCH: "BRANCH",
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  withDb: Object.assign(
    (callback: (db: unknown) => unknown) =>
      callback({
        gitHubInstallationRepository: {
          findMany: findManyMock,
        },
        artifact: {
          findMany: artifactFindManyMock,
        },
        organization: {
          findUnique: organizationFindUniqueMock,
        },
      }),
    {
      tx: (callback: (db: unknown) => unknown) =>
        callback({
          $executeRaw: executeRawMock,
          organization: {
            findUnique: organizationFindUniqueMock,
            update: organizationUpdateMock,
          },
        }),
    }
  ),
}));

vi.mock("@repo/github", () => ({
  GitHubProviderResultStatus: {
    Success: "success",
    ProviderRateLimit: "provider_rate_limit",
    ProviderUnavailable: "provider_unavailable",
  },
  listPullRequestIssueCommentsWithProviderResult: listIssueCommentsMock,
  listPullRequestReviewCommentsWithProviderResult: listReviewCommentsMock,
  listPullRequestReviewsWithProviderResult: listReviewsMock,
  queryBundledPullRequestsWithProviderResult: queryBundledPullRequestsMock,
  queryStatusCheckRollupWithProviderResult: queryStatusCheckRollupMock,
}));

vi.mock("./backfill-projection-writer", () => ({
  githubBackfillProjectionWriter: {
    diff: projectionDiffMock,
    write: projectionWriteMock,
  },
}));

vi.mock("./service", () => ({
  githubService: {
    getBranches: getBranchesMock,
    getPullRequests: getPullRequestsMock,
  },
}));

const { githubBackfillService } = await import("./backfill-service");

describe("githubBackfillService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    artifactFindManyMock.mockResolvedValue([]);
    findManyMock.mockResolvedValue([
      {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "123" },
      },
      {
        id: "repo-2",
        fullName: "closedloop-ai/other",
        owner: "closedloop-ai",
        name: "other",
        installation: { installationId: "123" },
      },
    ]);
    getBranchesMock.mockResolvedValue({ branches: [{ name: "main" }] });
    getPullRequestsMock.mockResolvedValue({
      pullRequests: [{ number: 1 }, { number: 2 }],
    });
    queryBundledPullRequestsMock.mockResolvedValue({
      status: "success",
      value: {
        pullRequests: [
          {
            githubId: "1",
            number: 1,
            title: "PR 1",
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1",
            headBranch: "main",
            baseBranch: "main",
            headSha: "abc",
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
          },
        ],
        rateLimit: {
          cost: 1,
          remaining: 1000,
          resetAt: null,
          state: GitHubProviderBudgetState.Available,
        },
      },
    });
    listIssueCommentsMock.mockResolvedValue({
      status: "success",
      value: [
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
            "https://github.com/closedloop-ai/symphony-alpha/pull/1#issuecomment-1001",
          deleted_at: null,
          is_deleted: false,
          is_updated: true,
        },
      ],
    });
    listReviewCommentsMock.mockResolvedValue({
      status: "success",
      value: [
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
            "https://github.com/closedloop-ai/symphony-alpha/pull/1#discussion_r2001",
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
    });
    listReviewsMock.mockResolvedValue({
      status: "success",
      value: [
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
            "https://github.com/closedloop-ai/symphony-alpha/pull/1#pullrequestreview-3001",
        },
      ],
    });
    queryStatusCheckRollupMock.mockResolvedValue({
      status: "success",
      value: {
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
    });
    projectionDiffMock.mockResolvedValue({
      branchProjectionChangeCount: 1,
      pullRequestProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
      skippedBranchCount: 0,
    });
    projectionWriteMock.mockResolvedValue({
      branchProjectionChangeCount: 1,
      pullRequestProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
      skippedBranchCount: 0,
    });
    organizationFindUniqueMock.mockResolvedValue({
      settings: { unrelated: "keep" },
    });
    organizationUpdateMock.mockResolvedValue({});
    executeRawMock.mockResolvedValue(1);
  });

  it("returns shared-writer dry-run blast-radius counts without visible writes", async () => {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    expect(summary).toEqual({
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 1,
      pullRequestCount: 2,
      branchProjectionChangeCount: 1,
      pullRequestProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
      skippedBranchCount: 0,
      dryRun: true,
      ownerApprovalRequired: true,
      failures: [],
    });
    expect(projectionDiffMock).toHaveBeenCalledTimes(1);
    expect(projectionWriteMock).not.toHaveBeenCalled();
    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      [],
      {
        maxItems: undefined,
        maxPages: undefined,
        targetNumbers: [],
      }
    );
    expect(listIssueCommentsMock).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      1,
      { limit: 25, pageSize: 100 }
    );
    expect(listReviewCommentsMock).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      1,
      { limit: 25, pageSize: 100 }
    );
    expect(listReviewsMock).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      1,
      { limit: 25, pageSize: 100 }
    );
    expect(queryStatusCheckRollupMock).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      "abc"
    );
    expect(organizationUpdateMock).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: {
        settings: expect.objectContaining({
          unrelated: "keep",
          githubBackfillLatestSummary: expect.objectContaining({
            repositoryCount: 1,
            dryRun: true,
          }),
        }),
      },
    });
    expect(executeRawMock).toHaveBeenCalled();
  });

  it("runs owner-approved input through visible projection writes", async () => {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Completed);
    expect(summary.dryRun).toBe(false);
    expect(summary.ownerApprovalRequired).toBe(false);
    expect(projectionWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        repository: expect.objectContaining({
          fullName: "closedloop-ai/symphony-alpha",
        }),
        pullRequestMetadata: [
          expect.objectContaining({
            number: 1,
            issueComments: expect.any(Array),
            issueCommentsComplete: true,
            reviewComments: expect.any(Array),
            reviewCommentsComplete: true,
            reviews: expect.any(Array),
            statusCheckRollup: expect.objectContaining({
              ok: true,
              totalCount: 1,
            }),
          }),
        ],
      })
    );
    expect(projectionDiffMock).not.toHaveBeenCalled();
    expect(organizationUpdateMock).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: {
        settings: expect.objectContaining({
          githubBackfillLatestSummary: expect.objectContaining({
            status: GitHubBackfillStatus.Completed,
            dryRun: false,
            ownerApprovalRequired: false,
          }),
        }),
      },
    });
  });

  it("pages bundled PR backfill for existing branch current PR targets", async () => {
    artifactFindManyMock.mockResolvedValue([
      {
        branch: {
          currentPullRequestDetail: {
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/150",
          },
        },
      },
    ]);

    await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      [150],
      {
        maxItems: 500,
        maxPages: 5,
        targetNumbers: [150],
      }
    );
  });

  it("marks nested PR comment metadata incomplete when the bounded limit is reached", async () => {
    listIssueCommentsMock.mockResolvedValue({
      status: "success",
      value: Array.from({ length: 25 }, (_, index) => ({
        id: 10_000 + index,
        node_id: `issue-node-${index}`,
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
        html_url: `https://github.com/closedloop-ai/symphony-alpha/pull/1#issuecomment-${index}`,
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      })),
    });
    listReviewCommentsMock.mockResolvedValue({
      status: "success",
      value: Array.from({ length: 25 }, (_, index) => ({
        id: 20_000 + index,
        node_id: `review-node-${index}`,
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
        html_url: `https://github.com/closedloop-ai/symphony-alpha/pull/1#discussion_r${index}`,
        commit_id: "abc",
        pull_request_review_id: 3001,
        review_thread_node_id: `thread-node-${index}`,
        review_thread_is_resolved: false,
        in_reply_to_id: null,
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      })),
    });

    await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    expect(projectionDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [
          expect.objectContaining({
            issueCommentsComplete: false,
            reviewCommentsComplete: false,
          }),
        ],
      })
    );
  });

  it("returns the latest summary without provider fan-out while a durable run gate is active", async () => {
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        githubBackfillRunGate: {
          inFlightUntil: Date.now() + 60_000,
          cooldownUntil: 0,
        },
        githubBackfillLatestSummary: {
          status: GitHubBackfillStatus.Degraded,
          repositoryCount: 1,
          branchCount: 2,
          pullRequestCount: 3,
          branchProjectionChangeCount: 4,
          pullRequestProjectionChangeCount: 5,
          reviewDecisionProjectionChangeCount: 6,
          checkProjectionChangeCount: 7,
          issueCommentProjectionChangeCount: 8,
          reviewCommentProjectionChangeCount: 9,
          reviewThreadProjectionChangeCount: 10,
          reviewProjectionChangeCount: 11,
          statusCheckProjectionChangeCount: 12,
          skippedBranchCount: 13,
          dryRun: false,
          ownerApprovalRequired: false,
          failures: ["repo:provider_rate_limit"],
        },
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      approvedForVisibleWrites: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.failures).toEqual(["repo:provider_rate_limit"]);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(getBranchesMock).not.toHaveBeenCalled();
    expect(queryBundledPullRequestsMock).not.toHaveBeenCalled();
    expect(projectionWriteMock).not.toHaveBeenCalled();
    expect(organizationUpdateMock).not.toHaveBeenCalled();
  });

  it("bypasses only cooldown for trusted post-connect continuations", async () => {
    const latestSummary = {
      status: GitHubBackfillStatus.FirstSliceStarted,
      repositoryCount: 1,
      branchCount: 2,
      pullRequestCount: 3,
      branchProjectionChangeCount: 4,
      pullRequestProjectionChangeCount: 5,
      reviewDecisionProjectionChangeCount: 6,
      checkProjectionChangeCount: 7,
      issueCommentProjectionChangeCount: 8,
      reviewCommentProjectionChangeCount: 9,
      reviewThreadProjectionChangeCount: 10,
      reviewProjectionChangeCount: 11,
      statusCheckProjectionChangeCount: 12,
      skippedBranchCount: 13,
      dryRun: false,
      ownerApprovalRequired: false,
      failures: [],
    };
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        githubBackfillRunGate: {
          inFlightUntil: 0,
          cooldownUntil: Date.now() + 60_000,
        },
        githubBackfillLatestSummary: latestSummary,
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      approvedForVisibleWrites: true,
      bypassCooldown: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Completed);
    expect(findManyMock).toHaveBeenCalled();
    expect(projectionWriteMock).toHaveBeenCalled();
  });

  it("still blocks trusted continuations while another backfill is in flight", async () => {
    const latestSummary = {
      status: GitHubBackfillStatus.FirstSliceStarted,
      repositoryCount: 1,
      branchCount: 2,
      pullRequestCount: 3,
      branchProjectionChangeCount: 4,
      pullRequestProjectionChangeCount: 5,
      reviewDecisionProjectionChangeCount: 6,
      checkProjectionChangeCount: 7,
      issueCommentProjectionChangeCount: 8,
      reviewCommentProjectionChangeCount: 9,
      reviewThreadProjectionChangeCount: 10,
      reviewProjectionChangeCount: 11,
      statusCheckProjectionChangeCount: 12,
      skippedBranchCount: 13,
      dryRun: false,
      ownerApprovalRequired: false,
      failures: [],
    };
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        githubBackfillRunGate: {
          inFlightUntil: Date.now() + 60_000,
          cooldownUntil: 0,
        },
        githubBackfillLatestSummary: latestSummary,
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      approvedForVisibleWrites: true,
      bypassCooldown: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.FirstSliceStarted);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(projectionWriteMock).not.toHaveBeenCalled();
  });

  it("marks failed comment metadata pages incomplete before invoking the writer", async () => {
    listIssueCommentsMock.mockResolvedValueOnce({
      status: "provider_unavailable",
    });
    listReviewCommentsMock.mockResolvedValueOnce({
      status: "provider_rate_limit",
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.failures).toEqual([
      "closedloop-ai/symphony-alpha#1:issueComments:provider_unavailable",
      "closedloop-ai/symphony-alpha#1:reviewComments:provider_rate_limit",
    ]);
    expect(projectionWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [
          expect.objectContaining({
            issueComments: [],
            issueCommentsComplete: false,
            reviewComments: [],
            reviewCommentsComplete: false,
          }),
        ],
      })
    );
  });

  it("continues after a per-repository failure and reports degraded success", async () => {
    getBranchesMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({ branches: [{ name: "main" }] });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.failures).toEqual(["closedloop-ai/symphony-alpha"]);
    expect(summary.repositoryCount).toBe(2);
    expect(summary.branchCount).toBe(1);
  });

  it("returns the latest persisted summary without provider calls", async () => {
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        githubBackfillLatestSummary: {
          status: GitHubBackfillStatus.Degraded,
          repositoryCount: 1,
          branchCount: 2,
          pullRequestCount: 3,
          branchProjectionChangeCount: 4,
          pullRequestProjectionChangeCount: 5,
          reviewDecisionProjectionChangeCount: 6,
          checkProjectionChangeCount: 7,
          issueCommentProjectionChangeCount: 8,
          reviewCommentProjectionChangeCount: 9,
          reviewThreadProjectionChangeCount: 10,
          reviewProjectionChangeCount: 11,
          statusCheckProjectionChangeCount: 12,
          skippedBranchCount: 13,
          dryRun: true,
          ownerApprovalRequired: true,
          failures: ["repo:provider_rate_limit"],
        },
      },
    });

    const summary =
      await githubBackfillService.getLatestBackfillSummary("org-1");

    expect(summary.repositoryCount).toBe(1);
    expect(summary.failures).toEqual(["repo:provider_rate_limit"]);
    expect(summary.statusCheckProjectionChangeCount).toBe(12);
    expect(queryBundledPullRequestsMock).not.toHaveBeenCalled();
  });

  it("returns not_started when no latest summary has been persisted", async () => {
    organizationFindUniqueMock.mockResolvedValueOnce({ settings: {} });

    const summary =
      await githubBackfillService.getLatestBackfillSummary("org-1");

    expect(summary.status).toBe(GitHubBackfillStatus.NotStarted);
    expect(summary.repositoryCount).toBe(0);
    expect(summary.dryRun).toBe(true);
    expect(summary.issueCommentProjectionChangeCount).toBe(0);
  });
});
