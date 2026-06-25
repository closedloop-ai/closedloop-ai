import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePrContext: vi.fn(),
  unresolveReviewThread: vi.fn(),
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

vi.mock("../../../direct-write-service", () => ({
  unresolveReviewThread: mocks.unresolveReviewThread,
}));

import { POST } from "./route";

describe("/branch-view/[externalLinkId]/comments/review/[commentId]/unresolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({ id: "ctx-1" });
    mocks.unresolveReviewThread.mockResolvedValue({
      success: true,
      action: BranchViewCommentAction.Unresolve,
      comment: { githubCommentId: "456", resolved: false },
    });
  });

  it("routes empty unresolve bodies to the review-thread service", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/unresolve",
        { method: "POST", body: JSON.stringify({}) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      success: true,
      action: BranchViewCommentAction.Unresolve,
    });
    expect(mocks.unresolveReviewThread).toHaveBeenCalledWith({
      auth: mocks.auth,
      commentId: "comment-1",
      ctx: { id: "ctx-1" },
      user: mocks.auth.user,
    });
  });

  it("rejects non-empty unresolve bodies before resolving context", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/unresolve",
        { method: "POST", body: JSON.stringify({ body: "forged" }) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.InvalidRequest,
      details: { action: BranchViewCommentAction.Unresolve },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.unresolveReviewThread).not.toHaveBeenCalled();
  });

  it("preserves identity blockers for unresolve failures", async () => {
    mocks.unresolveReviewThread.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Unresolve,
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      identityBlocker: {
        status: BranchViewCommentWriteIdentityStatus.Revoked,
      },
      message: "GitHub user connection must be reconnected for comment writes",
    });

    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/unresolve",
        { method: "POST", body: JSON.stringify({}) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      details: {
        action: BranchViewCommentAction.Unresolve,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Revoked,
        },
      },
    });
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
