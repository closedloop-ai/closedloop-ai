import {
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  branchViewConversationService: {
    create: vi.fn(),
  },
  resolvePrContext: vi.fn(),
  user: { id: "user-1", organizationId: "org-1" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(
        {
          user: mocks.user,
          authMethod: "session",
          apiKeyScopes: undefined,
        },
        request,
        context.params
      ),
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  resolvePrContext: mocks.resolvePrContext,
}));

vi.mock("../conversation-service", () => ({
  branchViewConversationService: mocks.branchViewConversationService,
}));

import { POST } from "./route";

describe("POST /branch-view/[externalLinkId]/comments/conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({ id: "ctx-1" });
  });

  it("returns a 202 outer ApiResult success for projection recovery failures", async () => {
    mocks.branchViewConversationService.create.mockResolvedValue({
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

    const response = await POST(request({ body: "hello" }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      success: true,
      data: {
        success: false,
        action: BranchViewCommentAction.CreateConversation,
        code: BranchViewCommentActionResultCode.GithubProjectionFailed,
        message: "GitHub succeeded, but branch-view projection failed",
        recovery: BranchViewCommentActionRecovery.DirectReprojection,
        github: { commentId: "123" },
      },
    });
    expect(mocks.branchViewConversationService.create).toHaveBeenCalledWith({
      ctx: { id: "ctx-1" },
      user: mocks.user,
      auth: {
        authMethod: "session",
        apiKeyScopes: undefined,
        organizationId: "org-1",
      },
      body: "hello",
    });
  });

  it("returns non-2xx ApiResult<never> for GitHub write failures", async () => {
    mocks.branchViewConversationService.create.mockResolvedValue({
      httpStatus: 502,
      result: {
        success: false,
        action: BranchViewCommentAction.CreateConversation,
        code: BranchViewCommentActionResultCode.GithubWriteFailed,
        message: "GitHub failed to create the PR conversation comment",
      },
    });

    const response = await POST(request({ body: "hello" }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: "GitHub failed to create the PR conversation comment",
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      details: {
        action: BranchViewCommentAction.CreateConversation,
      },
    });
  });

  it("preserves identity blockers in non-2xx ApiResult details", async () => {
    mocks.branchViewConversationService.create.mockResolvedValue({
      httpStatus: 403,
      result: {
        success: false,
        action: BranchViewCommentAction.CreateConversation,
        code: BranchViewCommentActionResultCode.GithubIdentityRequired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Missing,
        },
        message: "You are not allowed to create a PR conversation comment",
      },
    });

    const response = await POST(request({ body: "hello" }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "You are not allowed to create a PR conversation comment",
      code: BranchViewCommentActionResultCode.GithubIdentityRequired,
      details: {
        action: BranchViewCommentAction.CreateConversation,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Missing,
        },
      },
    });
  });
});

function request(input: { body: string }) {
  return new NextRequest(
    "https://api.example.test/branch-view/branch-artifact-1/comments/conversation",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}

function routeContext() {
  return { params: Promise.resolve({ externalLinkId: "branch-artifact-1" }) };
}
