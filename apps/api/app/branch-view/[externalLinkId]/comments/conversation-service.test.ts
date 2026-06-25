import {
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
  CommentKind,
  GitHubCommentThreadKind,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPullRequestIssueCommentWithUserToken: vi.fn(),
  deletePullRequestIssueCommentWithUserToken: vi.fn(),
  getGitHubWriteIdentityStatus: vi.fn(),
  log: { warn: vi.fn() },
  requireGitHubWriteIdentity: vi.fn(),
  resolveExternalGitHubAuthorInTransaction: vi.fn(),
  softDeleteScopedGitHubCommentProjection: vi.fn(),
  toBranchViewComment: vi.fn(),
  updatePullRequestIssueCommentWithUserToken: vi.fn(),
  upsertGitHubIssueCommentThread: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("server-only", () => ({}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/github", () => ({
  createPullRequestIssueCommentWithUserToken:
    mocks.createPullRequestIssueCommentWithUserToken,
  deletePullRequestIssueCommentWithUserToken:
    mocks.deletePullRequestIssueCommentWithUserToken,
  updatePullRequestIssueCommentWithUserToken:
    mocks.updatePullRequestIssueCommentWithUserToken,
}));

vi.mock("@repo/observability/log", () => ({
  log: mocks.log,
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
  softDeleteScopedGitHubCommentProjection:
    mocks.softDeleteScopedGitHubCommentProjection,
  upsertGitHubIssueCommentThread: mocks.upsertGitHubIssueCommentThread,
}));

vi.mock("../comment-utils", () => ({
  toBranchViewComment: mocks.toBranchViewComment,
}));

import { branchViewConversationService } from "./conversation-service";

const USER = {
  id: "user-1",
  organizationId: "org-1",
} as never;

const SESSION_AUTH = {
  authMethod: "session",
  organizationId: "org-1",
} as const;

const ACTIVE_STATUS = {
  ok: true,
  value: { githubUserId: "github-user-1", login: "octocat" },
};

const ACTIVE_WRITE_IDENTITY = {
  ok: true,
  value: {
    githubUserId: "github-user-1",
    login: "octocat",
    token: "write-token",
  },
};

