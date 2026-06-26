import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  branchViewConversationService: {
    delete: vi.fn(),
    edit: vi.fn(),
  },
  resolvePrContext: vi.fn(),
  auth: {
    authMethod: "session" as "session" | "api_key",
    apiKeyScopes: undefined as ApiKeyScope[] | undefined,
  },
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
          authMethod: mocks.auth.authMethod,
          apiKeyScopes: mocks.auth.apiKeyScopes,
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

import { DELETE, PATCH } from "./route";

describe("/branch-view/[externalLinkId]/comments/[githubCommentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
    mocks.resolvePrContext.mockResolvedValue({ id: "ctx-1" });
  });

  it("fails closed with the default resolver before edit writes when context is stale", async () => {
    mocks.resolvePrContext.mockResolvedValueOnce(null);

    const response = await PATCH(
      patchRequest({ body: "edited" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: "Branch view not found",
    });
    expect(mocks.resolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1"
    );
    expect(mocks.branchViewConversationService.edit).not.toHaveBeenCalled();
    expect(mocks.branchViewConversationService.delete).not.toHaveBeenCalled();
  });

  it("passes edit requests through the direct conversation service", async () => {
    mocks.branchViewConversationService.edit.mockResolvedValue({
      httpStatus: 200,
      result: {
        success: true,
        action: BranchViewCommentAction.Edit,
        comment: { id: "123", githubCommentId: "123" },
      },
    });

    const response = await PATCH(
      patchRequest({ body: "edited" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.branchViewConversationService.edit).toHaveBeenCalledWith({
      ctx: { id: "ctx-1" },
      user: mocks.user,
      auth: {
        authMethod: "session",
        apiKeyScopes: undefined,
        organizationId: "org-1",
      },
      githubCommentId: "123",
      body: "edited",
    });
  });

  it("passes read-only API key edit denial through without changing auth context", async () => {
    mocks.auth.authMethod = "api_key";
    mocks.auth.apiKeyScopes = ["read"];
    mocks.branchViewConversationService.edit.mockResolvedValue({
      httpStatus: 403,
      result: {
        success: false,
        action: BranchViewCommentAction.Edit,
        code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
        message: "You are not allowed to edit this PR conversation comment",
      },
    });

    const response = await PATCH(
      patchRequest({ body: "edited" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "You are not allowed to edit this PR conversation comment",
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
      details: {
        action: BranchViewCommentAction.Edit,
      },
    });
    expect(mocks.branchViewConversationService.edit).toHaveBeenCalledWith({
      ctx: { id: "ctx-1" },
      user: mocks.user,
      auth: {
        authMethod: "api_key",
        apiKeyScopes: ["read"],
        organizationId: "org-1",
      },
      githubCommentId: "123",
      body: "edited",
    });
  });

  it("deletes without requiring a JSON request body and returns pre-delete success shape", async () => {
    mocks.branchViewConversationService.delete.mockResolvedValue({
      httpStatus: 200,
      result: {
        success: true,
        action: BranchViewCommentAction.Delete,
        comment: { id: "123", githubCommentId: "123" },
      },
    });

    const response = await DELETE(deleteRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        success: true,
        action: BranchViewCommentAction.Delete,
        comment: { id: "123", githubCommentId: "123" },
      },
    });
    expect(mocks.branchViewConversationService.delete).toHaveBeenCalledWith({
      ctx: { id: "ctx-1" },
      user: mocks.user,
      auth: {
        authMethod: "session",
        apiKeyScopes: undefined,
        organizationId: "org-1",
      },
      githubCommentId: "123",
    });
  });

  it("passes read-only API key delete denial through without changing auth context", async () => {
    mocks.auth.authMethod = "api_key";
    mocks.auth.apiKeyScopes = ["read"];
    mocks.branchViewConversationService.delete.mockResolvedValue({
      httpStatus: 403,
      result: {
        success: false,
        action: BranchViewCommentAction.Delete,
        code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
        message: "You are not allowed to delete this PR conversation comment",
      },
    });

    const response = await DELETE(deleteRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "You are not allowed to delete this PR conversation comment",
      code: BranchViewCommentActionResultCode.UnauthorizedCommentAction,
      details: {
        action: BranchViewCommentAction.Delete,
      },
    });
    expect(mocks.branchViewConversationService.delete).toHaveBeenCalledWith({
      ctx: { id: "ctx-1" },
      user: mocks.user,
      auth: {
        authMethod: "api_key",
        apiKeyScopes: ["read"],
        organizationId: "org-1",
      },
      githubCommentId: "123",
    });
  });

  it("returns exact 502 github_write_failed for provider delete failures", async () => {
    mocks.branchViewConversationService.delete.mockResolvedValue({
      httpStatus: 502,
      result: {
        success: false,
        action: BranchViewCommentAction.Delete,
        code: BranchViewCommentActionResultCode.GithubWriteFailed,
        message: "GitHub failed to delete the PR conversation comment",
      },
    });

    const response = await DELETE(deleteRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: "GitHub failed to delete the PR conversation comment",
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
      details: {
        action: BranchViewCommentAction.Delete,
      },
    });
  });

  it("preserves identity blockers for edit failures", async () => {
    mocks.branchViewConversationService.edit.mockResolvedValue({
      httpStatus: 403,
      result: {
        success: false,
        action: BranchViewCommentAction.Edit,
        code: BranchViewCommentActionResultCode.GithubIdentityExpired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Expired,
        },
        message:
          "GitHub user connection must be reconnected for comment writes",
      },
    });

    const response = await PATCH(
      patchRequest({ body: "edited" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "GitHub user connection must be reconnected for comment writes",
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      details: {
        action: BranchViewCommentAction.Edit,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Expired,
        },
      },
    });
  });

  it("preserves identity blockers for delete failures", async () => {
    mocks.branchViewConversationService.delete.mockResolvedValue({
      httpStatus: 403,
      result: {
        success: false,
        action: BranchViewCommentAction.Delete,
        code: BranchViewCommentActionResultCode.GithubIdentityExpired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Revoked,
        },
        message:
          "GitHub user connection must be reconnected for comment writes",
      },
    });

    const response = await DELETE(deleteRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "GitHub user connection must be reconnected for comment writes",
      code: BranchViewCommentActionResultCode.GithubIdentityExpired,
      details: {
        action: BranchViewCommentAction.Delete,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Revoked,
        },
      },
    });
  });
});

function patchRequest(input: { body: string }) {
  return new NextRequest(
    "https://api.example.test/branch-view/branch-artifact-1/comments/123",
    {
      method: "PATCH",
      body: JSON.stringify(input),
    }
  );
}

function deleteRequest() {
  return new NextRequest(
    "https://api.example.test/branch-view/branch-artifact-1/comments/123",
    { method: "DELETE" }
  );
}

function routeContext() {
  return {
    params: Promise.resolve({
      externalLinkId: "branch-artifact-1",
      githubCommentId: "123",
    }),
  };
}
