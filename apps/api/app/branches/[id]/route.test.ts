import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchStatus,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { BranchSelectedPullRequestChecksAvailability } from "@repo/api/src/types/branch-selected-pull-request-checks";
import { TagColor } from "@repo/api/src/types/tag";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
    apiKeyScopes: undefined as ApiKeyScope[] | undefined,
  },
  deleteBranchArtifact: vi.fn(),
  enrichBranchDetail: vi.fn(),
  getBranchDetail: vi.fn(),
  logError: vi.fn(),
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

vi.mock("@/app/branches/branch-selected-pull-request-checks-service", () => ({
  branchSelectedPullRequestChecksService: {
    enrichBranchDetail: mocks.enrichBranchDetail,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError },
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
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
    mocks.getBranchDetail.mockResolvedValue(branchDetail());
    mocks.enrichBranchDetail.mockImplementation(
      async (_organizationId: string, _userId: string, branch: unknown) =>
        branch
    );
  });

  it("requires read scope and returns the org-scoped branch detail", async () => {
    const branchRequest = request();
    const requestSignal = branchRequest.signal;
    const response = await GET(branchRequest, routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: true, canRemove: true },
      undefined
    );
    expect(mocks.enrichBranchDetail).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      branchDetail(),
      requestSignal
    );
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
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: true, canRemove: true },
      undefined
    );
    expect(body).toEqual({
      success: false,
      error: "Branch not found",
    });
  });

  it("forwards read-only API-key tag association permissions", async () => {
    mocks.auth.authMethod = "api_key";
    mocks.auth.apiKeyScopes = ["read"];

    const response = await GET(request(), routeContext(branchId));

    expect(response.status).toBe(200);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: false, canRemove: false },
      undefined
    );
  });

  it("forwards a canonical complete selected-PR identity", async () => {
    const response = await GET(
      request(
        "repositoryFullName=ClosedLoop-AI%2FSymphony-Alpha&pullRequestNumber=17"
      ),
      routeContext(branchId)
    );

    expect(response.status).toBe(200);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: true, canRemove: true },
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 17,
      }
    );
  });

  it("rejects a half selected-PR identity before service reads", async () => {
    const response = await GET(
      request("pullRequestNumber=17"),
      routeContext(branchId)
    );

    expect(response.status).toBe(400);
    expect(mocks.getBranchDetail).not.toHaveBeenCalled();
  });

  it("returns selected-PR evidence and corrected legacy fields from enrichment", async () => {
    const enriched = {
      ...branchDetail(),
      checksStatus: ChecksStatus.Passing,
      checksPassed: 28,
      checksTotal: 28,
      selectedPullRequestChecks: {
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: {
          identity: {
            githubId: "123",
            repositoryFullName: "closedloop-ai/symphony-alpha",
            number: 7,
            url: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
          },
        },
      },
    };
    mocks.enrichBranchDetail.mockResolvedValueOnce(enriched);

    const response = await GET(request(), routeContext(branchId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: enriched,
    });
  });

  it("keeps Branch detail available and clears unsafe legacy fields when enrichment throws", async () => {
    const failure = new Error("enrichment failed");
    mocks.enrichBranchDetail.mockRejectedValueOnce(failure);

    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      ...branchDetail(),
      checksStatus: null,
      checksPassed: null,
      checksTotal: null,
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      "[branch-detail] Selected-PR checks enrichment failed",
      {
        branchId,
        organizationId: "org-1",
        error: failure,
      }
    );
  });
});

function request(query = "") {
  const suffix = query ? `?${query}` : "";
  return new NextRequest(
    `https://api.example.test/branches/${branchId}${suffix}`,
    {
      method: "GET",
    }
  );
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function branchDetail() {
  return {
    id: branchId,
    artifactId: branchId,
    tags: [{ id: "tag-1", name: "backend", color: TagColor.Blue }],
    tagAvailability: BranchTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
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
    checksTotal: 28,
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
