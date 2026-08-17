import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
  GitHubCommentThreadKind,
  GitHubDiffSide,
} from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { withDb } from "@repo/database";
import {
  createPullRequestReviewCommentWithUserToken,
  createReplyForReviewCommentWithUserToken,
  deletePullRequestReviewCommentWithUserToken,
  updatePullRequestReviewCommentWithUserToken,
} from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authContext,
  isProjectedCommentLookup,
  type ProjectedCommentQuery,
  prContext,
  projectedCommentRow,
  providerComment,
  reviewTargetRow,
  testUser,
  WRITE_OCTOKIT,
  writeIdentity,
  writeIdentityStatus,
} from "@/__tests__/support/branch-view/direct-write.test-fixtures";
import { requireGitHubWriteIdentity } from "@/app/comments/github-identity";
import { upsertGitHubReviewCommentThread } from "@/app/comments/github-projection";
import {
  createInlineReviewComment,
  deleteReviewComment,
  editReviewComment,
  isInlineAnchorInPatch,
  replyToReviewComment,
  resolveReviewThread,
} from "./direct-write-service";

const mocks = vi.hoisted(() => {
  const withDbMock = vi.fn();
  return {
    branchFileChangeFindUnique: vi.fn(),
    commentFindFirst: vi.fn(),
    commentUpdate: vi.fn(),
    commentThreadUpdate: vi.fn(),
    threadProjectionUpdate: vi.fn(),
    createPullRequestReviewCommentWithUserToken: vi.fn(),
    createReplyForReviewCommentWithUserToken: vi.fn(),
    deletePullRequestReviewCommentWithUserToken: vi.fn(),
    resolvePullRequestReviewThreadWithUserToken: vi.fn(),
    getGitHubWriteIdentityStatus: vi.fn(),
    gitHubCommentProjectionUpdateMany: vi.fn(),
    requireGitHubWriteIdentity: vi.fn(),
    resolveExternalGitHubAuthorInTransaction: vi.fn(),
    unresolvePullRequestReviewThreadWithUserToken: vi.fn(),
    updatePullRequestReviewCommentWithUserToken: vi.fn(),
    upsertGitHubReviewCommentThread: vi.fn(),
    withDb: Object.assign(withDbMock, { tx: vi.fn() }),
  };
});

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: mocks.withDb,
  };
});

vi.mock("@repo/github", () => ({
  createPullRequestReviewCommentWithUserToken:
    mocks.createPullRequestReviewCommentWithUserToken,
  createReplyForReviewCommentWithUserToken:
    mocks.createReplyForReviewCommentWithUserToken,
  deletePullRequestReviewCommentWithUserToken:
    mocks.deletePullRequestReviewCommentWithUserToken,
  resolvePullRequestReviewThreadWithUserToken:
    mocks.resolvePullRequestReviewThreadWithUserToken,
  unresolvePullRequestReviewThreadWithUserToken:
    mocks.unresolvePullRequestReviewThreadWithUserToken,
  updatePullRequestReviewCommentWithUserToken:
    mocks.updatePullRequestReviewCommentWithUserToken,
}));

vi.mock("@/app/comments/external-authors", () => ({
  resolveExternalGitHubAuthorInTransaction:
    mocks.resolveExternalGitHubAuthorInTransaction,
}));

vi.mock("@/app/comments/github-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/comments/github-identity")>();
  return {
    ...actual,
    getGitHubWriteIdentityStatus: mocks.getGitHubWriteIdentityStatus,
    requireGitHubWriteIdentity: mocks.requireGitHubWriteIdentity,
  };
});

vi.mock("@/app/comments/github-projection", () => ({
  upsertGitHubReviewCommentThread: mocks.upsertGitHubReviewCommentThread,
}));

const PATCH = `@@ -1,3 +1,4 @@
 import { a } from "./a";
-const oldValue = 1;
+const newValue = 2;
+const anotherValue = 3;
 export const done = true;`;

