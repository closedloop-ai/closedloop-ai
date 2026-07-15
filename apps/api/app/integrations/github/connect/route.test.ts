import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeOAuthCallbackMock = vi.fn();
const findByClerkIdMock = vi.fn();
const runPostConnectBackfillMock = vi.fn();
const waitUntilMock = vi.fn();

vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findByClerkId: findByClerkIdMock,
  },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (
      handler: (
        context: {
          clerkOrgId: string;
          user: { id: string; organizationId: string };
        },
        request: Request
      ) => Promise<Response>
    ) =>
    (request: Request) =>
      handler(
        {
          clerkOrgId: "clerk-org-1",
          user: { id: "user-1", organizationId: "org-1" },
        },
        request
      ),
}));

vi.mock("../backfill-service", () => ({
  githubBackfillService: {
    runPostConnectBackfill: runPostConnectBackfillMock,
  },
}));

vi.mock("../service", () => ({
  githubService: {
    completeOAuthCallback: completeOAuthCallbackMock,
  },
}));

const { POST } = await import("./route");

const EMPTY_CONTEXT = { params: Promise.resolve({}) };

describe("POST /integrations/github/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByClerkIdMock.mockResolvedValue({ id: "org-1" });
    completeOAuthCallbackMock.mockResolvedValue({ status: "connected" });
    runPostConnectBackfillMock.mockResolvedValue({
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 0,
      pullRequestCount: 0,
      branchProjectionChangeCount: 0,
      pullRequestProjectionChangeCount: 0,
      reviewDecisionProjectionChangeCount: 0,
      checkProjectionChangeCount: 0,
      issueCommentProjectionChangeCount: 0,
      reviewCommentProjectionChangeCount: 0,
      reviewThreadProjectionChangeCount: 0,
      reviewProjectionChangeCount: 0,
      statusCheckProjectionChangeCount: 0,
      skippedBranchCount: 0,
      dryRun: true,
      ownerApprovalRequired: true,
      failures: [],
    });
  });

  it("runs a bounded shared-writer first slice and schedules the shared-writer continuation after connect", async () => {
    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      connected: true,
      backfill: { status: GitHubBackfillStatus.FirstSliceStarted },
    });
    expect(runPostConnectBackfillMock).toHaveBeenNthCalledWith(1, {
      approvedForVisibleWrites: true,
      organizationId: "org-1",
      repositoryLimit: 1,
    });
    expect(runPostConnectBackfillMock).toHaveBeenNthCalledWith(2, {
      approvedForVisibleWrites: true,
      bypassCooldown: true,
      organizationId: "org-1",
    });
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
  });

  it("does not start backfill when GitHub requires account confirmation", async () => {
    completeOAuthCallbackMock.mockResolvedValueOnce({
      status: "requires_confirmation",
      priorAccount: { accountId: "old", accountLogin: "old-org" },
      newAccount: { accountId: "new", accountLogin: "new-org" },
      newInstallationId: "installation-new",
    });

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.connected).toBe(false);
    expect(body.data.status).toBe("requires_confirmation");
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it("keeps connect successful when the bounded first slice fails", async () => {
    runPostConnectBackfillMock
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({
        status: GitHubBackfillStatus.OwnerApprovalRequired,
        repositoryCount: 1,
        branchCount: 0,
        pullRequestCount: 0,
        branchProjectionChangeCount: 0,
        pullRequestProjectionChangeCount: 0,
        reviewDecisionProjectionChangeCount: 0,
        checkProjectionChangeCount: 0,
        issueCommentProjectionChangeCount: 0,
        reviewCommentProjectionChangeCount: 0,
        reviewThreadProjectionChangeCount: 0,
        reviewProjectionChangeCount: 0,
        statusCheckProjectionChangeCount: 0,
        skippedBranchCount: 0,
        dryRun: true,
        ownerApprovalRequired: true,
        failures: [],
      });

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      connected: true,
      backfill: { status: GitHubBackfillStatus.Degraded },
    });
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
  });
});

function connectRequest(): NextRequest {
  return new NextRequest("http://localhost:3002/integrations/github/connect", {
    method: "POST",
    body: JSON.stringify({ code: "oauth-code", installationId: "123" }),
  });
}