describe("branchViewConversationService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getGitHubWriteIdentityStatus.mockResolvedValue(ACTIVE_STATUS);
    mocks.requireGitHubWriteIdentity.mockResolvedValue(ACTIVE_WRITE_IDENTITY);
    mocks.resolveExternalGitHubAuthorInTransaction.mockResolvedValue({
      user: { id: "author-user-1" },
      externalAuthor: { id: "external-author-1" },
    });
    mocks.toBranchViewComment.mockImplementation((input) =>
      branchViewComment({
        authorKind:
          input.author.login === "closedloop-ai[bot]"
            ? PrCommentAuthorKind.Bot
            : PrCommentAuthorKind.User,
        githubCommentId: input.comment.githubCommentId,
      })
    );
  });

  it("returns exact 502 and does not project when the provider create fails", async () => {
    mocks.createPullRequestIssueCommentWithUserToken.mockRejectedValue(
      new Error("provider unavailable")
    );

    const result = await branchViewConversationService.create({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      body: "create body",
    });

    expect(result).toEqual({
      httpStatus: 502,
      result: {
        success: false,
        action: BranchViewCommentAction.CreateConversation,
        code: BranchViewCommentActionResultCode.GithubWriteFailed,
        message: "GitHub failed to create the PR conversation comment",
      },
    });
    expect(
      mocks.createPullRequestIssueCommentWithUserToken
    ).toHaveBeenCalledTimes(1);
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    expect(mocks.upsertGitHubIssueCommentThread).not.toHaveBeenCalled();
  });

  it("retries local projection once and does not retry the provider", async () => {
    mocks.createPullRequestIssueCommentWithUserToken.mockResolvedValue(
      providerComment({ id: 123 })
    );
    mocks.withDb.tx.mockImplementation((callback) => callback({}));
    mocks.upsertGitHubIssueCommentThread
      .mockRejectedValueOnce(new Error("first projection failed"))
      .mockRejectedValueOnce(new Error("second projection failed"));

    const result = await branchViewConversationService.create({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      body: "create body",
    });

    expect(result).toEqual({
      httpStatus: 202,
      result: {
        success: false,
        action: BranchViewCommentAction.CreateConversation,
        code: BranchViewCommentActionResultCode.GithubProjectionFailed,
        message: "GitHub succeeded, but branch-view projection failed",
        recovery: BranchViewCommentActionRecovery.DirectReprojection,
        github: { commentId: "123" },
      },
    });
    expect(
      mocks.createPullRequestIssueCommentWithUserToken
    ).toHaveBeenCalledTimes(1);
    expect(mocks.upsertGitHubIssueCommentThread).toHaveBeenCalledTimes(2);
  });

  it("deletes caller-authored issue comments through GitHub and soft-deletes the scoped projection", async () => {
    const db = dbWithProjectedComment({
      authorGithubUserId: "github-user-1",
    });
    const tx = {};
    mocks.withDb.mockImplementation((callback) => callback(db));
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mocks.deletePullRequestIssueCommentWithUserToken.mockResolvedValue(
      undefined
    );
    mocks.softDeleteScopedGitHubCommentProjection.mockResolvedValue(undefined);

    const result = await branchViewConversationService.delete({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      githubCommentId: "123",
    });

    expect(result).toEqual({
      httpStatus: 200,
      result: {
        success: true,
        action: BranchViewCommentAction.Delete,
        comment: branchViewComment({ githubCommentId: "123" }),
      },
    });
    expect(mocks.toBranchViewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ commitSha: null }),
      })
    );
    expect(
      mocks.deletePullRequestIssueCommentWithUserToken
    ).toHaveBeenCalledWith(
      "write-token",
      "closedloop-ai",
      "symphony-alpha",
      123
    );
    expect(mocks.softDeleteScopedGitHubCommentProjection).toHaveBeenCalledWith(
      tx,
      {
        organizationId: "org-1",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        githubCommentId: "123",
        deletedAt: expect.any(Date),
      }
    );
    expect(mocks.upsertGitHubIssueCommentThread).not.toHaveBeenCalled();
  });

  it("does not acquire a write token, call provider, or project for denial paths", async () => {
    mocks.withDb.mockImplementation((callback) =>
      callback(dbWithProjectedComment({ authorGithubUserId: "github-user-1" }))
    );

    const readOnlyCreate = await branchViewConversationService.create({
      ctx: prContext(),
      user: USER,
      auth: {
        authMethod: "api_key",
        organizationId: "org-1",
        apiKeyScopes: ["read"],
      },
      body: "create body",
    });
    expect(readOnlyCreate.result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    });

    const missingTargetEdit = await branchViewConversationService.edit({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      githubCommentId: "404",
      body: "edit body",
    });
    expect(missingTargetEdit.result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.CommentNotFound,
    });

    mocks.withDb.mockImplementation((callback) =>
      callback(
        dbWithProjectedComment({
          authorGithubUserId: "bot-user-1",
          authorLogin: "closedloop-ai[bot]",
        })
      )
    );
    const appAuthoredDelete = await branchViewConversationService.delete({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      githubCommentId: "123",
    });
    expect(appAuthoredDelete.result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly,
    });

    mocks.withDb.mockImplementation((callback) =>
      callback(dbWithProjectedComment({ authorGithubUserId: "other-user" }))
    );
    mocks.getGitHubWriteIdentityStatus.mockResolvedValueOnce(ACTIVE_STATUS);
    const ownerMismatchEdit = await branchViewConversationService.edit({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      githubCommentId: "123",
      body: "edit body",
    });
    expect(ownerMismatchEdit.result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    });

    const ownerMismatchDelete = await branchViewConversationService.delete({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      githubCommentId: "123",
    });
    expect(ownerMismatchDelete.result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    });

    expect(mocks.requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(
      mocks.createPullRequestIssueCommentWithUserToken
    ).not.toHaveBeenCalled();
    expect(
      mocks.updatePullRequestIssueCommentWithUserToken
    ).not.toHaveBeenCalled();
    expect(
      mocks.deletePullRequestIssueCommentWithUserToken
    ).not.toHaveBeenCalled();
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    expect(mocks.upsertGitHubIssueCommentThread).not.toHaveBeenCalled();
    expect(
      mocks.softDeleteScopedGitHubCommentProjection
    ).not.toHaveBeenCalled();
  });

  it("denies read-only API key edit and delete before identity lookup, provider writes, or projection", async () => {
    const readOnlyAuth = {
      authMethod: "api_key" as const,
      organizationId: "org-1",
      apiKeyScopes: ["read"] as ["read"],
    };

    for (const action of [
      BranchViewCommentAction.Edit,
      BranchViewCommentAction.Delete,
    ]) {
      vi.clearAllMocks();
      mocks.withDb.mockImplementation((callback) =>
        callback(
          dbWithProjectedComment({ authorGithubUserId: "github-user-1" })
        )
      );

      const result =
        action === BranchViewCommentAction.Edit
          ? await branchViewConversationService.edit({
              ctx: prContext(),
              user: USER,
              auth: readOnlyAuth,
              githubCommentId: "123",
              body: "edit body",
            })
          : await branchViewConversationService.delete({
              ctx: prContext(),
              user: USER,
              auth: readOnlyAuth,
              githubCommentId: "123",
            });

      const verb = action === BranchViewCommentAction.Edit ? "edit" : "delete";
      expect(result).toEqual({
        httpStatus: 403,
        result: {
          success: false,
          action,
          code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
          message: `You are not allowed to ${verb} this PR conversation comment`,
        },
      });
      expect(mocks.getGitHubWriteIdentityStatus).not.toHaveBeenCalled();
      expect(mocks.requireGitHubWriteIdentity).not.toHaveBeenCalled();
      expect(
        mocks.updatePullRequestIssueCommentWithUserToken
      ).not.toHaveBeenCalled();
      expect(
        mocks.deletePullRequestIssueCommentWithUserToken
      ).not.toHaveBeenCalled();
      expect(mocks.withDb.tx).not.toHaveBeenCalled();
      expect(mocks.upsertGitHubIssueCommentThread).not.toHaveBeenCalled();
      expect(
        mocks.softDeleteScopedGitHubCommentProjection
      ).not.toHaveBeenCalled();
    }
  });

  it("does not attach identity blockers to app-authored read-only denials", async () => {
    mocks.withDb.mockImplementation((callback) =>
      callback(
        dbWithProjectedComment({
          authorGithubUserId: "bot-user-1",
          authorLogin: "closedloop-ai[bot]",
        })
      )
    );
    mocks.getGitHubWriteIdentityStatus.mockResolvedValue({
      ok: false,
      error: BranchViewCommentActionResultCode.GithubIdentityRequired,
    });

    const result = await branchViewConversationService.delete({
      ctx: prContext(),
      user: USER,
      auth: SESSION_AUTH,
      githubCommentId: "123",
    });

    expect(result).toEqual({
      httpStatus: 403,
      result: {
        success: false,
        action: BranchViewCommentAction.Delete,
        code: BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly,
        message: "You are not allowed to delete this PR conversation comment",
      },
    });
    expect(result.result).not.toHaveProperty("identityBlocker");
    expect(mocks.getGitHubWriteIdentityStatus).not.toHaveBeenCalled();
    expect(mocks.requireGitHubWriteIdentity).not.toHaveBeenCalled();
    expect(
      mocks.deletePullRequestIssueCommentWithUserToken
    ).not.toHaveBeenCalled();
  });

  it("does not acquire a write token, call provider, or project when GitHub identity is unavailable", async () => {
    for (const [code, status] of [
      [
        BranchViewCommentActionResultCode.GithubIdentityRequired,
        BranchViewCommentWriteIdentityStatus.Missing,
      ],
      [
        BranchViewCommentActionResultCode.GithubIdentityExpired,
        BranchViewCommentWriteIdentityStatus.Expired,
      ],
    ] as const) {
      vi.clearAllMocks();
      mocks.getGitHubWriteIdentityStatus.mockResolvedValue({
        ok: false,
        error: code,
      });

      const result = await branchViewConversationService.create({
        ctx: prContext(),
        user: USER,
        auth: SESSION_AUTH,
        body: "create body",
      });

      expect(result).toEqual({
        httpStatus: 403,
        result: {
          success: false,
          action: BranchViewCommentAction.CreateConversation,
          code,
          identityBlocker: { status },
          message: "You are not allowed to create a PR conversation comment",
        },
      });
      expect(mocks.requireGitHubWriteIdentity).not.toHaveBeenCalled();
      expect(
        mocks.createPullRequestIssueCommentWithUserToken
      ).not.toHaveBeenCalled();
      expect(mocks.withDb.tx).not.toHaveBeenCalled();
      expect(mocks.upsertGitHubIssueCommentThread).not.toHaveBeenCalled();
    }
  });
});

