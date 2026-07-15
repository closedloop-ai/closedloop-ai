import { BranchViewerScope } from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchTrace: vi.fn(),
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

vi.mock("@/app/branches/branch-read-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/branch-read-service")
  >("@/app/branches/branch-read-service");

  return {
    ...actual,
    branchReadService: {
      ...actual.branchReadService,
      getBranchTrace: mocks.getBranchTrace,
    },
  };
});

import { GET } from "./route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]/trace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.getBranchTrace.mockResolvedValue(branchTrace());
  });

  it("requires read scope and forwards parsed trace query bounds", async () => {
    const response = await GET(
      request(`https://api.example.test/branches/${branchId}/trace?limit=25`),
      routeContext(branchId)
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchTrace).toHaveBeenCalledWith("org-1", branchId, {
      limit: 25,
      offset: 0,
    });
    expect(body).toEqual({
      success: true,
      data: branchTrace(),
    });
  });

  it("rejects invalid trace query before service work", async () => {
    const response = await GET(
      request(`https://api.example.test/branches/${branchId}/trace?limit=101`),
      routeContext(branchId)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.getBranchTrace).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("returns not found when the trace service has no scoped branch match", async () => {
    mocks.getBranchTrace.mockResolvedValueOnce(null);

    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(mocks.getBranchTrace).toHaveBeenCalledWith("org-1", branchId, {
      limit: 50,
      offset: 0,
    });
    expect(body).toEqual({
      success: false,
      error: "Branch not found",
    });
  });
});

function request(url = `https://api.example.test/branches/${branchId}/trace`) {
  return new NextRequest(url, {
    method: "GET",
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function branchTrace() {
  return {
    branchId,
    viewerScope: BranchViewerScope.Organization,
    items: [
      {
        type: "sessionstart",
        sessionId: "session-artifact-1",
        t: "2026-07-03T05:00:00.000Z",
        actor: {
          name: "Codex",
          harness: "codex",
        },
      },
    ],
    hasMore: false,
  };
}
