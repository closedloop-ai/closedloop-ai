import {
  BranchSelectedPullRequestAcquisitionUnavailableReason,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getFiles: vi.fn(),
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
    getFiles: mocks.getFiles,
  },
}));

import { GET } from "./route";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]/selected-pull-request/files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.getFiles.mockResolvedValue(unavailableResponse());
  });

  it("requires read scope and forwards canonical selected-PR identity", async () => {
    const selectedRequest = request(
      "repositoryFullName=%2FClosedLoop-AI%2FSymphony-Alpha.git%2F&pullRequestNumber=4471"
    );
    const response = await GET(selectedRequest, routeContext());

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getFiles).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      BRANCH_ID,
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 4471,
      },
      selectedRequest.signal
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: unavailableResponse(),
    });
  });

  it("rejects invalid or unsupported query fields before service work", async () => {
    const response = await GET(
      request("repositoryFullName=owner%2Frepo&pullRequestNumber=0&extra=true"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getFiles).not.toHaveBeenCalled();
  });

  it("returns not found for a scoped Branch or selected-PR miss", async () => {
    mocks.getFiles.mockResolvedValueOnce(null);
    const response = await GET(
      request("repositoryFullName=owner%2Frepo&pullRequestNumber=1"),
      routeContext()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Branch not found",
    });
  });

  it("advertises the typed acquisition retry delay", async () => {
    mocks.getFiles.mockResolvedValueOnce(acquisitionUnavailableResponse());
    const response = await GET(
      request("repositoryFullName=owner%2Frepo&pullRequestNumber=1"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: acquisitionUnavailableResponse(),
    });
  });

  it("returns the generic route failure for an unexpected service error", async () => {
    mocks.getFiles.mockRejectedValueOnce(new Error("unexpected failure"));
    const response = await GET(
      request("repositoryFullName=owner%2Frepo&pullRequestNumber=1"),
      routeContext()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to fetch selected pull request files",
    });
  });

  it("settles caller cancellation without reporting an auth or API failure", async () => {
    const controller = new AbortController();
    const cancelledRequest = request(
      "repositoryFullName=owner%2Frepo&pullRequestNumber=1",
      controller.signal
    );
    const cancellation = new DOMException("cancelled", "AbortError");
    mocks.getFiles.mockRejectedValueOnce(cancellation);
    controller.abort(cancellation);

    const response = await GET(cancelledRequest, routeContext());

    expect(response.status).toBe(499);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request cancelled",
    });
  });
});

function request(query: string, signal?: AbortSignal) {
  return new NextRequest(
    `https://api.example.test/branches/${BRANCH_ID}/selected-pull-request/files?${query}`,
    { method: "GET", signal }
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: BRANCH_ID }) };
}

function unavailableResponse() {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Access,
    reason: GitHubAccessDenialReason.NotConnected,
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
