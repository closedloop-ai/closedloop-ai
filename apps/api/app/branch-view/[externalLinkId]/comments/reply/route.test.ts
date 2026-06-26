import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePrContext: vi.fn(),
  replyToReviewComment: vi.fn(),
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

vi.mock("./service", () => ({
  replyToComment: vi.fn(),
}));

vi.mock("../direct-write-service", () => ({
  replyToReviewComment: mocks.replyToReviewComment,
}));

import { POST } from "./route";

function request() {
  return new NextRequest(
    "https://api.example.test/branch-view/branch-artifact-1/comments/reply",
    {
      method: "POST",
      body: JSON.stringify({ commentGithubId: 123, body: "reply" }),
    }
  );
}

function routeContext() {
  return { params: Promise.resolve({ externalLinkId: "branch-artifact-1" }) };
}

describe("POST /branch-view/[externalLinkId]/comments/reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({
      branchArtifactId: "branch-artifact-id-1",
    });
    mocks.replyToReviewComment.mockResolvedValue({
      success: true,
      action: BranchViewCommentAction.Reply,
      comment: { githubCommentId: "123", body: "reply" },
    });
  });

  it("preserves the commentGithubId reply payload and returns a comment response", async () => {
    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { githubCommentId: "123", body: "reply" },
    });
    expect(mocks.replyToReviewComment).toHaveBeenCalledWith({
      auth: mocks.auth,
      ctx: { branchArtifactId: "branch-artifact-id-1" },
      user: mocks.auth.user,
      commentGithubId: 123,
      body: "reply",
    });
  });

  it("maps provider write failures to HTTP 502", async () => {
    mocks.replyToReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Reply,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment reply failed",
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      details: {
        action: BranchViewCommentAction.Reply,
      },
    });
  });

  it("preserves identity blockers for reply failures", async () => {
    mocks.replyToReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.Reply,
      code: BranchViewCommentActionResultCode.GithubIdentityRequired,
      identityBlocker: {
        status: BranchViewCommentWriteIdentityStatus.Missing,
      },
      message: "GitHub user connection is required for comment writes",
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubIdentityRequired,
      details: {
        action: BranchViewCommentAction.Reply,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Missing,
        },
      },
    });
  });

  it("rejects forged extra reply fields before resolving context", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-artifact-1/comments/reply",
        {
          method: "POST",
          body: JSON.stringify({
            commentGithubId: 123,
            body: "reply",
            path: "src/index.ts",
          }),
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
        action: BranchViewCommentAction.Reply,
      },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.replyToReviewComment).not.toHaveBeenCalled();
  });
});
