import { BranchCompatibilityOutcome } from "@repo/api/src/types/branch-compatibility";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1", organizationId: "org-1" } },
  resolve: vi.fn(),
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

vi.mock("@/app/branches/branch-compatibility-resolver", () => ({
  branchCompatibilityResolver: { resolve: mocks.resolve },
}));

import { GET } from "./route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]/compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.resolve.mockResolvedValue({
      outcome: BranchCompatibilityOutcome.Unavailable,
    });
  });

  it("returns the same unavailable envelope for an org-scoped miss", async () => {
    const response = await GET(request(), routeContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { outcome: BranchCompatibilityOutcome.Unavailable },
    });
    expect(mocks.resolve).toHaveBeenCalledWith("org-1", branchId);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
  });

  it("returns only the bounded eligible redirect decision", async () => {
    mocks.resolve.mockResolvedValueOnce({
      branchArtifactId: branchId,
      outcome: BranchCompatibilityOutcome.Eligible,
      providerUrl: "https://github.com/acme/repo/pull/42",
    });

    const response = await GET(request(), routeContext());

    expect(await response.json()).toEqual({
      success: true,
      data: {
        branchArtifactId: branchId,
        outcome: BranchCompatibilityOutcome.Eligible,
        providerUrl: "https://github.com/acme/repo/pull/42",
      },
    });
  });

  it("normalizes an invalid route id to the unavailable envelope", async () => {
    const response = await GET(
      request("not-a-uuid"),
      routeContext("not-a-uuid")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { outcome: BranchCompatibilityOutcome.Unavailable },
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

function request(id = branchId) {
  return new NextRequest(
    `https://api.example.test/branches/${id}/compatibility`
  );
}

function routeContext(id = branchId) {
  return { params: Promise.resolve({ id }) };
}
