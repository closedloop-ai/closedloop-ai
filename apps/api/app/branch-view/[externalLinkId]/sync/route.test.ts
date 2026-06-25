import {
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
  BranchViewSyncScope,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewContextCredentialSource } from "@/lib/resolve-pr-context";

const mocks = vi.hoisted(() => ({
  resolveBranchViewSyncPreflightContext: vi.fn(),
  syncBranchViewData: vi.fn(),
  user: { id: "user-1", organizationId: "org-1" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler({ user: mocks.user }, request, context.params),
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  BranchViewContextCredentialSource: {
    PinnedActive: "pinned_active",
    ActiveSibling: "active_sibling",
  },
}));

vi.mock("../service", () => ({
  resolveBranchViewSyncPreflightContext:
    mocks.resolveBranchViewSyncPreflightContext,
  syncBranchViewDataWithRequest: mocks.syncBranchViewData,
}));

import { POST } from "./route";

function request(body?: unknown) {
  return new NextRequest(
    "https://api.example.test/branch-view/branch-artifact-1/sync",
    body === undefined
      ? { method: "POST" }
      : { body: JSON.stringify(body), method: "POST" }
  );
}

function routeContext() {
  return { params: Promise.resolve({ externalLinkId: "branch-artifact-1" }) };
}

describe("POST /branch-view/[externalLinkId]/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBranchViewSyncPreflightContext.mockResolvedValue({
      status: "ready",
      ctx: {
        externalLink: { id: "branch-artifact-1" },
        credentialSource: BranchViewContextCredentialSource.PinnedActive,
      },
    });
    mocks.syncBranchViewData.mockResolvedValue({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Branch,
    });
  });

  it("defaults a missing body to branch scope", async () => {
    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.syncBranchViewData).toHaveBeenCalledWith(
      expect.objectContaining({
        externalLink: { id: "branch-artifact-1" },
        credentialSource: BranchViewContextCredentialSource.PinnedActive,
      }),
      { scope: BranchViewSyncScope.Branch }
    );
    expect(body).toEqual({
      success: true,
      data: { synced: true, scope: BranchViewSyncScope.Branch },
    });
  });

  it("passes explicit comments scope to the service", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Comments,
    });

    const response = await POST(
      request({ scope: BranchViewSyncScope.Comments }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.syncBranchViewData).toHaveBeenCalledWith(
      expect.objectContaining({
        externalLink: { id: "branch-artifact-1" },
        credentialSource: BranchViewContextCredentialSource.PinnedActive,
      }),
      { scope: BranchViewSyncScope.Comments }
    );
    expect(body).toEqual({
      success: true,
      data: { synced: true, scope: BranchViewSyncScope.Comments },
    });
  });

  it("rejects unknown sync scopes before calling the service", async () => {
    const response = await POST(
      request({ scope: "everything" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid Branch View sync scope",
    });
    expect(mocks.syncBranchViewData).not.toHaveBeenCalled();
  });

  it("returns a failure envelope with retry metadata for throttled sync", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: null,
      retryAfterSeconds: 37,
      throttleReason: BranchViewSyncThrottleReason.LocalDedupe,
      scope: BranchViewSyncScope.Branch,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    expect(body).toEqual({
      success: false,
      error: "Branch view sync is throttled",
      code: BranchViewSyncErrorCode.SyncThrottled,
      details: {
        retryAfterSeconds: 37,
        throttleReason: BranchViewSyncThrottleReason.LocalDedupe,
      },
    });
  });

  it.each([
    [
      "in-flight branch sync",
      BranchViewSyncScope.Branch,
      BranchViewSyncThrottleReason.InFlight,
      60,
    ],
    [
      "branch provider rate limit",
      BranchViewSyncScope.Branch,
      BranchViewSyncThrottleReason.ProviderRateLimit,
      91,
    ],
    [
      "comments provider rate limit",
      BranchViewSyncScope.Comments,
      BranchViewSyncThrottleReason.ProviderRateLimit,
      45,
    ],
  ])("returns complete retry metadata for %s", async (_name, scope, throttleReason, retryAfterSeconds) => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: null,
      retryAfterSeconds,
      throttleReason,
      scope,
    });

    const response = await POST(request({ scope }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(retryAfterSeconds));
    expect(body).toEqual({
      success: false,
      error: "Branch view sync is throttled",
      code: BranchViewSyncErrorCode.SyncThrottled,
      details: {
        retryAfterSeconds,
        throttleReason,
      },
    });
  });

  it("preserves the normal success envelope after a completed sync", async () => {
    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { synced: true, scope: BranchViewSyncScope.Branch },
    });
  });

  it("uses the service-owned preflight context before syncing", async () => {
    const pinnedCtx = {
      externalLink: { id: "branch-artifact-1" },
      credentialSource: BranchViewContextCredentialSource.PinnedActive,
    };
    mocks.resolveBranchViewSyncPreflightContext.mockResolvedValueOnce({
      status: "ready",
      ctx: pinnedCtx,
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.resolveBranchViewSyncPreflightContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1"
    );
    expect(mocks.syncBranchViewData).toHaveBeenCalledWith(pinnedCtx, {
      scope: BranchViewSyncScope.Branch,
    });
  });

  it("stops sync when service preflight cannot produce pinned context", async () => {
    mocks.resolveBranchViewSyncPreflightContext.mockResolvedValueOnce({
      status: "failed",
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      details: {
        reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable,
      },
    });
    expect(mocks.syncBranchViewData).not.toHaveBeenCalled();
  });

  it("preserves stale-current-PR preflight failures before sync", async () => {
    mocks.resolveBranchViewSyncPreflightContext.mockResolvedValueOnce({
      status: "failed",
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      httpStatus: 409,
      reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
    });
    expect(mocks.syncBranchViewData).not.toHaveBeenCalled();
  });

  it("maps typed lifecycle unavailable failures to HTTP 502", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: "Failed to refresh pull request lifecycle",
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
      scope: BranchViewSyncScope.Branch,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: "Failed to refresh pull request lifecycle",
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
    });
  });

  it("maps typed guard failures to HTTP 409", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: "Failed to apply pull request lifecycle refresh",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      httpStatus: 409,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
      scope: BranchViewSyncScope.Branch,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "Failed to apply pull request lifecycle refresh",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
    });
  });

  it("maps typed stale relation failures to HTTP 409", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
      scope: BranchViewSyncScope.Branch,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
    });
  });

  it("maps typed file-cache failures to HTTP 500", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: "Failed to refresh branch file cache",
      code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
      httpStatus: 500,
      details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
      scope: BranchViewSyncScope.Branch,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to refresh branch file cache",
      code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
      details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
    });
  });

  it("maps typed PR sync failures to HTTP 502", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 502,
      details: {
        reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable,
      },
      scope: BranchViewSyncScope.Comments,
    });

    const response = await POST(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      details: {
        reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable,
      },
    });
  });

  it("maps comments-scope current PR precondition failures to HTTP 409", async () => {
    mocks.syncBranchViewData.mockResolvedValueOnce({
      synced: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
      scope: BranchViewSyncScope.Comments,
    });

    const response = await POST(
      request({ scope: BranchViewSyncScope.Comments }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
    });
  });
});