function prContext() {
  return {
    externalLink: {
      id: "branch-artifact-1",
      organizationId: "org-1",
    },
    branch: {
      artifactId: "branch-artifact-1",
      currentPullRequestDetailId: "pr-detail-1",
    },
    gitHubPullRequest: { number: 42 },
    owner: "closedloop-ai",
    repo: "symphony-alpha",
    pullNumber: 42,
  } as never;
}

function providerComment(input: { id: number }) {
  return {
    id: input.id,
    html_url: `https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-${input.id}`,
    body: "provider body",
    created_at: "2026-05-21T12:00:00.000Z",
    updated_at: "2026-05-21T12:00:00.000Z",
    user: {
      id: Number(input.id),
      node_id: `node-${input.id}`,
      login: "octocat",
      avatar_url: "https://avatars.example/octocat.png",
    },
  };
}

function branchViewComment(input: {
  authorKind?: PrCommentAuthorKind;
  githubCommentId?: string | null;
}) {
  const githubCommentId = input.githubCommentId ?? "123";
  return {
    id: githubCommentId,
    githubCommentId,
    author: "octocat",
    authorAvatar: null,
    authorKind: input.authorKind ?? PrCommentAuthorKind.User,
    body: "projected body",
    createdAt: "2026-05-21T12:00:00.000Z",
    path: null,
    line: null,
    anchorCommitSha: null,
    state: PRReviewCommentState.Pending,
    reviewId: null,
    htmlUrl: `https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-${githubCommentId}`,
    inReplyToId: null,
    kind: CommentKind.IssueComment,
  };
}

