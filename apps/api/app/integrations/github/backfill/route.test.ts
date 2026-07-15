import {
  GitHubBackfillMode,
  GitHubBackfillStatus,
} from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runPostConnectBackfillMock = vi.fn();
const getLatestBackfillSummaryMock = vi.fn();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => (request: Request) =>
    handler({ user: { organizationId: "org-1" } }, request),
}));

vi.mock("@/app/integrations/github/backfill-service", () => ({
  githubBackfillService: {
    getLatestBackfillSummary: getLatestBackfillSummaryMock,
    runPostConnectBackfill: runPostConnectBackfillMock,
  },
}));

const { GET, POST } = await import("./route");

const EMPTY_CONTEXT = { params: Promise.resolve({}) };

describe("/integrations/github/backfill route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPostConnectBackfillMock.mockResolvedValue({
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 2,
      pullRequestCount: 3,
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
    getLatestBackfillSummaryMock.mockResolvedValue({
      status: GitHubBackfillStatus.NotStarted,
      repositoryCount: 0,
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

  it("POST runs a bounded backfill summary for the authenticated organization", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3002/integrations/github/backfill", {
        method: "POST",
        body: JSON.stringify({ repositoryLimit: 1 }),
      }),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary.repositoryCount).toBe(1);
    expect(runPostConnectBackfillMock).toHaveBeenCalledWith({
      approvedForVisibleWrites: false,
      organizationId: "org-1",
      repositoryLimit: 1,
    });
  });

  it("rate-limits overlapping visible-write retries for the same organization", async () => {
    let releaseBackfill: (() => void) | undefined;
    runPostConnectBackfillMock.mockReturnValue(
      new Promise((resolve) => {
        releaseBackfill = () =>
          resolve({
            status: GitHubBackfillStatus.Completed,
            repositoryCount: 1,
            branchCount: 2,
            pullRequestCount: 3,
            branchProjectionChangeCount: 1,
            pullRequestProjectionChangeCount: 1,
            reviewDecisionProjectionChangeCount: 1,
            checkProjectionChangeCount: 1,
            issueCommentProjectionChangeCount: 0,
            reviewCommentProjectionChangeCount: 0,
            reviewThreadProjectionChangeCount: 0,
            reviewProjectionChangeCount: 0,
            statusCheckProjectionChangeCount: 0,
            skippedBranchCount: 0,
            dryRun: false,
            ownerApprovalRequired: false,
            failures: [],
          });
      })
    );
    const first = POST(
      new NextRequest("http://localhost:3002/integrations/github/backfill", {
        method: "POST",
        body: JSON.stringify({ mode: GitHubBackfillMode.Apply }),
      }),
      EMPTY_CONTEXT
    );

    const second = await POST(
      new NextRequest("http://localhost:3002/integrations/github/backfill", {
        method: "POST",
        body: JSON.stringify({ mode: GitHubBackfillMode.Apply }),
      }),
      EMPTY_CONTEXT
    );

    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    expect(runPostConnectBackfillMock).toHaveBeenCalledTimes(1);
    expect(runPostConnectBackfillMock).toHaveBeenCalledWith({
      approvedForVisibleWrites: true,
      organizationId: "org-1",
      repositoryLimit: undefined,
    });
    releaseBackfill?.();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
  });

  it("rejects request-body visible write approval", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3002/integrations/github/backfill", {
        method: "POST",
        body: JSON.stringify({ approvedForVisibleWrites: true }),
      }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(400);
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported request fields", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3002/integrations/github/backfill", {
        method: "POST",
        body: JSON.stringify({ queueName: "hidden" }),
      }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(400);
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
  });

  it("GET returns the latest persisted summary without rerunning backfill", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/integrations/github/backfill"),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary.status).toBe(GitHubBackfillStatus.NotStarted);
    expect(getLatestBackfillSummaryMock).toHaveBeenCalledWith("org-1");
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
  });
});
