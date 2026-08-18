import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchSessionPresence,
  BranchStatus,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { TagColor } from "@repo/api/src/types/tag";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRANCH_LIST_DEFAULT_LIMIT } from "./branch-read-service";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
    apiKeyScopes: undefined as ApiKeyScope[] | undefined,
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
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
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
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      {
        limit: 25,
        offset: 5,
        endDate: new Date("2026-07-03T00:00:00.000Z"),
        projectId: ["project-1"],
        repo: ["closedloop-ai/symphony-alpha"],
        search: "feature",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        status: [BranchStatus.Draft, BranchStatus.Open],
      },
      { canApply: true, canRemove: true }
    );
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

  it("forwards the FEA-4003 linked-session + LOC-range params to the service", async () => {
    const response = await GET(
      request(
        "https://api.example.test/branches?sessionPresence=has&locMin=10&locMax=500"
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      {
        limit: BRANCH_LIST_DEFAULT_LIMIT,
        offset: 0,
        sessionPresence: BranchSessionPresence.Has,
        locMin: 10,
        locMax: 500,
      },
      { canApply: true, canRemove: true }
    );
  });

  it("forwards granular API-key tag association permissions", async () => {
    mocks.auth.authMethod = "api_key";
    mocks.auth.apiKeyScopes = ["read", "write"];

    const response = await GET(
      request("https://api.example.test/branches"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
      { canApply: true, canRemove: false }
    );
  });

  it("leaves a blank LOC bound UNSET instead of coercing it to 0", async () => {
    // `?locMax=` (empty) must forward `locMax: undefined`, not a max-0 filter.
    const response = await GET(
      request("https://api.example.test/branches?locMin=&locMax="),
      routeContext()
    );

    expect(response.status).toBe(200);
    const [, forwarded] = mocks.listBranches.mock.calls.at(-1) ?? [];
    expect(forwarded?.locMin).toBeUndefined();
    expect(forwarded?.locMax).toBeUndefined();
  });

  it("rejects an unknown session-presence value before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?sessionPresence=maybe"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects a negative LOC bound before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?locMin=-1"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects an inverted LOC range (locMin > locMax) before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?locMin=500&locMax=10"),
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
        artifactId: "11111111-1111-4111-8111-111111111111",
        tags: [{ id: "tag-1", name: "backend", color: TagColor.Blue }],
        tagAvailability: BranchTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
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
