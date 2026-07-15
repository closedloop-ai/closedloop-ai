import { BranchKpiState, BranchViewerScope } from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchAnalytics: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request);
    },
}));

vi.mock("@/app/branches/branch-read-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/branch-read-service")
  >("@/app/branches/branch-read-service");

  return {
    ...actual,
    branchReadService: {
      ...actual.branchReadService,
      getBranchAnalytics: mocks.getBranchAnalytics,
    },
  };
});

import { GET } from "./route";

describe("GET /branches/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.getBranchAnalytics.mockResolvedValue(branchAnalytics());
  });

  it("requires read scope and forwards parsed analytics query to the org-scoped service", async () => {
    const response = await GET(
      request("https://api.example.test/branches/analytics?repo=repo-a"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchAnalytics).toHaveBeenCalledWith("org-1", {
      limit: 50,
      offset: 0,
      repo: ["repo-a"],
    });
    expect(body).toEqual({
      success: true,
      data: branchAnalytics(),
    });
  });

  it("rejects invalid analytics query before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches/analytics?limit=0"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.getBranchAnalytics).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });
});

function request(url: string) {
  return new NextRequest(url, {
    method: "GET",
  });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

function branchAnalytics() {
  return {
    viewerScope: BranchViewerScope.Organization,
    medianPrSize: kpi(null),
    mergeRate: kpi(null),
    medianTimeToMergeMs: kpi(null, BranchKpiState.Gated),
    activePrCount: kpi(0, BranchKpiState.Available),
    mergedCount: kpi(0, BranchKpiState.Available),
    leadTimeForChangeMs: kpi(null, BranchKpiState.Gated),
    locPerDollar: kpi(null),
    totalSpendUsd: kpi(null),
    activeBranchCount: kpi(0, BranchKpiState.Available),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
  };
}

function kpi(
  value: number | null,
  state: BranchKpiState = BranchKpiState.Unavailable
) {
  return {
    value,
    state,
    baseline30d: null,
    deltaPct: null,
  };
}