function dbWithProjectedComment(input: {
  authorGithubUserId: string;
  authorLogin?: string;
}) {
  return {
    comment: {
      findFirst: vi.fn().mockImplementation(({ where }) => {
        const githubCommentId =
          where.githubProjection?.is?.githubCommentId ?? where.id;
        if (githubCommentId === "404") {
          return null;
        }
        return {
          id: "comment-1",
          body: { type: "github_markdown", markdown: "projected body" },
          plainText: "projected body",
          createdAt: new Date("2026-05-21T12:00:00.000Z"),
          thread: {
            id: "thread-1",
            source: "GITHUB",
            status: "OPEN",
            githubProjection: {
              threadKind: GitHubCommentThreadKind.IssueComment,
              reviewId: null,
              htmlUrl: null,
              path: null,
              line: null,
              commitSha: null,
              resolvable: false,
              legacyState: "PENDING",
            },
          },
          githubProjection: {
            githubCommentId,
            githubInReplyToCommentId: null,
            githubHtmlUrl: `https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-${githubCommentId}`,
            externalAuthor: {
              providerUserId: input.authorGithubUserId,
              providerLogin: input.authorLogin ?? "octocat",
              avatarUrl: null,
              profileUrl: null,
            },
          },
        };
      }),
    },
  };
}
