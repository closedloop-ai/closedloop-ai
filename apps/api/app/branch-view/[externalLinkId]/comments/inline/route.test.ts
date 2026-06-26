import {
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  GitHubDiffSide,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInlineReviewComment: vi.fn(),
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

vi.mock("../direct-write-service", () => ({
  createInlineReviewComment: mocks.createInlineReviewComment,
}));

import { POST } from "./route";

describe("POST /branch-view/[externalLinkId]/comments/inline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({ id: "ctx-1" });
    mocks.createInlineReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.StaleHeadSha,
      message: "stale",
    });
  });

  it("validates oversized requests before resolving context", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/inline",
        {
          method: "POST",
          body: JSON.stringify({ body: "x".repeat(132_000) }),
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
        action: BranchViewCommentAction.CreateInline,
      },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.createInlineReviewComment).not.toHaveBeenCalled();
  });

  it("returns the service action result status", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/inline",
        {
          method: "POST",
          body: JSON.stringify({
            body: "inline",
            path: "src/index.ts",
            line: 12,
            side: GitHubDiffSide.Right,
            expectedHeadSha: "abc123",
          }),
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.StaleHeadSha,
      details: {
        action: BranchViewCommentAction.CreateInline,
      },
    });
    expect(mocks.createInlineReviewComment).toHaveBeenCalledWith({
      auth: mocks.auth,
      ctx: { id: "ctx-1" },
      request: {
        body: "inline",
        path: "src/index.ts",
        line: 12,
        side: GitHubDiffSide.Right,
        expectedHeadSha: "abc123",
      },
      user: mocks.auth.user,
    });
  });

  it("returns projection recovery as 202 action-result data", async () => {
    mocks.createInlineReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
      github: { commentId: "123" },
    });

    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/inline",
        {
          method: "POST",
          body: JSON.stringify({
            body: "inline",
            path: "src/index.ts",
            line: 12,
            side: GitHubDiffSide.Right,
            expectedHeadSha: "abc123",
          }),
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      success: true,
      data: {
        success: false,
        action: BranchViewCommentAction.CreateInline,
        code: BranchViewCommentActionResultCode.GithubProjectionFailed,
        message: "GitHub succeeded, but branch-view projection failed",
        recovery: BranchViewCommentActionRecovery.BranchViewSync,
        github: { commentId: "123" },
      },
    });
  });

  it("maps provider write failures to HTTP 502", async () => {
    mocks.createInlineReviewComment.mockResolvedValue({
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      message: "GitHub review comment write failed",
    });

    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/inline",
        {
          method: "POST",
          body: JSON.stringify({
            body: "inline",
            path: "src/index.ts",
            line: 12,
            side: GitHubDiffSide.Right,
            expectedHeadSha: "abc123",
          }),
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      details: {
        action: BranchViewCommentAction.CreateInline,
      },
    });
  });

  it("rejects forged extra inline fields before resolving context", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/branch-view/branch-1/comments/inline",
        {
          method: "POST",
          body: JSON.stringify({
            body: "inline",
            path: "src/index.ts",
            line: 12,
            side: GitHubDiffSide.Right,
            expectedHeadSha: "abc123",
            commentGithubId: 123,
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
        action: BranchViewCommentAction.CreateInline,
      },
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
    expect(mocks.createInlineReviewComment).not.toHaveBeenCalled();
  });
});

function routeContext() {
  return { params: Promise.resolve({ externalLinkId: "branch-1" }) };
}
