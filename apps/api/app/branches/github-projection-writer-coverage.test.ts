vi.mock("./branch-detail-signal", () => ({ emitBranchDetailChanged: vi.fn() }));

import { GitHubPRState } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitBranchDetailChanged } from "./branch-detail-signal";
import type {
  BranchPullRequestProjectionInput,
  ExistingBranchPullRequestProjectionTarget,
} from "./github-projection-writer";
import {
  buildPullRequestDetailUpdate,
  writeExistingBranchPullRequestProjection,
} from "./github-projection-writer";

// ISS-9713 branch coverage for the internal association/CAS machinery behind
// `writeExistingBranchPullRequestProjection` — the stale-projection short
// circuit, the ownership/pointer integrity throws, and the repo-less create
// guard. github-projection-writer.test.ts already covers the primary
// full-write and pointer-only paths; this file targets the branches that
// suite never reaches.

const {
  invalidateBranchStatusChecksForHeadChangeMock,
  lockPullRequestActivityIdentityInTransactionMock,
  relinkPullRequestBranchInTransactionMock,
} = vi.hoisted(() => ({
  invalidateBranchStatusChecksForHeadChangeMock: vi.fn(),
  lockPullRequestActivityIdentityInTransactionMock: vi.fn(),
  relinkPullRequestBranchInTransactionMock: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange:
    invalidateBranchStatusChecksForHeadChangeMock,
}));

vi.mock("./pull-request-branch-relink", () => ({
  lockPullRequestActivityIdentityInTransaction:
    lockPullRequestActivityIdentityInTransactionMock,
  relinkPullRequestBranchInTransaction:
    relinkPullRequestBranchInTransactionMock,
}));

const dbMock = {
  $executeRaw: vi.fn(),
  branchDetail: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  pullRequestDetail: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  repositoryDefaultObservationReceipt: { createMany: vi.fn() },
};

function transactionClient() {
  return dbMock as unknown as Parameters<
    typeof writeExistingBranchPullRequestProjection
  >[0];
}

function target(
  overrides: Partial<ExistingBranchPullRequestProjectionTarget> = {}
): ExistingBranchPullRequestProjectionTarget {
  return {
    branchArtifactId: "branch-artifact-1",
    currentHeadSha: "old-sha",
    ...overrides,
  };
}

function pullRequestInput(
  overrides: Partial<BranchPullRequestProjectionInput> = {}
): BranchPullRequestProjectionInput {
  return {
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "acme/app",
    githubId: "github-pr-123",
    number: 123,
    title: "Coverage PR",
    htmlUrl: "https://github.com/acme/app/pull/123",
    headBranch: "feature/shared",
    baseBranch: "main",
    headSha: "new-sha",
    prState: GitHubPRState.Open,
    isDraft: false,
    ...overrides,
  };
}

function canonicalIdentityRow() {
  return {
    id: "pr-existing",
    branchArtifactId: "branch-artifact-1",
    githubId: "github-pr-123",
    repositoryId: "repo-1",
    repositoryFullName: "acme/app",
    number: 123,
  };
}

