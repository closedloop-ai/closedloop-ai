import { BranchViewSyncScope } from "@repo/api/src/types/branch-view";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import type * as DatabaseModule from "@repo/database";
import type * as GitHubModule from "@repo/github";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAcquireInstallationClient,
  mockListPullRequestIssueComments,
  mockListPullRequestReviewComments,
  mockListPullRequestReviews,
  mockRecomputeAndUpdateAggregate,
  mockResolveExternalGitHubAuthorInTransaction,
  mockSoftDeleteGitHubCommentProjection,
  mockUpsertGitHubIssueCommentThread,
  mockUpsertGitHubReviewCommentThread,
  mockWithDb,
} = vi.hoisted(() => ({
  mockAcquireInstallationClient: vi.fn(),
  mockListPullRequestIssueComments: vi.fn(),
  mockListPullRequestReviewComments: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockRecomputeAndUpdateAggregate: vi.fn(),
  mockResolveExternalGitHubAuthorInTransaction: vi.fn(),
  mockSoftDeleteGitHubCommentProjection: vi.fn(),
  mockUpsertGitHubIssueCommentThread: vi.fn(),
  mockUpsertGitHubReviewCommentThread: vi.fn(),
  mockWithDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  withDb: mockWithDb,
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubModule>()),
  listPullRequestIssueCommentsWithProviderResult:
    mockListPullRequestIssueComments,
  listPullRequestReviewCommentsWithProviderResult:
    mockListPullRequestReviewComments,
  listPullRequestReviewsWithProviderResult: mockListPullRequestReviews,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/app/comments/external-authors", () => ({
  normalizeExternalGitHubAuthor: (
    author: { id?: number | null; actorType?: GitHubActorType } | null
  ) => ({
    providerUserId: String(author?.id ?? "ghost"),
    isGhost: author?.id == null,
    ...(author?.actorType ? { actorType: author.actorType } : {}),
  }),
  normalizeGitHubLogin: (login: string) => login.trim().toLowerCase(),
  resolveExternalGitHubAuthorInTransaction:
    mockResolveExternalGitHubAuthorInTransaction,
}));

vi.mock("@/app/comments/github-diff-side", () => ({
  normalizeGitHubDiffSide: (side: string | null | undefined) =>
    side === "LEFT" || side === "RIGHT" ? side : null,
}));

vi.mock("@/app/comments/github-projection", () => ({
  softDeleteGitHubCommentProjection: mockSoftDeleteGitHubCommentProjection,
  upsertGitHubIssueCommentThread: mockUpsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread: mockUpsertGitHubReviewCommentThread,
}));

vi.mock("@/lib/github/installation-client", () => ({
  acquireInstallationClient: mockAcquireInstallationClient,
}));

vi.mock("@/lib/review-decision-utils", () => ({
  recomputeAndUpdateAggregate: mockRecomputeAndUpdateAggregate,
}));

import { currentPrContext } from "@/__tests__/utils/branch-view-pr-context";
import { syncCommentsAndReviews } from "./service";

const INSTALLATION_CLIENT = { marker: "installation-client" };
const AUTHOR_WITHOUT_ACTOR_TYPE = {
  id: 501,
  login: "same-author",
  node_id: "MDQ6VXNlcjUwMQ==",
  avatar_url: "https://avatars.example/same-author.png",
};
const AUTHOR_WITH_ACTOR_TYPE = {
  ...AUTHOR_WITHOUT_ACTOR_TYPE,
  actorType: GitHubActorType.Bot,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireInstallationClient.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: INSTALLATION_CLIENT,
  });
  mockListPullRequestIssueComments.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: [issueComment(AUTHOR_WITHOUT_ACTOR_TYPE)],
  });
  mockListPullRequestReviewComments.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: [reviewComment(AUTHOR_WITH_ACTOR_TYPE)],
  });
  mockListPullRequestReviews.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: [],
  });
  mockResolveExternalGitHubAuthorInTransaction.mockResolvedValue({
    user: { id: "github-user-1" },
    externalAuthor: { id: "external-author-1" },
  });
  mockSoftDeleteGitHubCommentProjection.mockResolvedValue({
    comments: 0,
    threads: 0,
  });
  mockWithDb.tx.mockImplementation((callback) =>
    callback({ gitHubPRReview: { upsert: vi.fn() } })
  );
});

describe("syncCommentsAndReviews author evidence", () => {
  it("re-resolves the same author when a later live comment supplies actor type", async () => {
    const result = await syncCommentsAndReviews(currentPrContext());

    expect(result).toEqual({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Comments,
    });
    expect(mockResolveExternalGitHubAuthorInTransaction).toHaveBeenCalledTimes(
      2
    );
    expect(
      mockResolveExternalGitHubAuthorInTransaction.mock.calls[0]?.[1].author
    ).not.toHaveProperty("actorType");
    expect(
      mockResolveExternalGitHubAuthorInTransaction.mock.calls[1]?.[1]
    ).toMatchObject({
      author: { id: 501, actorType: GitHubActorType.Bot },
      organizationId: "org-1",
      source: {
        githubObjectId: "102",
        sourceKind: "review_comment",
      },
    });
    expect(mockUpsertGitHubIssueCommentThread).toHaveBeenCalledTimes(1);
    expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledTimes(1);
  });
});

function issueComment(user: typeof AUTHOR_WITHOUT_ACTOR_TYPE) {
  return {
    id: 101,
    node_id: "IC_kwDO_issue_101",
    user,
    body: "Issue comment without actor evidence",
    author_association: "CONTRIBUTOR",
    created_at: "2026-08-03T20:00:00.000Z",
    updated_at: "2026-08-03T20:00:00.000Z",
    html_url: "https://github.com/acme/repo/pull/42#issuecomment-101",
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}

function reviewComment(user: typeof AUTHOR_WITH_ACTOR_TYPE) {
  return {
    id: 102,
    node_id: "PRRC_kwDO_review_102",
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 1,
    original_start_line: null,
    body: "Review comment with actor evidence",
    user,
    author_association: "CONTRIBUTOR",
    created_at: "2026-08-03T20:01:00.000Z",
    updated_at: "2026-08-03T20:01:00.000Z",
    html_url: "https://github.com/acme/repo/pull/42#discussion_r102",
    commit_id: "abcdef123456",
    pull_request_review_id: null,
    review_thread_node_id: "PRRT_kwDO_thread_102",
    review_thread_is_resolved: false,
    in_reply_to_id: null,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}
