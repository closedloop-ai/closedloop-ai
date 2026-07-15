import {
  BranchCommentsState,
  BranchDataState,
  BranchPrCommentKind,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  GitHubBackfillStatus,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubProviderBudgetState,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { GitHubInstallationStatus } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBranchesMock = vi.fn();
const getPullRequestsMock = vi.fn();
const queryBundledPullRequestsMock = vi.fn();
const listIssueCommentsMock = vi.fn();
const listReviewCommentsMock = vi.fn();
const listReviewsMock = vi.fn();
const queryStatusCheckRollupMock = vi.fn();

vi.mock("@repo/database", () => ({
  ArtifactType: { BRANCH: "BRANCH", SESSION: "SESSION" },
  GitHubCommentThreadKind: {
    ISSUE_COMMENT: "ISSUE_COMMENT",
    REVIEW_THREAD: "REVIEW_THREAD",
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  GitHubLegacyCommentState: {
    PENDING: "PENDING",
    ADDRESSED: "ADDRESSED",
  },
  GitHubDiffSide: {
    LEFT: "LEFT",
    RIGHT: "RIGHT",
  },
  ThreadStatus: {
    OPEN: "OPEN",
    RESOLVED: "RESOLVED",
  },
  ThreadSource: {
    GITHUB: "GITHUB",
  },
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  withDb: Object.assign((callback: (db: unknown) => unknown) => callback(db), {
    tx: (callback: (db: unknown) => unknown) => callback(db),
  }),
}));

vi.mock("@/app/comments/external-authors", () => ({
  normalizeExternalGitHubAuthor: (author: { id?: number | null } | null) => ({
    providerUserId: String(author?.id ?? "ghost"),
    isGhost: author?.id == null,
  }),
  resolveExternalGitHubAuthorInTransaction: vi.fn(
    (
      _tx: unknown,
      input: {
        author: {
          login?: string | null;
          avatar_url?: string | null;
        } | null;
      }
    ) => ({
      user: { id: `user-${input.author?.login ?? "unknown"}` },
      externalAuthor: {
        id: `external-author-${input.author?.login ?? "unknown"}`,
      },
    })
  ),
}));

vi.mock("@repo/github", () => ({
  GitHubProviderResultStatus: {
    Success: "success",
    ProviderRateLimit: "provider_rate_limit",
    ProviderUnavailable: "provider_unavailable",
  },
  getSinglePullRequestWithProviderResult: vi.fn(),
  listPullRequestIssueCommentsWithProviderResult: listIssueCommentsMock,
  listPullRequestReviewCommentsWithProviderResult: listReviewCommentsMock,
  listPullRequestReviewsWithProviderResult: listReviewsMock,
  queryBundledPullRequestsWithProviderResult: queryBundledPullRequestsMock,
  queryStatusCheckRollupWithProviderResult: queryStatusCheckRollupMock,
}));

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange: vi.fn(),
  persistBranchStatusChecksFromRollup: vi.fn(
    (
      _tx: unknown,
      input: {
        rollup: { ok: boolean; totalCount?: number };
      }
    ) => {
      state.branch.checksDetailTotalCount = input.rollup.ok
        ? (input.rollup.totalCount ?? 0)
        : 0;
      return {
        status: "updated",
        checksStatusChanged: false,
        previousChecksStatus: state.branch.checksStatus,
        nextChecksStatus: state.branch.checksStatus,
      };
    }
  ),
}));

vi.mock("./service", () => ({
  githubService: {
    getBranches: getBranchesMock,
    getPullRequests: getPullRequestsMock,
  },
}));

const { branchReadService } = await import(
  "@/app/branches/branch-read-service"
);
const { branchCommentsService } = await import(
  "@/app/branches/branch-comments-service"
);
const { githubBackfillService } = await import("./backfill-service");

const branchArtifactId = "11111111-1111-4111-8111-111111111111";
const organizationId = "org-1";
const repositoryId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-07-05T00:00:00.000Z");

