import {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  ThreadStatus,
  withDb,
} from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMockPullRequestDetails } from "../../__tests__/fixtures/branch-pull-request-details";
import { BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT } from "./branch-remote-evidence";

const WRITE_AFFORDANCE_KEYS_REGEX =
  /canReply|viewerCan|action|mutation|replyUrl|editUrl|deleteUrl|resolveUrl|capabilityContext/;

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
  listPullRequestIssueCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewsWithProviderResult: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: mocks.withDb,
  };
});

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  return {
    ...actual,
    listPullRequestIssueCommentsWithProviderResult:
      mocks.listPullRequestIssueCommentsWithProviderResult,
    listPullRequestReviewCommentsWithProviderResult:
      mocks.listPullRequestReviewCommentsWithProviderResult,
    listPullRequestReviewsWithProviderResult:
      mocks.listPullRequestReviewsWithProviderResult,
  };
});

import { branchCommentsService } from "./branch-comments-service";

describe("branchCommentsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: { findFirst: mocks.artifactFindFirst },
        comment: { findMany: mocks.commentFindMany },
      })
    );
    mocks.artifactFindFirst.mockResolvedValue(branchContextRow());
    mocks.commentFindMany.mockResolvedValue([]);
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
    mocks.listPullRequestReviewsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
  });

  it("reads only active GitHub comment projections for the scoped branch PR", async () => {
    mocks.commentFindMany.mockResolvedValue([projectionRow()]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.StaleMixed);
    expect(result?.comments[0]).toMatchObject({
      providerCommentId: "123456",
      kind: BranchPrCommentKind.Review,
    });
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          githubProjection: { is: { githubDeletedAt: null } },
        }),
      })
    );
  });

  it("treats legacyState and lastSyncedAt as stale mixed evidence, not synced empty proof", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        legacyState: GitHubLegacyCommentState.ADDRESSED,
        lastSyncedAt: new Date("2026-07-03T12:00:00.000Z"),
      }),
    ]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.StaleMixed,
      stale: true,
      mixedProjection: true,
      providerProofedAt: null,
    });
    expect(result?.comments[0]?.stale).toBe(true);
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("requires current-request provider proof before returning synced empty", async () => {
    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.SyncedEmpty);
    expect(result?.providerProofedAt).toEqual(expect.any(String));
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      "installation-1",
      "closedloop-ai",
      "symphony-alpha",
      42,
      { limit: 101, pageSize: 50 }
    );
    expect(
      (withDb as unknown as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(2);
  });

  it("returns null for an unpushed branch (no push state, no current PR) without fetching comments", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: null,
        firstPushedAt: null,
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("scopes context lookup to non-deleted branches before fetching comments", async () => {
    mocks.artifactFindFirst.mockResolvedValue(null);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toBeNull();
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branch: { deletedAt: null },
        }),
      })
    );
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("rejects current PR evidence from a different branch repository", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "pr-detail-1",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        },
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("does not use mismatched current PR details when remote head evidence is present", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "pr-detail-1",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        },
        firstPushedAt: new Date("2026-07-03T00:00:00.000Z"),
        pullRequestDetails: [],
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("uses branch-owned current PR rows when the current pointer is stale", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "foreign-current-pr-detail",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        },
        pullRequestDetails: [
          {
            id: "foreign-fallback-pr-detail",
            branchArtifactId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "repository-2",
            isCurrent: true,
            number: 99,
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/99",
          },
          {
            id: "owned-pr-detail",
            branchArtifactId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "repository-1",
            isCurrent: true,
            number: 17,
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/17",
          },
        ],
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.SyncedEmpty,
      prNumber: 17,
      prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/17",
    });
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          pullRequestDetails: expect.objectContaining({
            orderBy: [
              { repositoryId: "asc" },
              { number: "desc" },
              { id: "asc" },
            ],
            take: BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
          }),
        }),
      })
    );
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      "installation-1",
      "closedloop-ai",
      "symphony-alpha",
      17,
      {
        limit: 101,
        pageSize: 50,
      }
    );
  });

  it("uses review comments as provider proof before returning synced empty", async () => {
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerReviewComment()],
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.Populated);
    expect(result?.comments).toHaveLength(1);
    expect(result?.comments[0]).toMatchObject({
      kind: BranchPrCommentKind.Review,
      providerCommentId: "987",
      path: "packages/app/branches/components/pr-comments-panel.tsx",
    });
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      "installation-1",
      "closedloop-ai",
      "symphony-alpha",
      42,
      { includeReviewThreadMetadata: false, limit: 101, pageSize: 50 }
    );
  });

  it("marks count-budget truncation with the over-limit state", async () => {
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: Array.from({ length: 101 }, (_, index) =>
        providerIssueComment(index + 1)
      ),
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.OverLimitTruncated);
    expect(result?.comments).toHaveLength(100);
    expect(result?.budget).toMatchObject({
      providerTruncated: true,
      omittedComments: 1,
    });
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("stops provider proof calls at the comments budget plus sentinel", async () => {
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: Array.from({ length: 101 }, (_, index) =>
        providerIssueComment(index + 1)
      ),
    });

    await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      "installation-1",
      "closedloop-ai",
      "symphony-alpha",
      42,
      { limit: 101, pageSize: 50 }
    );
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("returns a read-only comments DTO key set", async () => {
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerReviewComment()],
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(Object.keys(result ?? {}).sort()).toEqual([
      "branchId",
      "budget",
      "comments",
      "mixedProjection",
      "prNumber",
      "prUrl",
      "providerProofedAt",
      "stale",
      "state",
    ]);
    expect(Object.keys(result?.comments[0] ?? {}).sort()).toEqual([
      "author",
      "body",
      "bodyTruncated",
      "createdAt",
      "id",
      "inReplyToId",
      "kind",
      "line",
      "path",
      "providerCommentId",
      "providerNodeId",
      "providerUrl",
      "resolved",
      "stale",
      "threadId",
      "updatedAt",
    ]);
    expect(JSON.stringify(result)).not.toMatch(WRITE_AFFORDANCE_KEYS_REGEX);
  });
});

