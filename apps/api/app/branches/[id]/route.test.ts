import { BranchStatus, BranchViewerScope } from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  deleteBranchArtifact: vi.fn(),
  getBranchDetail: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request, context.params);
    },
}));

vi.mock("@/app/branches/branch-read-service", () => ({
  branchReadService: {
    getBranchDetail: mocks.getBranchDetail,
  },
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: {
    deleteBranchArtifact: mocks.deleteBranchArtifact,
  },
}));

import { GET } from "./route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.getBranchDetail.mockResolvedValue(branchDetail());
  });

  it("requires read scope and returns the org-scoped branch detail", async () => {
    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith("org-1", branchId);
    expect(mocks.deleteBranchArtifact).not.toHaveBeenCalled();
    expect(body).toEqual({
      success: true,
      data: branchDetail(),
    });
  });

  it("returns not found when the branch detail service has no scoped match", async () => {
    mocks.getBranchDetail.mockResolvedValueOnce(null);

    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith("org-1", branchId);
    expect(body).toEqual({
      success: false,
      error: "Branch not found",
    });
  });
});

function request() {
  return new NextRequest(`https://api.example.test/branches/${branchId}`, {
    method: "GET",
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function branchDetail() {
  return {
    id: branchId,
    branchName: "feature/branches-api",
    baseBranch: "main",
    repoFullName: "closedloop-ai/symphony-alpha",
    owner: "user-1",
    status: BranchStatus.Open,
    prNumber: 7,
    prTitle: "Add Branches API",
    prState: null,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: 10,
    deletions: 2,
    filesChanged: 3,
    estimatedCostUsd: 1.25,
    lastActivityAt: "2026-07-03T05:00:00.000Z",
    sessionIds: ["session-artifact-1"],
    viewerScope: BranchViewerScope.Organization,
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: "head-sha",
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: {
      firstActivityT: null,
      lastActivityT: null,
      idleSpans: [],
    },
    linkedPrNumbers: [7],
    linkedArtifacts: [{ slug: "FEA-2532" }],
  };
}
