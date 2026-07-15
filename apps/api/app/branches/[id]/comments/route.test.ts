import { BranchCommentsState } from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchComments: vi.fn(),
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

vi.mock("@/app/branches/branch-comments-service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/branches/branch-comments-service")
    >();
  return {
    ...actual,
    branchCommentsService: {
      getBranchComments: mocks.getBranchComments,
    },
  };
});

import { GET } from "./route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]/comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.getBranchComments.mockResolvedValue(commentsResponse());
  });

  it("requires read scope and returns org-scoped branch comments", async () => {
    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchComments).toHaveBeenCalledWith("org-1", branchId, {});
    expect(body).toEqual({ success: true, data: commentsResponse() });
  });

  it("rejects unsupported query params instead of silently dropping filters", async () => {
    const response = await GET(
      request("unsupported=value"),
      routeContext(branchId)
    );

    expect(response.status).toBe(400);
    expect(mocks.getBranchComments).not.toHaveBeenCalled();
  });

  it("returns not found when the branch comments service has no scoped match", async () => {
    mocks.getBranchComments.mockResolvedValueOnce(null);

    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: "Branch not found" });
  });
});

function request(query = "") {
  const suffix = query ? `?${query}` : "";
  return new NextRequest(
    `https://api.example.test/branches/${branchId}/comments${suffix}`,
    { method: "GET" }
  );
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function commentsResponse() {
  return {
    branchId,
    state: BranchCommentsState.UnsyncedUnknown,
    comments: [],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16_384,
      maxResponseBytes: 524_288,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber: null,
    prUrl: null,
  };
}