const state = {
  branch: {
    artifactId: branchArtifactId,
    repositoryId,
    branchName: "feature/backfill",
    baseBranch: null as string | null,
    headSha: null as string | null,
    lastActivityAt: null as Date | null,
    syncStatus: "idle",
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncErrorCode: null,
    checksStatus: ChecksStatus.Unknown,
    checksDetailTotalCount: 0,
    currentPullRequestDetailId: null as string | null,
    currentPullRequestDetail: null as StoredPullRequest | null,
    fileChanges: [] as { additions: number; deletions: number; path: string }[],
  },
  organizationSettings: {} as Record<string, unknown>,
  pullRequest: null as StoredPullRequest | null,
  comments: [] as StoredComment[],
  commentThreads: [] as StoredCommentThread[],
  commentProjections: [] as StoredCommentProjection[],
  threadProjections: [] as StoredThreadProjection[],
  reviews: [] as StoredReview[],
};

const db = {
  artifact: {
    count: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  artifactLink: {
    findMany: vi.fn(),
  },
  branchDetail: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  branchStatusCheck: {
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  gitHubInstallationRepository: {
    findMany: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  pullRequestDetail: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  gitHubPRReview: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  commentThread: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  comment: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  gitHubCommentProjection: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  gitHubCommentThreadProjection: {
    findMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
};

describe("GitHub backfill real boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    db.gitHubInstallationRepository.findMany.mockResolvedValue([
      {
        id: repositoryId,
        fullName: "closedloop-ai/symphony-alpha",
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "123" },
      },
    ]);
    db.organization.findUnique.mockResolvedValue({
      settings: state.organizationSettings,
    });
    db.organization.update.mockImplementation(({ data }) => {
      state.organizationSettings = data.settings;
      return {};
    });
    db.branchDetail.findFirst.mockImplementation(async () => state.branch);
    db.branchDetail.findMany.mockImplementation(async () => [state.branch]);
    db.branchDetail.update.mockImplementation(({ data }) => {
      Object.assign(state.branch, data);
      return state.branch;
    });
    db.branchDetail.updateMany.mockImplementation(({ data }) => {
      Object.assign(state.branch, data);
      return { count: 1 };
    });
    db.branchStatusCheck.deleteMany.mockResolvedValue({ count: 0 });
    db.branchStatusCheck.findMany.mockResolvedValue([]);
    db.pullRequestDetail.findMany.mockImplementation(async () =>
      state.pullRequest ? [state.pullRequest] : []
    );
    db.pullRequestDetail.findUnique.mockImplementation(
      async () => state.pullRequest
    );
    // FEA-3212: adopt now selects the single repo-less (githubId=null) row via
    // findFirst before the githubId-keyed upsert.
    db.pullRequestDetail.findFirst.mockImplementation(async () =>
      state.pullRequest && state.pullRequest.githubId == null
        ? { id: state.pullRequest.id ?? "pr-detail-1" }
        : null
    );
    db.pullRequestDetail.update.mockImplementation(({ data }) => {
      state.pullRequest = { ...state.pullRequest!, ...data };
      state.branch.currentPullRequestDetail = state.pullRequest;
      return state.pullRequest;
    });
    db.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
    db.pullRequestDetail.upsert.mockImplementation(({ create, update }) => {
      const pullRequest = {
        id: "pr-detail-1",
        ...state.pullRequest,
        ...(state.pullRequest ? update : create),
      };
      state.pullRequest = pullRequest;
      state.branch.currentPullRequestDetail = pullRequest;
      return { id: pullRequest.id };
    });
    db.gitHubPRReview.findMany.mockImplementation(async ({ where }) =>
      state.reviews
        .filter((review) => review.pullRequestId === where.pullRequestId)
        .map((review) => ({ state: review.state }))
    );
    db.gitHubPRReview.upsert.mockImplementation(({ create, update, where }) => {
      const existingIndex = state.reviews.findIndex(
        (review) =>
          review.pullRequestId ===
            where.pullRequestId_authorLogin.pullRequestId &&
          review.authorLogin === where.pullRequestId_authorLogin.authorLogin
      );
      const next =
        existingIndex === -1
          ? { ...create }
          : { ...state.reviews[existingIndex], ...update };
      if (existingIndex === -1) {
        state.reviews.push(next);
      } else {
        state.reviews[existingIndex] = next;
      }
      return next;
    });
    db.commentThread.create.mockImplementation(({ data }) => {
      const thread = {
        id: `thread-${state.commentThreads.length + 1}`,
        ...data,
        updatedAt: now,
      };
      state.commentThreads.push(thread);
      return { id: thread.id };
    });
    db.commentThread.findUnique.mockImplementation(
      ({ where }) =>
        state.commentThreads.find(
          (thread) =>
            thread.organizationId ===
              where.organizationId_externalId.organizationId &&
            thread.externalId === where.organizationId_externalId.externalId
        ) ?? null
    );
    db.commentThread.update.mockImplementation(({ data, where }) => {
      const thread = state.commentThreads.find((row) => row.id === where.id);
      if (!thread) {
        return null;
      }
      Object.assign(thread, data);
      return { id: thread.id };
    });
    db.comment.findFirst.mockImplementation(
      ({ where }) => findCommentByExternalId(where.externalId) ?? null
    );
    db.comment.findUnique.mockImplementation(
      ({ where }) => findCommentByExternalId(where.externalId) ?? null
    );
    db.comment.findMany.mockImplementation((args) => {
      if (args.select?.body) {
        return projectedCommentRows();
      }
      return [];
    });
    db.comment.create.mockImplementation(({ data }) => {
      const comment = {
        id: `comment-${state.comments.length + 1}`,
        threadId: data.threadId,
        externalId: data.externalId,
        body: data.body,
        plainText: data.plainText,
        parentCommentId: data.parentCommentId ?? null,
        deletedAt: null,
        createdAt: data.createdAt,
        updatedAt: now,
      };
      state.comments.push(comment);
      return { id: comment.id, threadId: comment.threadId };
    });
    db.comment.update.mockImplementation(({ data, where }) => {
      const comment =
        state.comments.find((row) => row.id === where.id) ??
        findCommentByExternalId(where.externalId);
      if (!comment) {
        return null;
      }
      Object.assign(comment, data, { updatedAt: now });
      return { id: comment.id, threadId: comment.threadId };
    });
    db.gitHubCommentProjection.findFirst.mockImplementation(
      ({ where }) =>
        state.commentProjections.find(
          (projection) =>
            projection.githubCommentId === where.githubCommentId &&
            projection.githubDeletedAt === null
        ) ?? null
    );
    db.gitHubCommentProjection.findMany.mockResolvedValue([]);
    db.gitHubCommentProjection.update.mockImplementation(({ data, where }) => {
      const projection = state.commentProjections.find(
        (row) => row.commentId === where.commentId
      );
      if (projection) {
        Object.assign(projection, data);
      }
      return projection ?? null;
    });
    db.gitHubCommentProjection.upsert.mockImplementation(
      ({ create, update, where }) => {
        const existingIndex = state.commentProjections.findIndex(
          (projection) => projection.commentId === where.commentId
        );
        const next =
          existingIndex === -1
            ? { ...create }
            : { ...state.commentProjections[existingIndex], ...update };
        if (existingIndex === -1) {
          state.commentProjections.push(next);
        } else {
          state.commentProjections[existingIndex] = next;
        }
        return next;
      }
    );
    db.gitHubCommentThreadProjection.findMany.mockResolvedValue([]);
    db.gitHubCommentThreadProjection.update.mockImplementation(
      ({ data, where }) => {
        const projection = state.threadProjections.find(
          (row) => row.threadId === where.threadId
        );
        if (projection) {
          Object.assign(projection, data);
        }
        return projection ?? null;
      }
    );
    db.gitHubCommentThreadProjection.upsert.mockImplementation(
      ({ create, update, where }) => {
        const existingIndex = state.threadProjections.findIndex(
          (projection) => projection.threadId === where.threadId
        );
        const next =
          existingIndex === -1
            ? { ...create }
            : { ...state.threadProjections[existingIndex], ...update };
        if (existingIndex === -1) {
          state.threadProjections.push(next);
        } else {
          state.threadProjections[existingIndex] = next;
        }
        return next;
      }
    );
    db.$executeRaw.mockResolvedValue(1);
    db.$queryRaw
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([{ id: branchArtifactId }]);
    db.artifact.count.mockResolvedValue(1);
    db.artifact.findFirst.mockImplementation(async () => branchArtifactRow());
    db.artifact.findMany.mockImplementation(async () => [branchArtifactRow()]);
    db.artifactLink.findMany.mockResolvedValue([]);
    getBranchesMock.mockResolvedValue({
      branches: [{ name: "feature/backfill" }],
    });
    getPullRequestsMock.mockResolvedValue({ pullRequests: [{ number: 42 }] });
    queryBundledPullRequestsMock.mockResolvedValue({
      status: "success",
      value: {
        pullRequests: [providerPullRequest()],
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
      value: [providerIssueComment()],
    });
    listReviewCommentsMock.mockResolvedValue({
      status: "success",
      value: [providerReviewComment()],
    });
    listReviewsMock.mockResolvedValue({
      status: "success",
      value: [providerReview()],
    });
    queryStatusCheckRollupMock.mockResolvedValue({
      status: "success",
      value: providerStatusCheckRollup(),
    });
  });

  it("writes provider projections and exposes them through the Branches row contract", async () => {
    const dryRunSummary = await githubBackfillService.runPostConnectBackfill({
      organizationId,
      repositoryLimit: 1,
    });

    expect(dryRunSummary.status).toBe(
      GitHubBackfillStatus.OwnerApprovalRequired
    );
    expect(dryRunSummary.dryRun).toBe(true);
    expect(state.pullRequest).toBeNull();

    const writeSummary = await githubBackfillService.runPostConnectBackfill({
      organizationId,
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });
    const list = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });
    const comments = await branchCommentsService.getBranchComments(
      organizationId,
      branchArtifactId
    );

    expect(writeSummary.failures).toEqual([]);
    expect(writeSummary).toMatchObject({
      status: GitHubBackfillStatus.Completed,
      dryRun: false,
      ownerApprovalRequired: false,
      pullRequestProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
    });
    expect(list).toMatchObject({
      total: 1,
      viewerScope: BranchViewerScope.Organization,
      items: [
        expect.objectContaining({
          id: branchArtifactId,
          dataState: BranchDataState.NoSessions,
          status: BranchStatus.Open,
          prNumber: 42,
          prTitle: "Backfilled PR",
          checksStatus: ChecksStatus.Passing,
          checksTotal: 1,
          reviewDecision: ReviewDecision.Approved,
        }),
      ],
    });
    expect(comments).toMatchObject({
      branchId: branchArtifactId,
      state: BranchCommentsState.StaleMixed,
      comments: [
        expect.objectContaining({
          kind: BranchPrCommentKind.Issue,
          providerCommentId: "1001",
          body: "Backfilled issue comment",
        }),
        expect.objectContaining({
          kind: BranchPrCommentKind.Review,
          providerCommentId: "2001",
          body: "Backfilled review comment",
          resolved: true,
        }),
      ],
    });
  });
});

