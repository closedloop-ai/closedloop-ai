import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { describe, expect, it, vi } from "vitest";
import { reconcilePullRequestProviderIdentityInTransaction } from "./pull-request-provider-identity";

const ORGANIZATION_ID = "019ff900-3000-7000-8000-000000000001";
const LEGACY_ID = "019ff900-3000-7000-8000-000000000002";
const PROVIDER_ID = "019ff900-3000-7000-8000-000000000004";
const BRANCH_ID = "019ff900-3000-7000-8000-000000000009";

describe("pull request provider identity convergence", () => {
  it("adopts a repository-less row regardless of its old Branch", async () => {
    const tx = createClient([
      {
        id: LEGACY_ID,
        branchArtifactId: "019ff900-3000-7000-8000-000000000009",
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(LEGACY_ID);

    expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: LEGACY_ID,
        organizationId: ORGANIZATION_ID,
        number: 6980,
        repositoryId: null,
        githubId: null,
      },
      data: {
        repositoryId: "repository-1",
        githubId: "github-pr-6980",
        repositoryFullName: "closedloop-ai/closedloop-ai",
      },
    });
    expect(tx.pullRequestDetail.deleteMany).not.toHaveBeenCalled();
  });

  it("stamps a null GitHub id on the existing repository-owned row", async () => {
    const tx = createClient([
      {
        id: PROVIDER_ID,
        branchArtifactId: BRANCH_ID,
        githubId: null,
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(PROVIDER_ID);

    expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: PROVIDER_ID,
        organizationId: ORGANIZATION_ID,
        number: 6980,
        repositoryId: "repository-1",
        githubId: null,
      },
      data: {
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        githubId: "github-pr-6980",
      },
    });
    expect(tx.pullRequestDetail.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when a stored non-null GitHub coordinate conflicts", async () => {
    const tx = createClient([
      {
        id: LEGACY_ID,
        branchArtifactId: "019ff900-3000-7000-8000-000000000009",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
        githubId: "different-github-pr",
        repositoryId: "repository-1",
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).rejects.toThrow("provider identity conflict");
    expect(tx.pullRequestDetail.updateMany).not.toHaveBeenCalled();
  });

  it("moves dependent evidence before deleting an exact duplicate authority row", async () => {
    const tx = createClient([
      {
        id: PROVIDER_ID,
        branchArtifactId: BRANCH_ID,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: LEGACY_ID,
        branchArtifactId: BRANCH_ID,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.gitHubPRReview.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "review-1",
        githubReviewId: "6980001",
        authorLogin: "reviewer",
        state: ReviewDecision.Approved,
        body: null,
        htmlUrl:
          "https://github.com/closedloop-ai/closedloop-ai/pull/6980#review",
        submittedAt: new Date("2026-08-17T20:00:00.000Z"),
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(PROVIDER_ID);

    expect(tx.branchActivityAtom.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        pullRequestDetailId: LEGACY_ID,
      },
      data: { pullRequestDetailId: PROVIDER_ID },
    });
    expect(tx.gitHubPRReview.updateMany).toHaveBeenCalledWith({
      where: {
        id: "review-1",
        pullRequestId: LEGACY_ID,
        pullRequestDetail: { organizationId: ORGANIZATION_ID },
      },
      data: { pullRequestId: PROVIDER_ID },
    });
    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        currentPullRequestDetailId: LEGACY_ID,
      },
      data: { currentPullRequestDetailId: null },
    });
    expect(tx.gitHubCommentThreadProjection.findMany).toHaveBeenCalledTimes(2);
    expect(tx.pullRequestDetail.deleteMany).toHaveBeenCalledWith({
      where: { id: LEGACY_ID, organizationId: ORGANIZATION_ID },
    });
  });
});

function input() {
  return {
    organizationId: ORGANIZATION_ID,
    repositoryId: "repository-1",
    repositoryFullName: "ClosedLoop-AI/ClosedLoop-AI.git",
    githubId: "github-pr-6980",
    number: 6980,
  };
}

function createClient(rows: readonly Record<string, unknown>[]) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchActivityAtom: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    branchDetail: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    commentThread: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    gitHubCommentProjection: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubCommentThreadProjection: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    gitHubPRReview: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    artifactLink: {
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  };
}