describe("writeExistingBranchPullRequestProjection internals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      headSha: "old-sha",
    });
    dbMock.branchDetail.updateMany.mockResolvedValue({ count: 1 });
    dbMock.pullRequestDetail.findMany.mockResolvedValue([]);
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    dbMock.pullRequestDetail.upsert.mockResolvedValue({ id: "pr-upserted" });
    dbMock.repositoryDefaultObservationReceipt.createMany.mockResolvedValue({
      count: 0,
    });
    dbMock.$executeRaw.mockResolvedValue(1);
    invalidateBranchStatusChecksForHeadChangeMock.mockResolvedValue(undefined);
    lockPullRequestActivityIdentityInTransactionMock.mockResolvedValue(
      undefined
    );
    relinkPullRequestBranchInTransactionMock.mockResolvedValue(true);
  });

  it("returns the existing PR id without writing when the incoming observation is older than the stored one", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    dbMock.pullRequestDetail.findFirst.mockResolvedValueOnce({
      id: "pr-existing",
      branchArtifactId: "branch-artifact-1",
      githubUpdatedAt: new Date("2026-02-01T00:00:00.000Z"),
      headRefName: "feature/old",
    });

    const result = await writeExistingBranchPullRequestProjection(
      transactionClient(),
      target(),
      pullRequestInput({
        githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    );

    expect(result).toEqual({ id: "pr-existing" });
    // The stale short-circuit skips the branch/PR write entirely — only
    // reconcile's own provider-identity adoption call touches branchDetail.
    expect(dbMock.branchDetail.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchName: expect.anything() }),
      })
    );
    expect(
      invalidateBranchStatusChecksForHeadChangeMock
    ).not.toHaveBeenCalled();
  });

  it("treats an equal-timestamp observation carrying a different head-ref name as stale", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    dbMock.pullRequestDetail.findFirst.mockResolvedValueOnce({
      id: "pr-existing",
      branchArtifactId: "branch-artifact-1",
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      headRefName: "feature/renamed-upstream",
    });

    const result = await writeExistingBranchPullRequestProjection(
      transactionClient(),
      target(),
      pullRequestInput({
        headBranch: "feature/shared",
        githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    );

    expect(result).toEqual({ id: "pr-existing" });
    expect(dbMock.branchDetail.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchName: expect.anything() }),
      })
    );
  });

  it("is NOT stale for an equal-timestamp observation with no stored head-ref name, and proceeds to write", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    dbMock.pullRequestDetail.findFirst
      .mockResolvedValueOnce({
        id: "pr-existing",
        branchArtifactId: "branch-artifact-1",
        githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
        headRefName: null,
      })
      .mockResolvedValueOnce({ id: "pr-existing" });

    const result = await writeExistingBranchPullRequestProjection(
      transactionClient(),
      target(),
      pullRequestInput({
        githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    );

    // Not stale, so the update-by-id path runs and returns the same id.
    expect(result).toEqual({ id: "pr-existing" });
    expect(dbMock.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchName: "feature/shared" }),
      })
    );
  });

  it("rejects an incoming githubUpdatedAt more than 24h ahead of the trusted clock", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    dbMock.pullRequestDetail.findFirst.mockResolvedValueOnce({
      id: "pr-existing",
      branchArtifactId: "branch-artifact-1",
      githubUpdatedAt: null,
      headRefName: null,
    });

    const farFuture = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput({ githubUpdatedAt: farFuture })
      )
    ).rejects.toThrow("pull request projection timestamp is not trustworthy");
  });

  it("falls back to null headSha/headShaSource and skips the invalidation call when headSha is omitted and unchanged", async () => {
    dbMock.branchDetail.findFirst.mockResolvedValueOnce({
      artifactId: "branch-artifact-1",
      headSha: null,
    });
    dbMock.pullRequestDetail.findFirst.mockResolvedValue({
      id: "pr-upserted",
    });

    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      target(),
      pullRequestInput({ headSha: undefined })
    );

    expect(dbMock.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headSha: null,
          headShaSource: null,
        }),
      })
    );
    // currentHeadSha (null) matches input.headSha ?? null (also null), so the
    // head genuinely did not change and status checks are left alone.
    expect(
      invalidateBranchStatusChecksForHeadChangeMock
    ).not.toHaveBeenCalled();
  });

  it("relinks the PR to the target branch when it is currently owned by a different branch and is not stale", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    dbMock.pullRequestDetail.findFirst
      .mockResolvedValueOnce({
        id: "pr-existing",
        branchArtifactId: "other-branch-artifact",
        githubUpdatedAt: null,
        headRefName: null,
      })
      .mockResolvedValueOnce({ id: "pr-existing" });

    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      target(),
      pullRequestInput()
    );

    expect(relinkPullRequestBranchInTransactionMock).toHaveBeenCalledWith(
      dbMock,
      {
        organizationId: "org-1",
        pullRequestDetailId: "pr-existing",
        branchArtifactId: "branch-artifact-1",
        repositoryFullName: "acme/app",
        pullRequestNumber: 123,
      }
    );
    expect(emitBranchDetailChanged).toHaveBeenCalledTimes(2);
    expect(emitBranchDetailChanged).toHaveBeenCalledWith(
      dbMock,
      "org-1",
      "branch-artifact-1"
    );
    expect(emitBranchDetailChanged).toHaveBeenCalledWith(
      dbMock,
      "org-1",
      "other-branch-artifact"
    );
  });

  it("throws when the branch update-by-artifactId touches no row", async () => {
    dbMock.branchDetail.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput()
      )
    ).rejects.toThrow("pull request projection target Branch changed");
  });

  it("throws when the final ownership check finds no row for the written PR detail", async () => {
    // Create path (no existing identity row): pullRequestDetailId resolves to
    // null, so the upsert create/update branch runs, and the ONLY
    // pullRequestDetail.findFirst call left is the trailing ownership check —
    // which returns null by the shared beforeEach default.
    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput()
      )
    ).rejects.toThrow("pull request projection Branch ownership changed");
  });

  it("throws when the current-pointer update touches no row", async () => {
    dbMock.pullRequestDetail.findFirst.mockResolvedValue({
      id: "pr-upserted",
    });
    dbMock.branchDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput()
      )
    ).rejects.toThrow("pull request projection current pointer changed");
  });

  it("throws when the target Branch artifact cannot be found", async () => {
    dbMock.branchDetail.findFirst.mockResolvedValue(null);

    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput()
      )
    ).rejects.toThrow("pull request projection target Branch was not found");
  });

  it("throws when the resolved identity row disappears before the current-state read", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    // findFirst default (null) stands in for the "current" lookup here.

    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput()
      )
    ).rejects.toThrow("pull request projection identity disappeared");
  });

  it("throws when the update-by-id write touches no row", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      canonicalIdentityRow(),
    ]);
    dbMock.pullRequestDetail.findFirst.mockResolvedValueOnce({
      id: "pr-existing",
      branchArtifactId: "branch-artifact-1",
      githubUpdatedAt: null,
      headRefName: null,
    });
    dbMock.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 }) // reconcile's provider-identity adoption
      .mockResolvedValueOnce({ count: 0 }); // the update-by-id write itself

    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput()
      )
    ).rejects.toThrow("pull request projection row changed");
  });

  it("refuses to create a repo-less PR detail row when no existing identity resolves", async () => {
    await expect(
      writeExistingBranchPullRequestProjection(
        transactionClient(),
        target(),
        pullRequestInput({ repositoryId: null })
      )
    ).rejects.toThrow(
      "upsertPullRequestDetailForBranch requires a repositoryId; a repo-less row must update by pullRequestDetailId"
    );
  });
});

describe("buildPullRequestDetailUpdate omission-preserving fields", () => {
  it("omits closedAt, mergedAt, and mergeCommitSha entirely when the caller does not supply them", () => {
    const input = pullRequestInput();

    const update = buildPullRequestDetailUpdate(input);

    expect(update).not.toHaveProperty("closedAt");
    expect(update).not.toHaveProperty("mergedAt");
    expect(update).not.toHaveProperty("mergeCommitSha");
  });
});