type StoredPullRequest = {
  id: string;
  githubId: string;
  number: number;
  title: string | null;
  htmlUrl: string | null;
  body: string | null;
  prState: GitHubPRState;
  isDraft: boolean;
  isCurrent: boolean;
  reviewDecision: ReviewDecision | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
};

function resetState(): void {
  state.branch.baseBranch = null;
  state.branch.headSha = null;
  state.branch.lastActivityAt = null;
  state.branch.checksStatus = ChecksStatus.Unknown;
  state.branch.checksDetailTotalCount = 0;
  state.branch.currentPullRequestDetailId = null;
  state.branch.currentPullRequestDetail = null;
  state.organizationSettings = {};
  state.pullRequest = null;
  state.comments = [];
  state.commentThreads = [];
  state.commentProjections = [];
  state.threadProjections = [];
  state.reviews = [];
}

function branchArtifactRow() {
  return {
    id: branchArtifactId,
    name: "feature/backfill",
    status: GitHubPRState.Open,
    externalUrl: null,
    createdAt: now,
    pullRequestDetails: state.pullRequest ? [state.pullRequest] : [],
    branch: {
      ...state.branch,
      deletedAt: null,
      repository: {
        id: repositoryId,
        fullName: "closedloop-ai/symphony-alpha",
        name: "symphony-alpha",
        owner: "closedloop-ai",
        removedAt: null,
        installation: {
          organizationId,
          installationId: "123",
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
    },
  };
}

function providerPullRequest() {
  return {
    githubId: "4242",
    number: 42,
    title: "Backfilled PR",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    headBranch: "feature/backfill",
    baseBranch: "main",
    headSha: "abc123",
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
    updatedAt: now.toISOString(),
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

function providerIssueComment() {
  return {
    id: 1001,
    node_id: "issue-node-1001",
    user: {
      id: 501,
      login: "octocat",
      node_id: "user-node-501",
      avatar_url: "https://avatars.githubusercontent.com/u/501",
    },
    body: "Backfilled issue comment",
    author_association: "MEMBER",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    html_url:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-1001",
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}

function providerReviewComment() {
  return {
    id: 2001,
    node_id: "review-node-2001",
    path: "apps/api/app/example.ts",
    line: 12,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 12,
    original_start_line: null,
    body: "Backfilled review comment",
    user: {
      id: 502,
      login: "reviewer",
      node_id: "user-node-502",
      avatar_url: "https://avatars.githubusercontent.com/u/502",
    },
    author_association: "MEMBER",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    html_url:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2001",
    commit_id: "abc123",
    pull_request_review_id: 3001,
    review_thread_node_id: "thread-node-2001",
    review_thread_is_resolved: true,
    in_reply_to_id: null,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}

function providerReview() {
  return {
    id: 3001,
    user: {
      login: "reviewer",
      avatar_url: "https://avatars.githubusercontent.com/u/502",
    },
    state: ReviewDecision.Approved,
    body: "Approved",
    submitted_at: now.toISOString(),
    html_url:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#pullrequestreview-3001",
  };
}

function providerStatusCheckRollup() {
  return {
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
  };
}

function findCommentByExternalId(
  externalId: string | undefined
): StoredComment | null {
  if (!externalId) {
    return null;
  }
  return (
    state.comments.find((comment) => comment.externalId === externalId) ?? null
  );
}

function projectedCommentRows() {
  return state.comments
    .filter((comment) => comment.deletedAt === null)
    .map((comment) => {
      const projection = state.commentProjections.find(
        (row) => row.commentId === comment.id
      );
      const thread = state.commentThreads.find(
        (row) => row.id === comment.threadId
      );
      const threadProjection = state.threadProjections.find(
        (row) => row.threadId === comment.threadId
      );
      return {
        id: comment.id,
        body: comment.body,
        plainText: comment.plainText,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        deletedAt: comment.deletedAt,
        githubProjection: projection
          ? {
              githubCommentId: projection.githubCommentId,
              githubInReplyToCommentId: projection.githubInReplyToCommentId,
              githubHtmlUrl: projection.githubHtmlUrl,
              githubUpdatedAt: projection.githubUpdatedAt,
              githubDeletedAt: projection.githubDeletedAt,
              externalAuthor: {
                providerLogin:
                  projection.externalAuthorId === "external-author-reviewer"
                    ? "reviewer"
                    : "octocat",
                displayName: null,
                avatarUrl: null,
                profileUrl: null,
              },
            }
          : null,
        thread: {
          id: comment.threadId,
          status: thread?.status ?? "OPEN",
          githubProjection: threadProjection
            ? {
                threadKind: threadProjection.threadKind,
                path: threadProjection.path,
                line: threadProjection.line,
                legacyState: threadProjection.legacyState,
                lastSyncedAt: threadProjection.lastSyncedAt,
              }
            : null,
        },
      };
    });
}

type StoredComment = {
  id: string;
  threadId: string;
  externalId: string;
  body: unknown;
  plainText: string;
  parentCommentId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type StoredCommentThread = {
  id: string;
  organizationId: string;
  source: string;
  externalId: string;
  artifactId: string;
  status: string;
  updatedAt: Date;
};

type StoredCommentProjection = {
  commentId: string;
  threadId: string;
  externalAuthorId: string | null;
  githubCommentId: string;
  githubInReplyToCommentId: string | null;
  githubHtmlUrl: string | null;
  githubUpdatedAt: Date | null;
  githubDeletedAt: Date | null;
};

type StoredThreadProjection = {
  threadId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  threadKind: string;
  reviewThreadId: string | null;
  rootCommentId: string;
  reviewId: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  startLine: number | null;
  startSide: string | null;
  commitSha: string | null;
  htmlUrl: string | null;
  resolvable: boolean;
  legacyState: string;
  deletedAt: Date | null;
  lastSyncedAt: Date;
};

type StoredReview = {
  pullRequestId: string;
  githubReviewId: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  state: ReviewDecision;
  body: string | null;
  htmlUrl: string;
  submittedAt: Date;
};
