import {
  DesktopGithubPullRequestApiMaxDurationSeconds,
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestRequestMaxBytes,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    clerkUserId: "clerk-user-1",
    clerkOrgId: "clerk-org-1",
    authMethod: "desktop_session" as "desktop_session" | "session" | "api_key",
  },
  handle: vi.fn(),
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

vi.mock("./service", () => ({
  desktopGithubPullRequestService: {
    handle: mocks.handle,
  },
}));

import { maxDuration, POST } from "./route";

describe("POST /desktop/github/pull-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.authMethod = "desktop_session";
    mocks.handle.mockResolvedValue({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Preflight,
        status: DesktopGithubPullRequestStatus.Available,
        repository: {
          fullName: "closedloop-ai/closedloop-ai",
          defaultBranch: "main",
        },
        identity: { login: "daveth" },
      },
    });
  });

  it("uses the shared PR API route duration contract", () => {
    expect(maxDuration).toBe(DesktopGithubPullRequestApiMaxDurationSeconds);
  });

  it("passes preflight requests to the service for desktop-session callers", async () => {
    const response = await POST(request(preflightBody()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Preflight,
        status: DesktopGithubPullRequestStatus.Available,
        repository: {
          fullName: "closedloop-ai/closedloop-ai",
          defaultBranch: "main",
        },
        identity: { login: "daveth" },
      },
    });
    expect(mocks.handle).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      request: preflightBody(),
      now: expect.any(Date),
    });
  });

  it("rejects non-desktop auth methods", async () => {
    mocks.auth.authMethod = "session";

    const response = await POST(request(preflightBody()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Desktop session authentication is required.",
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      details: {
        reason: DesktopGithubPullRequestReason.AuthorizationDenied,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: false,
        burnRetryBudget: false,
      },
    });
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it("rejects invalid request bodies before invoking the service", async () => {
    const response = await POST(
      request({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Create,
        repoFullName: "closedloop-ai/closedloop-ai",
        headBranch: "feature/no-gh",
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid desktop pull request payload",
      code: DesktopGithubPullRequestErrorCode.ValidationFailed,
      details: {
        reason: DesktopGithubPullRequestReason.ValidationFailed,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: false,
        burnRetryBudget: false,
      },
    });
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before invoking the service", async () => {
    const response = await POST(
      request({
        ...preflightBody(),
        mode: DesktopGithubPullRequestMode.Create,
        title: "Retire gh",
        body: "x".repeat(DesktopGithubPullRequestRequestMaxBytes),
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: "Request body too large",
      code: DesktopGithubPullRequestErrorCode.ValidationFailed,
      details: {
        reason: DesktopGithubPullRequestReason.ValidationFailed,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: false,
        burnRetryBudget: false,
      },
    });
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it("maps service failures to coded details", async () => {
    mocks.handle.mockResolvedValueOnce({
      ok: false,
      error: {
        success: false,
        error: "GitHub authentication is required",
        code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
        reason: DesktopGithubPullRequestReason.AuthenticationRequired,
        denial: GitHubAccessDenialReason.NotConnected,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: false,
        burnRetryBudget: false,
        status: 401,
      },
    });

    const response = await POST(request(preflightBody()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: "GitHub authentication is required",
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      details: {
        reason: DesktopGithubPullRequestReason.AuthenticationRequired,
        denial: GitHubAccessDenialReason.NotConnected,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: false,
        burnRetryBudget: false,
      },
    });
  });

  it("sets Retry-After when service failures expose a retry delay", async () => {
    mocks.handle.mockResolvedValueOnce({
      ok: false,
      error: {
        success: false,
        error: "GitHub rate limited pull request creation.",
        code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
        reason: DesktopGithubPullRequestReason.ProviderRateLimited,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: true,
        burnRetryBudget: false,
        status: 429,
        retryAfterSeconds: 37,
      },
    });

    const response = await POST(request(preflightBody()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    expect(body.details.retryAfterSeconds).toBe(37);
  });
});

function preflightBody() {
  return {
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestMode.Preflight,
    repoFullName: "closedloop-ai/closedloop-ai",
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.closedloop.ai/desktop/github/pull-request",
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}