describe("isInlineAnchorInPatch", () => {
  it("accepts right-side added lines and context lines", () => {
    expect(
      isInlineAnchorInPatch(PATCH, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
      })
    ).toBe(true);
    expect(
      isInlineAnchorInPatch(PATCH, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 4,
        side: GitHubDiffSide.Right,
      })
    ).toBe(true);
  });

  it("accepts left-side removed lines and rejects lines outside the diff", () => {
    expect(
      isInlineAnchorInPatch(PATCH, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 2,
        side: GitHubDiffSide.Left,
      })
    ).toBe(true);
    expect(
      isInlineAnchorInPatch(PATCH, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 5,
        side: GitHubDiffSide.Right,
      })
    ).toBe(false);
  });

  it("rejects inverted multiline ranges and missing patches", () => {
    expect(
      isInlineAnchorInPatch(PATCH, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 2,
        side: GitHubDiffSide.Right,
        startLine: 3,
        startSide: GitHubDiffSide.Right,
      })
    ).toBe(false);
    expect(
      isInlineAnchorInPatch(null, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 2,
        side: GitHubDiffSide.Right,
      })
    ).toBe(false);
  });

  it("ignores patch metadata lines and delegates cross-side ranges to GitHub", () => {
    expect(
      isInlineAnchorInPatch(
        `${PATCH}
\\ No newline at end of file
`,
        {
          body: "inline",
          expectedHeadSha: "abc123",
          path: "src/index.ts",
          line: 5,
          side: GitHubDiffSide.Right,
        }
      )
    ).toBe(false);
    expect(
      isInlineAnchorInPatch(PATCH, {
        body: "inline",
        expectedHeadSha: "abc123",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
        startLine: 2,
        startSide: GitHubDiffSide.Left,
      })
    ).toBe(true);
  });
});

describe("editReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReviewTargetDb();
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
  });

  it("rejects locally deleted unified comments before provider edit projection can revive them", async () => {
    const deletedAt = new Date("2026-05-21T12:00:00.000Z");
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({ deletedAt, githubDeletedAt: deletedAt })
    );

    const result = await editReviewComment({
      auth: authContext(),
      body: "edited body",
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.CommentNotFound,
      message: "Comment not found",
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(updatePullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
    expect(withDb).toHaveBeenCalledTimes(1);
    expect(
      (withDb as unknown as { tx: ReturnType<typeof vi.fn> }).tx
    ).not.toHaveBeenCalled();
  });

  it("does not query the UUID primary key when editing by GitHub comment id", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({ deletedAt: null, githubDeletedAt: null })
    );
    mocks.updatePullRequestReviewCommentWithUserToken.mockRejectedValue(
      new Error("skip provider success path")
    );

    await editReviewComment({
      auth: authContext(),
      body: "edited body",
      commentId: "123456",
      ctx: prContext(),
      user: testUser(),
    });

    expect(mocks.commentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ githubProjection: { is: { githubCommentId: "123456" } } }],
        }),
      })
    );
  });

  it("rejects non-owner edits before the provider write", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({
        deletedAt: null,
        githubDeletedAt: null,
        authorGithubUserId: "other-github-user-id",
      })
    );

    const result = await editReviewComment({
      auth: authContext(),
      body: "edited body",
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
      message: "Comment action is not allowed",
    });
    expect(updatePullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
    expect(
      (withDb as unknown as { tx: ReturnType<typeof vi.fn> }).tx
    ).not.toHaveBeenCalled();
  });

  it("returns github_write_failed without updating projections when the provider rejects edits", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({ deletedAt: null, githubDeletedAt: null })
    );
    mocks.updatePullRequestReviewCommentWithUserToken.mockRejectedValue(
      new Error("GitHub write denied")
    );

    const result = await editReviewComment({
      auth: authContext(),
      body: "edited body",
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment edit failed",
    });
    expect(updatePullRequestReviewCommentWithUserToken).toHaveBeenCalledTimes(
      1
    );
    expect(projectionWriteCallCounts()).toEqual({
      externalAuthorResolutions: 0,
      threadUpserts: 0,
      transactions: 0,
    });
  });
});

