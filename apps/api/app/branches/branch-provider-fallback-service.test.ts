import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

import { log } from "@repo/observability/log";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import {
  branchProviderFallbackService,
  matchingGitHubPullRequestUrl,
} from "./branch-provider-fallback-service";

const organizationId = "11111111-1111-7111-8111-111111111111";

describe("branchProviderFallbackService.findByIds", () => {
  const findMany = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
    mockWithDbCall({ artifact: { findMany } });
  });

  it("returns only Branch ids with matching persisted provider identity", async () => {
    findMany.mockResolvedValue([
      branchRow("branch-1", "https://github.com/acme/repo/pull/42"),
      branchRow("branch-2", "https://github.com/acme/other/pull/42"),
      branchRow("branch-3", null),
    ]);

    await expect(
      branchProviderFallbackService.findByIds(organizationId, [
        "branch-1",
        "branch-2",
        "branch-3",
        "branch-1",
      ])
    ).resolves.toEqual(new Set(["branch-1"]));
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("uses fixed sequential batches instead of per-row reads", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `branch-${index}`);

    await branchProviderFallbackService.findByIds(organizationId, ids);

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("fails closed without retaining a partial batch", async () => {
    findMany
      .mockResolvedValueOnce([
        branchRow("branch-0", "https://github.com/acme/repo/pull/42"),
      ])
      .mockRejectedValueOnce(new Error("fallback unavailable"));
    const ids = Array.from({ length: 501 }, (_, index) => `branch-${index}`);

    await expect(
      branchProviderFallbackService.findByIds(organizationId, ids)
    ).resolves.toEqual(new Set());
    expect(log.warn).toHaveBeenCalledWith("telemetry.enrichment_failed", {
      enrichmentKind: "branch_provider_fallback",
      errorClass: "Error",
      requestedBranchCount: 501,
    });
  });
});

describe("matchingGitHubPullRequestUrl", () => {
  it("rejects malformed and mismatched provider identities", () => {
    expect(
      matchingGitHubPullRequestUrl({
        htmlUrl: "https://example.com/acme/repo/pull/42",
        number: 42,
        repositoryFullName: "acme/repo",
      })
    ).toBeNull();
    expect(
      matchingGitHubPullRequestUrl({
        htmlUrl: "https://github.com/acme/repo/pull/43",
        number: 42,
        repositoryFullName: "acme/repo",
      })
    ).toBeNull();
  });
});

function branchRow(id: string, htmlUrl: string | null) {
  return {
    id,
    branch: {
      currentPullRequestDetail: {
        htmlUrl,
        number: 42,
        repositoryFullName: "acme/repo",
      },
    },
  };
}
