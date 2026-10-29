import { beforeEach, describe, expect, it, vi } from "vitest";

const eligibilityMocks = vi.hoisted(() => ({ findByIds: vi.fn() }));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("./branch-product-eligibility-service", () => ({
  branchProductEligibilityService: eligibilityMocks,
}));

import { BranchCompatibilityOutcome } from "@repo/api/src/types/branch-compatibility";
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { ArtifactType } from "@repo/database";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { branchCompatibilityResolver } from "./branch-compatibility-resolver";

const organizationId = "11111111-1111-7111-8111-111111111111";
const branchArtifactId = "22222222-2222-7222-8222-222222222222";

describe("branchCompatibilityResolver", () => {
  const findFirst = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDbCall({ artifact: { findFirst } });
  });

  it("returns an eligible decision with a safe persisted PR URL", async () => {
    findFirst.mockResolvedValue(
      branchRow("https://github.com/ACME/repo/pull/42")
    );
    eligibilityMocks.findByIds.mockResolvedValue(
      new Map([[branchArtifactId, BranchProductEligibility.Eligible]])
    );

    await expect(
      branchCompatibilityResolver.resolve(organizationId, branchArtifactId)
    ).resolves.toEqual({
      branchArtifactId,
      outcome: BranchCompatibilityOutcome.Eligible,
      providerUrl: "https://github.com/ACME/repo/pull/42",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branch: { deletedAt: null },
          id: branchArtifactId,
          organizationId,
          type: ArtifactType.BRANCH,
        },
      })
    );
  });

  it("makes missing and ineligible rows indistinguishably unavailable", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(branchRow(null));
    eligibilityMocks.findByIds.mockResolvedValue(
      new Map([[branchArtifactId, BranchProductEligibility.Ineligible]])
    );

    const missing = await branchCompatibilityResolver.resolve(
      organizationId,
      branchArtifactId
    );
    const ineligible = await branchCompatibilityResolver.resolve(
      organizationId,
      branchArtifactId
    );

    expect(missing).toEqual({
      outcome: BranchCompatibilityOutcome.Unavailable,
    });
    expect(ineligible).toEqual({
      outcome: BranchCompatibilityOutcome.Unavailable,
    });
  });

  it("makes an invalid artifact id unavailable without querying persistence", async () => {
    await expect(
      branchCompatibilityResolver.resolve(organizationId, "not-a-uuid")
    ).resolves.toEqual({
      outcome: BranchCompatibilityOutcome.Unavailable,
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(eligibilityMocks.findByIds).not.toHaveBeenCalled();
  });

  it("omits an unsafe provider URL from an eligible decision", async () => {
    findFirst.mockResolvedValue(
      branchRow("https://example.com/acme/repo/pull/42")
    );
    eligibilityMocks.findByIds.mockResolvedValue(
      new Map([[branchArtifactId, BranchProductEligibility.Eligible]])
    );

    await expect(
      branchCompatibilityResolver.resolve(organizationId, branchArtifactId)
    ).resolves.toEqual({
      branchArtifactId,
      outcome: BranchCompatibilityOutcome.Eligible,
    });
  });

  it.each([
    {
      label: "repository identity differs",
      url: "https://github.com/acme/other/pull/42",
    },
    {
      label: "pull request number differs",
      url: "https://github.com/acme/repo/pull/43",
    },
  ])("omits a provider URL when the selected $label", async ({ url }) => {
    findFirst.mockResolvedValue(branchRow(url));
    eligibilityMocks.findByIds.mockResolvedValue(
      new Map([[branchArtifactId, BranchProductEligibility.Eligible]])
    );

    await expect(
      branchCompatibilityResolver.resolve(organizationId, branchArtifactId)
    ).resolves.toEqual({
      branchArtifactId,
      outcome: BranchCompatibilityOutcome.Eligible,
    });
  });
});

function branchRow(htmlUrl: string | null) {
  return {
    id: branchArtifactId,
    branch: {
      currentPullRequestDetail: {
        htmlUrl,
        number: 42,
        repositoryFullName: "acme/repo",
      },
    },
  };
}