describe("createInlineReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installBranchFileCacheDb();
    installProjectionTx();
    mocks.branchFileChangeFindUnique.mockResolvedValue({
      patch: PATCH,
      isBinary: false,
    });
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
    mocks.createPullRequestReviewCommentWithUserToken.mockResolvedValue(
      providerComment({ id: 123_456 })
    );
  });

  it("writes a valid inline review comment with the expected GitHub payload", async () => {
    const result = await createInlineReviewComment({
      auth: authContext(),
      ctx: prContext(),
      request: {
        body: "inline",
        expectedHeadSha: "head-sha",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
      },
      user: testUser(),
    });

    expect(result).toMatchObject({
      success: true,
      action: BranchViewCommentAction.CreateInline,
      comment: {
        githubCommentId: "123456",
        body: "inline",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
        startLine: null,
        startSide: null,
      },
    });
    expect(createPullRequestReviewCommentWithUserToken).toHaveBeenCalledWith(
      WRITE_OCTOKIT,
      "closedloop",
      "runtime",
      1197,
      {
        body: "inline",
        commitId: "head-sha",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
        startLine: undefined,
        startSide: undefined,
      }
    );
    expect(upsertGitHubReviewCommentThread).toHaveBeenCalled();
  });

  it("reads back the locally upserted review comment in the current PR scope", async () => {
    await createInlineReviewComment({
      auth: authContext(),
      ctx: prContext(),
      request: {
        body: "inline",
        expectedHeadSha: "head-sha",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
      },
      user: testUser(),
    });

    const projectedLookup = mocks.commentFindFirst.mock.calls
      .map(([query]) => query)
      .find(isProjectedCommentLookup) as ProjectedCommentQuery;

    expect(projectedLookup).toMatchObject({
      where: {
        id: "comment-123456",
        deletedAt: null,
        githubProjection: {
          is: {
            githubCommentId: "123456",
            githubDeletedAt: null,
          },
        },
        thread: {
          organizationId: "org-1",
          artifactId: "branch-artifact-1",
          source: ThreadSource.Github,
          githubProjection: {
            is: {
              branchArtifactId: "branch-artifact-1",
              pullRequestDetailId: "pull-request-detail-1",
              threadKind: GitHubCommentThreadKind.ReviewThread,
              deletedAt: null,
            },
          },
        },
      },
    });
  });

  it("rejects stale expectedHeadSha before a GitHub write", async () => {
    const result = await createInlineReviewComment({
      auth: authContext(),
      ctx: prContext(),
      request: {
        body: "inline",
        expectedHeadSha: "stale-sha",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
      },
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.StaleHeadSha,
      message: "Branch file cache is not at the expected head SHA",
    });
    expect(mocks.branchFileChangeFindUnique).not.toHaveBeenCalled();
    expect(createPullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
  });

  it("rejects out-of-diff anchors before a GitHub write", async () => {
    const result = await createInlineReviewComment({
      auth: authContext(),
      ctx: prContext(),
      request: {
        body: "inline",
        expectedHeadSha: "head-sha",
        path: "src/index.ts",
        line: 99,
        side: GitHubDiffSide.Right,
      },
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.InvalidAnchor,
      message: "Comment anchor is invalid for the current diff",
    });
    expect(mocks.branchFileChangeFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branchArtifactId_headSha_path: {
            branchArtifactId: "branch-artifact-1",
            headSha: "head-sha",
            path: "src/index.ts",
          },
        },
      })
    );
    expect(createPullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
  });

  it("rejects missing GitHub identity after validating the anchor and before a GitHub write", async () => {
    mocks.requireGitHubWriteIdentity.mockResolvedValue({
      ok: false,
      error: BranchViewCommentActionResultCode.GithubIdentityRequired,
    });

    const result = await createInlineReviewComment({
      auth: authContext(),
      ctx: prContext(),
      request: {
        body: "inline",
        expectedHeadSha: "head-sha",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
      },
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.GithubIdentityRequired,
      identityBlocker: {
        status: BranchViewCommentWriteIdentityStatus.Missing,
      },
      message: "GitHub user connection is required for comment writes",
    });
    expect(mocks.branchFileChangeFindUnique).toHaveBeenCalled();
    expect(createPullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
  });

  it("returns github_write_failed without creating projections when the provider rejects inline creates", async () => {
    mocks.createPullRequestReviewCommentWithUserToken.mockRejectedValue(
      new Error("GitHub write denied")
    );

    const result = await createInlineReviewComment({
      auth: authContext(),
      ctx: prContext(),
      request: {
        body: "inline",
        expectedHeadSha: "head-sha",
        path: "src/index.ts",
        line: 3,
        side: GitHubDiffSide.Right,
      },
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment write failed",
    });
    expect(createPullRequestReviewCommentWithUserToken).toHaveBeenCalledTimes(
      1
    );
    expect(projectionWriteCallCounts()).toEqual({
      externalAuthorResolutions: 0,
      threadUpserts: 0,
      transactions: 0,
    });
  });
});

