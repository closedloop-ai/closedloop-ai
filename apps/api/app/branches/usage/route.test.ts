import { BranchViewerScope } from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchUsage: vi.fn(),
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
      getBranchUsage: mocks.getBranchUsage,
    },
  };
});

import { GET } from "./route";

describe("GET /branches/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.getBranchUsage.mockResolvedValue(branchUsage());
  });

  it("requires read scope and forwards parsed usage query to the org-scoped service", async () => {
    const response = await GET(
      request("https://api.example.test/branches/usage?limit=10&offset=2"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchUsage).toHaveBeenCalledWith("org-1", {
      limit: 10,
      offset: 2,
    });
    expect(body).toEqual({
      success: true,
      data: branchUsage(),
    });
  });

  it("accepts shared search filters for usage queries", async () => {
    const response = await GET(
      request("https://api.example.test/branches/usage?search=feature"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getBranchUsage).toHaveBeenCalledWith("org-1", {
      limit: 50,
      offset: 0,
      search: "feature",
    });
    expect(body).toEqual({
      success: true,
      data: branchUsage(),
    });
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

function branchUsage() {
  return {
    viewerScope: BranchViewerScope.Organization,
    totalBranches: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 0,
    hourBuckets: [],
    phaseStacks: [],
    byActor: [
      {
        owner: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
    ],
  };
}
