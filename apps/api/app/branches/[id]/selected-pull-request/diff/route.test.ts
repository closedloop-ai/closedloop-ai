import {
  BranchSelectedPullRequestAcquisitionUnavailableReason,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { SelectedPullRequestEvidenceUnavailableReason } from "@repo/api/src/types/selected-pull-request-evidence";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getDiff: vi.fn(),
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

vi.mock("@/app/branches/branch-selected-pull-request-files-service", () => ({
  branchSelectedPullRequestFilesService: {
    getDiff: mocks.getDiff,
  },
}));

import { GET } from "./route";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

describe("GET /branches/[id]/selected-pull-request/diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.getDiff.mockResolvedValue(staleResponse());
  });

  it("requires read scope and forwards canonical revision-pinned input", async () => {
    const selectedRequest = request();
    const response = await GET(selectedRequest, routeContext());

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getDiff).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      BRANCH_ID,
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 4471,
        path: "apps/api/a file.ts",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
      selectedRequest.signal
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: staleResponse(),
    });
  });

  it("rejects a missing or malformed revision before service work", async () => {
    const response = await GET(
      request({ baseSha: "short", headSha: "" }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getDiff).not.toHaveBeenCalled();
  });

  it("returns not found for a scoped Branch or selected-PR miss", async () => {
    mocks.getDiff.mockResolvedValueOnce(null);
    const response = await GET(request(), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Branch not found",
    });
  });

  it("advertises the typed acquisition retry delay", async () => {
    mocks.getDiff.mockResolvedValueOnce(acquisitionUnavailableResponse());
    const response = await GET(request(), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: acquisitionUnavailableResponse(),
    });
  });

  it("returns the generic route failure for an unexpected service error", async () => {
    mocks.getDiff.mockRejectedValueOnce(new Error("unexpected failure"));
    const response = await GET(request(), routeContext());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to fetch selected pull request diff",
    });
  });

  it("settles caller cancellation without reporting an auth or API failure", async () => {
    const controller = new AbortController();
    const cancelledRequest = request({}, controller.signal);
    const cancellation = new DOMException("cancelled", "AbortError");
    mocks.getDiff.mockRejectedValueOnce(cancellation);
    controller.abort(cancellation);

    const response = await GET(cancelledRequest, routeContext());

    expect(response.status).toBe(499);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request cancelled",
    });
  });
});

function request(
  overrides: { baseSha?: string; headSha?: string } = {},
  signal?: AbortSignal
) {
  const params = new URLSearchParams({
    repositoryFullName: "ClosedLoop-AI/Symphony-Alpha",
    pullRequestNumber: "4471",
    path: "apps/api/a file.ts",
    baseSha: overrides.baseSha ?? BASE_SHA.toUpperCase(),
    headSha: overrides.headSha ?? HEAD_SHA.toUpperCase(),
  });
  return new NextRequest(
    `https://api.example.test/branches/${BRANCH_ID}/selected-pull-request/diff?${params.toString()}`,
    { method: "GET", signal }
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: BRANCH_ID }) };
}

function staleResponse() {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Evidence,
    reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
  };
}

function acquisitionUnavailableResponse() {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Acquisition,
    reason:
      BranchSelectedPullRequestAcquisitionUnavailableReason.BudgetExhausted,
    retryAfterSeconds: 2,
  };
}
