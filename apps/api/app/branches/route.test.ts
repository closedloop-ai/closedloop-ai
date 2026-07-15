import { BranchStatus, BranchViewerScope } from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  listBranches: vi.fn(),
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

vi.mock("./branch-read-service", async () => {
  const actual = await vi.importActual<typeof import("./branch-read-service")>(
    "./branch-read-service"
  );

  return {
    ...actual,
    branchReadService: {
      ...actual.branchReadService,
      listBranches: mocks.listBranches,
    },
  };
});

import { GET } from "./route";

describe("GET /branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.listBranches.mockResolvedValue(branchList());
  });

  it("requires read scope and forwards parsed list query to the org-scoped service", async () => {
    const response = await GET(
      request(
        "https://api.example.test/branches?repo=closedloop-ai/symphony-alpha&status=draft&status=open&limit=25&offset=5&search=feature&startDate=2026-07-01T00%3A00%3A00.000Z&endDate=2026-07-03T00%3A00%3A00.000Z&projectId=project-1"
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.listBranches).toHaveBeenCalledWith("org-1", {
      limit: 25,
      offset: 5,
      endDate: new Date("2026-07-03T00:00:00.000Z"),
      projectId: ["project-1"],
      repo: ["closedloop-ai/symphony-alpha"],
      search: "feature",
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      status: [BranchStatus.Draft, BranchStatus.Open],
    });
    expect(body).toEqual({
      success: true,
      data: branchList(),
    });
  });

  it("rejects invalid list query before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?status=blocked"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects unsupported filter query params before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?owner=alice"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
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

function branchList() {
  return {
    viewerScope: BranchViewerScope.Organization,
    total: 1,
    hasMore: false,
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        branchName: "feature/branches-api",
        baseBranch: "main",
        repoFullName: "closedloop-ai/symphony-alpha",
        owner: null,
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
        estimatedCostUsd: null,
        lastActivityAt: "2026-07-03T05:00:00.000Z",
        sessionIds: [],
      },
    ],
  };
}