function branchContextRow(
  overrides: {
    currentPullRequestDetail?: {
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      isCurrent: boolean;
      number: number;
      htmlUrl: string;
    } | null;
    deletedAt?: Date | null;
    firstPushedAt?: Date | null;
    pullRequestDetails?: Array<{
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      isCurrent: boolean;
      number: number;
      htmlUrl: string;
    }>;
    repositoryId?: string;
  } = {}
) {
  const branchId = "11111111-1111-4111-8111-111111111111";
  const repositoryId = overrides.repositoryId ?? "repository-1";
  const currentPullRequestDetail =
    overrides.currentPullRequestDetail === undefined
      ? {
          id: "pr-detail-1",
          branchArtifactId: branchId,
          repositoryId,
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        }
      : overrides.currentPullRequestDetail;
  const pullRequestDetails = resolveMockPullRequestDetails(
    overrides,
    currentPullRequestDetail
  );
  return {
    id: branchId,
    pullRequestDetails,
    branch: {
      deletedAt: overrides.deletedAt ?? null,
      firstPushedAt: overrides.firstPushedAt ?? null,
      repositoryId,
      currentPullRequestDetail,
      repository: {
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "installation-1" },
      },
    },
  };
}

function projectionRow(
  overrides: {
    legacyState?: GitHubLegacyCommentState | null;
    lastSyncedAt?: Date | null;
  } = {}
) {
  return {
    id: "comment-1",
    body: { markdown: "Please cover desktop parity." },
    plainText: "Please cover desktop parity.",
    createdAt: new Date("2026-07-03T10:00:00.000Z"),
    updatedAt: new Date("2026-07-03T10:01:00.000Z"),
    deletedAt: null,
    githubProjection: {
      githubCommentId: "123456",
      githubInReplyToCommentId: null,
      githubHtmlUrl:
        "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r123456",
      githubUpdatedAt: new Date("2026-07-03T10:02:00.000Z"),
      githubDeletedAt: null,
      externalAuthor: {
        providerLogin: "reviewer",
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
      },
    },
    thread: {
      id: "thread-1",
      status: ThreadStatus.OPEN,
      githubProjection: {
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        path: "apps/api/app/branches/branch-comments-service.ts",
        line: 12,
        legacyState: overrides.legacyState ?? GitHubLegacyCommentState.PENDING,
        lastSyncedAt:
          overrides.lastSyncedAt ?? new Date("2026-07-03T10:02:00.000Z"),
      },
    },
  };
}

function providerIssueComment(id: number) {
  return {
    id,
    node_id: `IC_${id}`,
    user: {
      id,
      login: "reviewer",
      node_id: `U_${id}`,
      avatar_url: "https://github.com/avatar.png",
    },
    body: `Issue comment ${id}`,
    author_association: "MEMBER",
    created_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:00:00.000Z",
    html_url: `https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-${id}`,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}

function providerReviewComment() {
  return {
    id: 987,
    node_id: "PRRC_987",
    path: "packages/app/branches/components/pr-comments-panel.tsx",
    line: 12,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 12,
    original_start_line: null,
    body: "Review-only comment",
    user: {
      id: 7,
      login: "reviewer",
      node_id: "U_7",
      avatar_url: "https://github.com/avatar.png",
    },
    author_association: "MEMBER",
    created_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:00:00.000Z",
    html_url:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r987",
    commit_id: "abc",
    pull_request_review_id: 456,
    review_thread_node_id: "PRRT_1",
    review_thread_is_resolved: false,
    in_reply_to_id: null,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}