describe("replyToReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReviewTargetDb();
    installProjectionTx();
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
    mocks.createReplyForReviewCommentWithUserToken.mockResolvedValue(
      providerComment({
        id: 123_457,
        inReplyToId: 123_456,
      })
    );
  });

  it("rejects incomplete pull request context before identity or provider work", async () => {
    const result = await replyToReviewComment({
      auth: authContext(),
      body: "reply",
      commentGithubId: 123_456,
      ctx: { ...prContext(), gitHubPullRequest: null, pullNumber: null },
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Reply,
      code: BranchViewCommentActionResultCode.GithubThreadMissing,
      message: "Current pull request context is unavailable",
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(createReplyForReviewCommentWithUserToken).not.toHaveBeenCalled();
  });

  it("rejects unknown parent comments before a GitHub reply", async () => {
    mocks.commentFindFirst.mockResolvedValue(null);

    const result = await replyToReviewComment({
      auth: authContext(),
      body: "reply",
      commentGithubId: 123_456,
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Reply,
      code: BranchViewCommentActionResultCode.CommentNotFound,
      message: "Comment not found",
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(createReplyForReviewCommentWithUserToken).not.toHaveBeenCalled();
  });

  it("rejects unsupported reply targets before identity lookup", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({
        deletedAt: null,
        githubDeletedAt: null,
        path: null,
      })
    );

    const result = await replyToReviewComment({
      auth: authContext(),
      body: "reply",
      commentGithubId: 123_456,
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Reply,
      code: BranchViewCommentActionResultCode.UnsupportedCommentKind,
      message: "Comment action is not allowed",
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("identityBlocker");
  });

  it("replies to the original GitHub thread using the commentGithubId payload", async () => {
    const result = await replyToReviewComment({
      auth: authContext(),
      body: "reply",
      commentGithubId: 123_456,
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toMatchObject({
      success: true,
      action: BranchViewCommentAction.Reply,
      comment: {
        githubCommentId: "123457",
        anchorCommitSha: "head-sha",
        body: "reply",
        inReplyToId: "123456",
      },
    });
    expect(createReplyForReviewCommentWithUserToken).toHaveBeenCalledWith(
      WRITE_OCTOKIT,
      "closedloop",
      "runtime",
      1197,
      123_456,
      "reply"
    );
  });

  it("returns github_write_failed without creating projections when the provider rejects replies", async () => {
    mocks.createReplyForReviewCommentWithUserToken.mockRejectedValue(
      new Error("GitHub write denied")
    );

    const result = await replyToReviewComment({
      auth: authContext(),
      body: "reply",
      commentGithubId: 123_456,
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Reply,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment reply failed",
    });
    expect(createReplyForReviewCommentWithUserToken).toHaveBeenCalledTimes(1);
    expect(projectionWriteCallCounts()).toEqual({
      externalAuthorResolutions: 0,
      threadUpserts: 0,
      transactions: 0,
    });
  });
});

describe("deleteReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReviewTargetDb();
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
  });

  it("rejects non-owner deletes before the provider write", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({
        deletedAt: null,
        githubDeletedAt: null,
        authorGithubUserId: "other-github-user-id",
      })
    );

    const result = await deleteReviewComment({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Delete,
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
      message: "Comment action is not allowed",
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(deletePullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
    expect(
      (withDb as unknown as { tx: ReturnType<typeof vi.fn> }).tx
    ).not.toHaveBeenCalled();
  });

  it("returns locally deleted review comments without identity lookup", async () => {
    const deletedAt = new Date("2026-05-21T12:00:00.000Z");
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({ deletedAt, githubDeletedAt: deletedAt })
    );

    const result = await deleteReviewComment({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toMatchObject({
      success: true,
      action: BranchViewCommentAction.Delete,
      comment: { commentId: "comment-1", githubCommentId: "123456" },
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(deletePullRequestReviewCommentWithUserToken).not.toHaveBeenCalled();
  });

  it("returns github_write_failed without deleting local projections when the provider rejects deletes", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({ deletedAt: null, githubDeletedAt: null })
    );
    mocks.deletePullRequestReviewCommentWithUserToken.mockRejectedValue(
      new Error("GitHub write denied")
    );

    const result = await deleteReviewComment({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Delete,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment delete failed",
    });
    expect(deletePullRequestReviewCommentWithUserToken).toHaveBeenCalledTimes(
      1
    );
    expect(projectionWriteCallCounts()).toEqual({
      externalAuthorResolutions: 0,
      threadUpserts: 0,
      transactions: 0,
    });
  });

  it("marks only active GitHub review-comment projections as provider-deleted", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({ deletedAt: null, githubDeletedAt: null })
    );
    mocks.deletePullRequestReviewCommentWithUserToken.mockResolvedValue(
      undefined
    );

    const result = await deleteReviewComment({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toMatchObject({
      success: true,
      action: BranchViewCommentAction.Delete,
      comment: { commentId: "comment-1", githubCommentId: "123456" },
    });
    expect(mocks.gitHubCommentProjectionUpdateMany).toHaveBeenCalledWith({
      where: {
        commentId: "comment-1",
        githubDeletedAt: null,
      },
      data: { githubDeletedAt: expect.any(Date) },
    });
    expect(mocks.commentUpdate).toHaveBeenCalledWith({
      where: { id: "comment-1" },
      data: { deletedAt: expect.any(Date) },
    });
  });
});

describe("resolveReviewThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReviewTargetDb();
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
  });

  it("rejects already resolved targets before identity lookup", async () => {
    mocks.commentFindFirst.mockResolvedValue(
      reviewTargetRow({
        deletedAt: null,
        githubDeletedAt: null,
        status: ThreadStatus.Resolved,
      })
    );

    const result = await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toEqual({
      success: false,
      action: BranchViewCommentAction.Resolve,
      code: BranchViewCommentActionResultCode.CommentNotResolvable,
      message: "Comment action is not allowed",
    });
    expect(requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("identityBlocker");
  });
});

function projectionWriteCallCounts() {
  return {
    externalAuthorResolutions:
      mocks.resolveExternalGitHubAuthorInTransaction.mock.calls.length,
    threadUpserts: mocks.upsertGitHubReviewCommentThread.mock.calls.length,
    transactions: (withDb as unknown as { tx: ReturnType<typeof vi.fn> }).tx
      .mock.calls.length,
  };
}

function installBranchFileCacheDb() {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      branchFileChange: { findUnique: mocks.branchFileChangeFindUnique },
    })
  );
}

