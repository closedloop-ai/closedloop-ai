import {
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteReviewComment: vi.fn(),
  editReviewComment: vi.fn(),
  resolvePrContext: vi.fn(),
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
    apiKeyScopes: undefined,
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(mocks.auth, request, context.params),
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  resolvePrContext: mocks.resolvePrContext,
}));

vi.mock("../../direct-write-service", () => ({
  deleteReviewComment: mocks.deleteReviewComment,
  editReviewComment: mocks.editReviewComment,
}));

import { DELETE, PATCH } from "./route";

describe("/branch-view/[externalLinkId]/comments/review/[commentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({ id: "ctx-1" });
    mocks.editReviewComment.mockResolvedValue({
      success: true,
      action: BranchViewCommentAction.Edit,
      comment: { githubCommentId: "456", body: "edited" },
    });
    mocks.deleteReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Delete,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
    });
  });

  it("routes PATCH to the edit service", async () => {
    const response = await PATCH(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        { method: "PATCH", body: JSON.stringify({ body: "edited" }) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      success: true,
      action: BranchViewCommentAction.Edit,
    });
    expect(mocks.editReviewComment).toHaveBeenCalledWith({
      auth: mocks.auth,
      body: "edited",
      commentId: "comment-1",
      ctx: { id: "ctx-1" },
      user: mocks.auth.user,
    });
  });

  it("maps PATCH provider write failures to HTTP 502", async () => {
    mocks.editReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment edit failed",
    });

    const response = await PATCH(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        { method: "PATCH", body: JSON.stringify({ body: "edited" }) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      details: {
        action: BranchViewCommentAction.Edit,
      },
    });
  });

  it("preserves identity blockers for PATCH failures", async () => {
    mocks.editReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      identityBlocker: {
        status: BranchViewCommentWriteIdentityStatus.Revoked,
      },
      message: "GitHub user connection must be reconnected for comment writes",
    });

    const response = await PATCH(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        { method: "PATCH", body: JSON.stringify({ body: "edited" }) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      details: {
        action: BranchViewCommentAction.Edit,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Revoked,
        },
      },
    });
  });

  it("returns PATCH projection recovery as 202 action-result data", async () => {
    mocks.editReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
    });

    const response = await PATCH(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        { method: "PATCH", body: JSON.stringify({ body: "edited" }) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      success: true,
      data: {
        success: false,
        action: BranchViewCommentAction.Edit,
        code: BranchViewCommentActionResultCode.GithubProjectionFailed,
        message: "projection failed",
        recovery: BranchViewCommentActionRecovery.BranchViewSync,
      },
    });
  });

  it("routes DELETE to the delete service and preserves recovery", async () => {
    const response = await DELETE(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        { method: "DELETE", body: JSON.stringify({}) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      success: true,
      data: {
        success: false,
        action: BranchViewCommentAction.Delete,
        code: BranchViewCommentActionResultCode.GithubProjectionFailed,
        message: "projection failed",
        recovery: BranchViewCommentActionRecovery.BranchViewSync,
      },
    });
    expect(mocks.deleteReviewComment).toHaveBeenCalledWith({
      auth: mocks.auth,
      commentId: "comment-1",
      ctx: { id: "ctx-1" },
      user: mocks.auth.user,
    });
  });

  it("maps DELETE provider write failures to HTTP 502", async () => {
    mocks.deleteReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Delete,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment delete failed",
    });

    const response = await DELETE(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        { method: "DELETE", body: JSON.stringify({}) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      details: {
        action: BranchViewCommentAction.Delete,
      },
    });
  });

  it("rejects forged extra edit fields before resolving context", async () => {
    const response = await PATCH(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        {
          method: "PATCH",
          body: JSON.stringify({ body: "edited", expectedHeadSha: "abc123" }),
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.InvalidRequest,
      details: {
        action: BranchViewCommentAction.Edit,
      },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.editReviewComment).not.toHaveBeenCalled();
  });

  it("rejects forged delete fields before resolving context", async () => {
    const response = await DELETE(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1",
        {
          method: "DELETE",
          body: JSON.stringify({ body: "delete me" }),
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.InvalidRequest,
      details: {
        action: BranchViewCommentAction.Delete,
      },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.deleteReviewComment).not.toHaveBeenCalled();
  });
});

function routeContext() {
  return {
    params: Promise.resolve({
      commentId: "comment-1",
      externalLinkId: "branch-1",
    }),
  };
}
