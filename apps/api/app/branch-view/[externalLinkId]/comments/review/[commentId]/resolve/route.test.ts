import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePrContext: vi.fn(),
  resolveReviewThread: vi.fn(),
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
  resolveReviewThread: mocks.resolveReviewThread,
}));

import { POST } from "./route";

describe("/branch-view/[externalLinkId]/comments/review/[commentId]/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({ id: "ctx-1" });
    mocks.resolveReviewThread.mockResolvedValue({
      success: true,
      action: BranchViewCommentAction.Resolve,
      comment: { githubCommentId: "456", resolved: true },
    });
  });

  it("routes empty resolve bodies to the review-thread service", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/resolve",
        { method: "POST", body: JSON.stringify({}) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      success: true,
      action: BranchViewCommentAction.Resolve,
    });
    expect(mocks.resolveReviewThread).toHaveBeenCalledWith({
      auth: mocks.auth,
      commentId: "comment-1",
      ctx: { id: "ctx-1" },
      user: mocks.auth.user,
    });
  });

  it("rejects non-empty resolve bodies before resolving context", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/resolve",
        { method: "POST", body: JSON.stringify({ body: "forged" }) }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.InvalidRequest,
      details: { action: BranchViewCommentAction.Resolve },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.resolveReviewThread).not.toHaveBeenCalled();
  });

  it("maps GitHub write failures to HTTP 502", async () => {
    mocks.resolveReviewThread.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Resolve,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review thread resolution failed",
    });

    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/resolve",
        { method: "POST", body: JSON.stringify({}) }
      ),
      routeContext()
    );

    expect(response.status).toBe(502);
  });

  it("preserves identity blockers for resolve failures", async () => {
    mocks.resolveReviewThread.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Resolve,
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      identityBlocker: {
        status: BranchViewCommentWriteIdentityStatus.DecryptionFailed,
      },
      message: "GitHub user connection must be reconnected for comment writes",
    });

    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/review/comment-1/resolve",
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
        action: BranchViewCommentAction.Resolve,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.DecryptionFailed,
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
