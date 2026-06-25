import {
  BranchViewLocalErrorCode,
  BranchViewLocalGatewayPath,
} from "@repo/api/src/types/branch-view-local";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analytics: { isFeatureEnabled: vi.fn() },
  computeTargetsService: { findAccessibleById: vi.fn() },
  resolvePrContext: vi.fn(),
  usersService: { findById: vi.fn() },
}));

vi.mock("server-only", () => ({}));

vi.mock("@repo/analytics/server", () => ({
  analytics: mocks.analytics,
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: mocks.computeTargetsService,
}));

vi.mock("@/app/users/service", () => ({
  usersService: mocks.usersService,
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  resolvePrContext: mocks.resolvePrContext,
}));

import { validateBranchViewLocalAccess } from "@/lib/branch-view-local-authorization";

describe("validateBranchViewLocalAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analytics.isFeatureEnabled.mockResolvedValue(true);
    mocks.usersService.findById.mockResolvedValue({
      id: "user-1",
      active: true,
      githubUsername: "octocat",
    });
  });

  it("returns StaleProof without metadata or compute-target lookup when default resolver fails", async () => {
    mocks.resolvePrContext.mockResolvedValueOnce(null);

    const result = await validateBranchViewLocalAccess({
      userId: "user-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      externalLinkId: "branch-artifact-1",
      repoFullName: "acme/repo",
      headBranch: "feature/stale",
      prNumber: 42,
      operationPath: BranchViewLocalGatewayPath.CommitPush,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      code: BranchViewLocalErrorCode.StaleProof,
      error: BranchViewLocalErrorCode.StaleProof,
    });
    expect(mocks.resolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1"
    );
    expect(
      mocks.computeTargetsService.findAccessibleById
    ).not.toHaveBeenCalled();
    expect("metadataHeaders" in result).toBe(false);
  });
});
