import {
  DesktopGithubPullRequestApiMaxDurationSeconds,
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    clerkUserId: "clerk-user-1",
    clerkOrgId: "clerk-org-1",
    authMethod: "desktop_session" as "desktop_session" | "session" | "api_key",
  },
  update: vi.fn(),
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

vi.mock("../service", () => ({
  desktopGithubPullRequestService: {
    update: mocks.update,
  },
}));

import { maxDuration, PATCH } from "./route";

describe("PATCH /desktop/github/pull-request/[number]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.authMethod = "desktop_session";
    mocks.update.mockResolvedValue({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Update,
        status: DesktopGithubPullRequestStatus.Updated,
        pullRequest: {
          number: 42,
          url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
          headBranch: "feature/no-gh",
          baseBranch: "main",
        },
      },
    });
  });

  it("uses the shared PR API route duration contract", () => {
    expect(maxDuration).toBe(DesktopGithubPullRequestApiMaxDurationSeconds);
  });

  it("passes update requests to the service for desktop-session callers", async () => {
    const body = {
      contractVersion: DesktopGithubPullRequestContractVersion,
      repoFullName: "closedloop-ai/closedloop-ai",
      title: "Updated PR title",
    };

    const response = await PATCH(request(body), routeContext("42"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({
      success: true,
      contractVersion: DesktopGithubPullRequestContractVersion,
      mode: DesktopGithubPullRequestSuccessMode.Update,
      status: DesktopGithubPullRequestStatus.Updated,
      pullRequest: {
        number: 42,
        url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        headBranch: "feature/no-gh",
        baseBranch: "main",
      },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      pullNumber: 42,
      request: body,
      now: expect.any(Date),
    });
  });

  it("rejects non-positive route numbers before invoking the service", async () => {
    const response = await PATCH(
      request({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        title: "Updated PR title",
      }),
      routeContext("0")
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "pull request number must be a positive integer",
      code: DesktopGithubPullRequestErrorCode.ValidationFailed,
      details: {
        reason: DesktopGithubPullRequestReason.ValidationFailed,
        stage: DesktopGithubPullRequestStage.ApiUpdate,
        retryable: false,
        burnRetryBudget: false,
      },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects non-desktop auth methods", async () => {
    mocks.auth.authMethod = "api_key";

    const response = await PATCH(
      request({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        title: "Updated PR title",
      }),
      routeContext("42")
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Desktop session authentication is required.",
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      details: {
        reason: DesktopGithubPullRequestReason.AuthorizationDenied,
        stage: DesktopGithubPullRequestStage.ApiUpdate,
        retryable: false,
        burnRetryBudget: false,
      },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects empty label-only updates before invoking the service", async () => {
    const response = await PATCH(
      request({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        labels: [],
      }),
      routeContext("42")
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid desktop pull request update payload",
      code: DesktopGithubPullRequestErrorCode.ValidationFailed,
      details: {
        reason: DesktopGithubPullRequestReason.ValidationFailed,
        stage: DesktopGithubPullRequestStage.ApiUpdate,
        retryable: false,
        burnRetryBudget: false,
      },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.closedloop.ai/desktop/github/pull-request/42",
    {
      body: JSON.stringify(body),
      method: "PATCH",
    }
  );
}

function routeContext(number: string) {
  return { params: Promise.resolve({ number }) };
}
