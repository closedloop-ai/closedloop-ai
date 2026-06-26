import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { BranchViewLoadErrorCode } from "@repo/api/src/types/branch-view";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewContextCredentialMode } from "@/lib/resolve-pr-context";

const mocks = vi.hoisted(() => ({
  auth: {
    authMethod: "session",
    apiKeyScopes: undefined,
  } as {
    authMethod: "session" | "api_key";
    apiKeyScopes?: ApiKeyScope[];
  },
  getBranchViewData: vi.fn(),
  resolveBranchViewMissingContextFailure: vi.fn(),
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
          authMethod: mocks.auth.authMethod,
          apiKeyScopes: mocks.auth.apiKeyScopes,
        },
        request,
        context.params
      ),
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  BranchViewContextCredentialMode: {
    PinnedActiveOnly: "pinned_active_only",
    RenderRead: "render_read",
  },
  resolvePrContext: mocks.resolvePrContext,
}));

vi.mock("./service", () => ({
  getBranchViewData: mocks.getBranchViewData,
  resolveBranchViewMissingContextFailure:
    mocks.resolveBranchViewMissingContextFailure,
}));

import { GET } from "./route";

describe("GET /branch-view/[externalLinkId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
    mocks.resolveBranchViewMissingContextFailure.mockResolvedValue({
      code: BranchViewLoadErrorCode.LinkNotFound,
      message: "Branch view not found",
      status: Status.NotFound,
    });
  });

  it("returns 404 and does not call the service when context resolution fails", async () => {
    mocks.resolvePrContext.mockResolvedValue(null);

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(mocks.resolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1",
      { credentialMode: BranchViewContextCredentialMode.RenderRead }
    );
    expect(mocks.getBranchViewData).not.toHaveBeenCalled();
    expect(mocks.resolveBranchViewMissingContextFailure).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1"
    );
  });

  it("preserves resolver-null unavailable failures and does not call the service", async () => {
    mocks.resolvePrContext.mockResolvedValue(null);
    mocks.resolveBranchViewMissingContextFailure.mockResolvedValue({
      code: BranchViewLoadErrorCode.PullRequestUnavailable,
      message: "Branch view pull request is unavailable",
      status: Status.NotFound,
      details: {
        producedByPlanSlug: "PLN-741",
      },
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Branch view pull request is unavailable");
    expect(body.code).toBe(BranchViewLoadErrorCode.PullRequestUnavailable);
    expect(body.details).toEqual({ producedByPlanSlug: "PLN-741" });
    expect(mocks.getBranchViewData).not.toHaveBeenCalled();
  });

  it("preserves resolver-null transient failures as retryable 500 responses", async () => {
    mocks.resolvePrContext.mockResolvedValue(null);
    mocks.resolveBranchViewMissingContextFailure.mockResolvedValue({
      code: BranchViewLoadErrorCode.TransientLoadError,
      message: "Branch view data is temporarily unavailable",
      status: Status.Error,
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Branch view data is temporarily unavailable");
    expect(body.code).toBe(BranchViewLoadErrorCode.TransientLoadError);
    expect(body.details).toBeUndefined();
    expect(mocks.getBranchViewData).not.toHaveBeenCalled();
  });

  it("maps unexpected resolver rejections to typed transient failures", async () => {
    mocks.resolvePrContext.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to fetch branch view data");
    expect(body.code).toBe(BranchViewLoadErrorCode.TransientLoadError);
    expect(mocks.resolveBranchViewMissingContextFailure).not.toHaveBeenCalled();
    expect(mocks.getBranchViewData).not.toHaveBeenCalled();
  });

  it("maps unexpected service rejections to typed transient failures", async () => {
    const ctx = { branchArtifactId: "branch-artifact-id-1" };
    mocks.resolvePrContext.mockResolvedValue(ctx);
    mocks.getBranchViewData.mockRejectedValue(new Error("service unavailable"));

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to fetch branch view data");
    expect(body.code).toBe(BranchViewLoadErrorCode.TransientLoadError);
    expect(mocks.getBranchViewData).toHaveBeenCalledWith(ctx, mocks.user, {
      authMethod: "session",
      apiKeyScopes: undefined,
      organizationId: "org-1",
    });
  });

  it("returns branch view data from the service", async () => {
    const ctx = { branchArtifactId: "branch-artifact-id-1" };
    const data = {
      externalLinkId: "branch-artifact-1",
      branch: null,
      currentPullRequest: null,
      committedFiles: [],
      localFiles: [],
      reviews: [],
      comments: [],
    };
    mocks.resolvePrContext.mockResolvedValue(ctx);
    mocks.getBranchViewData.mockResolvedValue(Result.ok(data));

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data });
    expect(mocks.getBranchViewData).toHaveBeenCalledWith(ctx, mocks.user, {
      authMethod: "session",
      apiKeyScopes: undefined,
      organizationId: "org-1",
    });
  });

  it("returns 404 when the service cannot assemble branch view data", async () => {
    const ctx = { branchArtifactId: "branch-artifact-id-1" };
    mocks.resolvePrContext.mockResolvedValue(ctx);
    mocks.getBranchViewData.mockResolvedValue(
      Result.err({
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        message: "Pull request unavailable",
        status: Status.NotFound,
        details: {
          githubPullRequestUrl: "https://github.com/acme/repo/pull/42",
        },
      })
    );

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Pull request unavailable");
    expect(body.code).toBe(BranchViewLoadErrorCode.PullRequestUnavailable);
    expect(body.details).toEqual({
      githubPullRequestUrl: "https://github.com/acme/repo/pull/42",
    });
    expect(mocks.getBranchViewData).toHaveBeenCalledWith(ctx, mocks.user, {
      authMethod: "session",
      apiKeyScopes: undefined,
      organizationId: "org-1",
    });
  });

  it.each([
    ["session", undefined],
    ["api_key", ["write"]],
    ["api_key", ["read"]],
    ["api_key", []],
  ] as const)("passes %s auth scopes %j into branch-view capability routing", async (authMethod, apiKeyScopes) => {
    const ctx = { branchArtifactId: "branch-artifact-id-1" };
    const data = {
      externalLinkId: "branch-artifact-1",
      branch: null,
      currentPullRequest: null,
      committedFiles: [],
      localFiles: [],
      reviews: [],
      comments: [],
      canCreateConversationComment: false,
      canCreateInlineComment: false,
    };
    mocks.auth.authMethod = authMethod;
    mocks.auth.apiKeyScopes = apiKeyScopes ? [...apiKeyScopes] : undefined;
    mocks.resolvePrContext.mockResolvedValue(ctx);
    mocks.getBranchViewData.mockResolvedValue(Result.ok(data));

    const response = await GET(request(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.getBranchViewData).toHaveBeenCalledWith(ctx, mocks.user, {
      authMethod,
      apiKeyScopes,
      organizationId: "org-1",
    });
  });
});

function request() {
  return new NextRequest(
    "https://api.example.test/branch-view/branch-artifact-1"
  );
}

function routeContext() {
  return { params: Promise.resolve({ externalLinkId: "branch-artifact-1" }) };
}
