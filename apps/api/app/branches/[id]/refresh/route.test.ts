import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  refreshBranch: vi.fn(),
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
    refreshBranch: mocks.refreshBranch,
  },
}));

import { POST } from "./route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("POST /branches/[id]/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.auth.authMethod = "session";
    mocks.refreshBranch.mockResolvedValue({
      branch: null,
      status: BranchRefreshStatus.Refreshed,
    });
  });

  it("requires write scope and forwards authenticated actor context", async () => {
    const response = await POST(request(), routeContext(branchId));

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["write"] }]);
    expect(mocks.refreshBranch).toHaveBeenCalledWith("org-1", branchId, {
      userId: "user-1",
      authMethod: "session",
    });
  });

  it("returns retry-after metadata for retryable refresh responses", async () => {
    mocks.refreshBranch.mockResolvedValueOnce({
      branch: null,
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.BudgetExhausted,
      retryAfterSeconds: 30,
    });

    const response = await POST(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(body).toEqual({
      success: true,
      data: {
        branch: null,
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.BudgetExhausted,
        retryAfterSeconds: 30,
      },
    });
  });
});

function request() {
  return new NextRequest(
    `https://api.example.test/branches/${branchId}/refresh`,
    {
      method: "POST",
    }
  );
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
