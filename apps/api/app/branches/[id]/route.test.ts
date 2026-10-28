import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchStatus,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { BranchDetailChecksDelivery } from "@repo/api/src/types/branch-associated-pull-request";
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
  readBranchPenseroNumerator: vi.fn(),
  refreshBranchDetailPullRequest: vi.fn(),
  waitUntil: vi.fn(),
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
    refreshBranchDetailPullRequest: mocks.refreshBranchDetailPullRequest,
  },
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("@/app/branches/branch-selected-pull-request-checks-service", () => ({
  branchSelectedPullRequestChecksService: {
    enrichBranchDetail: mocks.enrichBranchDetail,
  },
}));

// ISS-9814: mocked so this suite does not pull the real delivery-point read —
// and its Prisma + PostHog import chain — into a route unit test.
vi.mock("@/app/branches/branch-pensero-numerator", () => ({
  readBranchPenseroNumerator: mocks.readBranchPenseroNumerator,
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: {
    deleteBranchArtifact: mocks.deleteBranchArtifact,
  },
}));

import { GET } from "./route";
import { GET as GET_SELECTION } from "./selected-pull-request/route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
    mocks.getBranchDetail.mockResolvedValue(branchDetail());
    // ISS-9814: the default production answer for a reader outside the display
    // rollout. Set explicitly so the expectations below assert the real shape
    // rather than whatever an unstubbed mock happens to return.
    mocks.readBranchPenseroNumerator.mockResolvedValue(null);
    mocks.refreshBranchDetailPullRequest.mockResolvedValue(undefined);
    mocks.enrichBranchDetail.mockImplementation(
      (_organizationId: string, _userId: string, detail: unknown) =>
        Promise.resolve(detail)
    );
  });

  it("requires read scope and returns the org-scoped branch detail", async () => {
    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: true, canRemove: true },
      undefined,
      detailReadOptions()
    );
    expect(mocks.deleteBranchArtifact).not.toHaveBeenCalled();
    expect(body).toEqual({
      success: true,
      data: branchDetail(),
    });
  });

  it("serves the selected PR projection with the same org permissions and no branch evidence duplication", async () => {
    const response = await GET_SELECTION(
      request(
        "repositoryFullName=ClosedLoop-AI%2FClosedLoop-AI&pullRequestNumber=17"
      ),
      routeContext(branchId)
    );
    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: true, canRemove: true },
      {
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 17,
      },
      detailReadOptions()
    );
    const body = await response.json();
    expect(body.data.prTitle).toBe(branchDetail().prTitle);
    for (const key of ["sessions", "commits", "mergedTrace", "tags", "id"]) {
      expect(body.data).not.toHaveProperty(key);
    }
    expect(mocks.enrichBranchDetail).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "repositoryFullName=owner%2Frepo&pullRequestNumber=0",
    "repositoryFullName=owner%2Frepo&pullRequestNumber=1&extra=true",
  ])(
    "rejects missing or unsupported selected-PR query fields: %s",
    async (query) => {
      const response = await GET_SELECTION(
        request(query),
        routeContext(branchId)
      );
      expect(response.status).toBe(400);
      expect(mocks.getBranchDetail).not.toHaveBeenCalled();
    }
  );

  it("returns a scoped miss from the selected PR route", async () => {
    mocks.getBranchDetail.mockResolvedValueOnce(null);
    const response = await GET_SELECTION(
      request("repositoryFullName=owner%2Frepo&pullRequestNumber=1"),
      routeContext(branchId)
    );
    expect(response.status).toBe(404);
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
      undefined,
      detailReadOptions()
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
      undefined,
      detailReadOptions()
    );
  });

  it("forwards a canonical complete selected-PR identity", async () => {
    const response = await GET(
      request(
        "repositoryFullName=ClosedLoop-AI%2FClosedLoop-AI&pullRequestNumber=17"
      ),
      routeContext(branchId)
    );

    expect(response.status).toBe(200);
    expect(mocks.getBranchDetail).toHaveBeenCalledWith(
      "org-1",
      branchId,
      { canApply: true, canRemove: true },
      {
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 17,
      },
      detailReadOptions()
    );
  });

  it("ISS-9814: reads the Pensero numerator for the authenticated org and this branch", async () => {
    await GET(request(), routeContext(branchId));

    // The org id is the principal's, resolved by withAnyAuth — never anything
    // the request named. The branch key is the artifact id from the path.
    expect(mocks.readBranchPenseroNumerator).toHaveBeenCalledWith(
      { userId: "user-1", clerkUserId: undefined },
      "org-1",
      branchId
    );
  });

  it("ISS-9814: forwards a resolved Pensero numerator into the detail read", async () => {
    // Without this case the whole route→service wiring could be deleted and the
    // suite would stay green on the null default every other case asserts.
    mocks.readBranchPenseroNumerator.mockResolvedValueOnce({
      points: 20,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });

    await GET(request(), routeContext(branchId));

    const options = mocks.getBranchDetail.mock.calls[0]?.[4];
    await expect(options?.penseroPoints).resolves.toEqual({
      points: 20,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
  });

  it("rejects a half selected-PR identity before service reads", async () => {
    const response = await GET(
      request("pullRequestNumber=17"),
      routeContext(branchId)
    );

    expect(response.status).toBe(400);
    expect(mocks.getBranchDetail).not.toHaveBeenCalled();
  });

  it("ISS-12278: starts the detail read while the Pensero read is pending", async () => {
    let releasePensero!: () => void;
    mocks.readBranchPenseroNumerator.mockReturnValueOnce(
      new Promise((resolve) => {
        releasePensero = () => resolve(null);
      })
    );

    const responsePromise = GET(request(), routeContext(branchId));
    await vi.waitFor(() => {
      expect(mocks.getBranchDetail).toHaveBeenCalled();
    });

    releasePensero();
    expect((await responsePromise).status).toBe(200);
  });

  it("ISS-12278: schedules the stale-PR refresh past the response instead of awaiting it", async () => {
    // Never settles: a route that awaited the refresh would never respond.
    const pendingRefresh = new Promise<void>(() => undefined);
    mocks.refreshBranchDetailPullRequest.mockReturnValueOnce(pendingRefresh);
    mocks.getBranchDetail.mockImplementationOnce(readReportingRefreshDue);

    const response = await GET(
      request(
        "repositoryFullName=ClosedLoop-AI%2FClosedLoop-AI&pullRequestNumber=17"
      ),
      routeContext(branchId)
    );

    expect(response.status).toBe(200);
    expect(mocks.refreshBranchDetailPullRequest).toHaveBeenCalledWith({
      actor: {
        authMethod: "session",
        tagPermissions: { canApply: true, canRemove: true },
        userId: "user-1",
      },
      branchId,
      organizationId: "org-1",
      requestedPullRequest: {
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 17,
      },
    });
    expect(mocks.waitUntil).toHaveBeenCalledWith(pendingRefresh);
  });

  it("ISS-12278: omits the requested PR from the refresh when none was named", async () => {
    mocks.getBranchDetail.mockImplementationOnce(readReportingRefreshDue);

    await GET(request(), routeContext(branchId));

    expect(mocks.refreshBranchDetailPullRequest).toHaveBeenCalledWith({
      actor: {
        authMethod: "session",
        tagPermissions: { canApply: true, canRemove: true },
        userId: "user-1",
      },
      branchId,
      organizationId: "org-1",
    });
  });

  it("ISS-12278: schedules no refresh when the read reports none pending", async () => {
    const response = await GET(request(), routeContext(branchId));

    expect(response.status).toBe(200);
    expect(mocks.refreshBranchDetailPullRequest).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("ISS-12278: keeps selected-PR checks inline for a caller that has not opted into lazy checks", async () => {
    const response = await GET(request(), routeContext(branchId));

    expect(response.status).toBe(200);
    expect(mocks.enrichBranchDetail).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      branchDetail(),
      expect.any(AbortSignal)
    );
  });

  it("ISS-12278: skips inline checks for a checks=lazy caller", async () => {
    const response = await GET(
      request(`checks=${BranchDetailChecksDelivery.Lazy}`),
      routeContext(branchId)
    );

    expect(response.status).toBe(200);
    expect(mocks.enrichBranchDetail).not.toHaveBeenCalled();
  });

  it("ISS-12278: answers not found when inline checks find the branch ineligible", async () => {
    mocks.enrichBranchDetail.mockResolvedValueOnce(null);

    const response = await GET(request(), routeContext(branchId));

    expect(response.status).toBe(404);
  });

  it("ISS-12278: schedules no refresh when the flag reports only an in-flight one", async () => {
    mocks.getBranchDetail.mockResolvedValueOnce({
      ...branchDetail(),
      pullRequestRefreshPending: true as const,
    });

    await GET(request(), routeContext(branchId));

    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("schedules no refresh for a branch the read did not find", async () => {
    mocks.getBranchDetail.mockResolvedValueOnce(null);

    await GET(request(), routeContext(branchId));

    expect(mocks.refreshBranchDetailPullRequest).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("does not turn a detail read failure into a stale success", async () => {
    mocks.getBranchDetail.mockRejectedValueOnce(new Error("read failed"));

    const response = await GET(request(), routeContext(branchId));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to fetch branch",
    });
    expect(mocks.refreshBranchDetailPullRequest).not.toHaveBeenCalled();
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
    repoFullName: "closedloop-ai/closedloop-ai",
    owner: "user-1",
    status: BranchStatus.Open,
    prNumber: 7,
    prTitle: "Add Branches API",
    prState: null,
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
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

function detailReadOptions() {
  return {
    penseroPoints: expect.any(Promise),
    onPullRequestRefreshDue: expect.any(Function),
  };
}

function readReportingRefreshDue(
  _organizationId: string,
  _branchId: string,
  _tagPermissions: unknown,
  _requestedPullRequest: unknown,
  options: { onPullRequestRefreshDue?: () => void }
) {
  options.onPullRequestRefreshDue?.();
  return Promise.resolve({
    ...branchDetail(),
    pullRequestRefreshPending: true as const,
  });
}