function installReviewTargetDb() {
  mocks.getGitHubWriteIdentityStatus.mockResolvedValue(writeIdentityStatus());
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ comment: { findFirst: mocks.commentFindFirst } })
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      comment: {
        findFirst: mocks.commentFindFirst,
        update: mocks.commentUpdate,
      },
      gitHubCommentProjection: {
        updateMany: mocks.gitHubCommentProjectionUpdateMany,
      },
    })
  );
}

function installProjectionTx() {
  mocks.resolveExternalGitHubAuthorInTransaction.mockResolvedValue({
    externalAuthor: { id: "external-author-1" },
    identity: {
      providerLogin: "author",
      avatarUrl: "https://avatars.example.test/author.png",
    },
    user: { id: "user-1" },
  });
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      comment: { findFirst: mocks.commentFindFirst },
    })
  );
  mocks.upsertGitHubReviewCommentThread.mockImplementation(
    (
      _tx: unknown,
      input: { comments: Array<{ githubCommentId: string | number }> }
    ) =>
      Promise.resolve({
        threadId: "thread-1",
        commentIds: input.comments.map(
          (comment) => `comment-${comment.githubCommentId}`
        ),
        createdGithubCommentIds: input.comments.map((comment) =>
          String(comment.githubCommentId)
        ),
      })
  );
  mocks.commentFindFirst.mockImplementation((query: unknown) => {
    if (isProjectedCommentLookup(query)) {
      return Promise.resolve(projectedCommentRow(query));
    }
    return Promise.resolve(
      reviewTargetRow({ deletedAt: null, githubDeletedAt: null })
    );
  });
}
