import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptRepolessPullRequestDetail,
  BranchProjectionMode,
  writeExistingBranchPullRequestProjection,
} from "./github-projection-writer";

const { invalidateBranchStatusChecksForHeadChangeMock } = vi.hoisted(() => ({
  invalidateBranchStatusChecksForHeadChangeMock: vi.fn(),
}));

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange:
    invalidateBranchStatusChecksForHeadChangeMock,
}));

const dbMock = {
  branchDetail: {
    update: vi.fn(),
  },
  pullRequestDetail: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
};

describe("writeExistingBranchPullRequestProjection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);
    dbMock.pullRequestDetail.update.mockResolvedValue({});
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
    dbMock.pullRequestDetail.upsert.mockResolvedValue({ id: "pr-detail-1" });
    dbMock.branchDetail.update.mockResolvedValue({});
    invalidateBranchStatusChecksForHeadChangeMock.mockResolvedValue(undefined);
  });

  it("writes the full branch projection and current PR pointer", async () => {
    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      {
        branchArtifactId: "branch-artifact-1",
        currentHeadSha: "old-sha",
      },
      pullRequestInput()
    );

    expect(dbMock.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: expect.objectContaining({
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        branchName: "feature/shared",
        headSha: "new-sha",
        headShaSource: BranchHeadShaSource.PullRequestWebhook,
      }),
    });
    expect(invalidateBranchStatusChecksForHeadChangeMock).toHaveBeenCalledWith(
      dbMock,
      "branch-artifact-1"
    );
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
        id: { not: "pr-detail-1" },
      },
      data: { isCurrent: false },
    });
    expect(dbMock.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: { currentPullRequestDetailId: "pr-detail-1" },
    });
  });

  it("can update only the PR detail and branch pointer for synchronize ownership", async () => {
    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      {
        branchArtifactId: "branch-artifact-1",
        branchProjectionMode: BranchProjectionMode.PointerOnly,
        currentHeadSha: "old-sha",
        pullRequestDetailId: "pr-detail-1",
      },
      pullRequestInput()
    );

    expect(dbMock.pullRequestDetail.update).toHaveBeenCalledWith({
      where: { id: "pr-detail-1" },
      data: expect.objectContaining({
        additions: 44,
        deletions: 6,
        changedFiles: 3,
        htmlUrl: "https://github.com/acme/app/pull/123",
        isCurrent: true,
        title: "Shared writer",
      }),
    });
    expect(
      invalidateBranchStatusChecksForHeadChangeMock
    ).not.toHaveBeenCalled();
    expect(dbMock.branchDetail.update).toHaveBeenCalledTimes(1);
    expect(dbMock.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: { currentPullRequestDetailId: "pr-detail-1" },
    });
  });
});

describe("adoptRepolessPullRequestDetail (FEA-3212)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);
    dbMock.pullRequestDetail.update.mockResolvedValue({});
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
  });

  it("adopts exactly one row when two githubId=null rows share (branchArtifactId, number), avoiding a P2002 stamp on both", async () => {
    // Two repo-less rows for the same branch+number both have githubId=null
    // (writer-discipline dedup is not a DB constraint). findFirst returns the
    // single deterministic target; only that row is stamped.
    dbMock.pullRequestDetail.findFirst.mockResolvedValue({ id: "pr-row-a" });
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });

    await adoptRepolessPullRequestDetail(transactionClient(), {
      branchArtifactId: "branch-artifact-1",
      number: 123,
      repositoryId: "repo-1",
      githubId: "github-pr-123",
    });

    expect(dbMock.pullRequestDetail.findFirst).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        number: 123,
        githubId: null,
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    // Atomic compare-and-set scoped to the single chosen id: updateMany where
    // { id, githubId: null } — never a broad { githubId: null } across many rows
    // (which would stamp the same githubId onto both and hit P2002 on
    // github_id), and never a plain update-by-id (which loses the null re-check
    // guard against a concurrent writer stamping the row first).
    expect(dbMock.pullRequestDetail.update).not.toHaveBeenCalled();
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: { id: "pr-row-a", githubId: null },
      data: { repositoryId: "repo-1", githubId: "github-pr-123" },
    });
  });

  it("compare-and-set is a no-op when a concurrent writer already adopted the chosen row (count 0, no clobber)", async () => {
    // findFirst picked pr-row-a while githubId was still null, but another
    // writer stamped it before this write lands. The scoped updateMany matches
    // zero rows (count 0) — no error, no clobber of the winner's githubId.
    dbMock.pullRequestDetail.findFirst.mockResolvedValue({ id: "pr-row-a" });
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      adoptRepolessPullRequestDetail(transactionClient(), {
        branchArtifactId: "branch-artifact-1",
        number: 123,
        repositoryId: "repo-1",
        githubId: "github-pr-123",
      })
    ).resolves.toBeUndefined();

    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: { id: "pr-row-a", githubId: null },
      data: { repositoryId: "repo-1", githubId: "github-pr-123" },
    });
    expect(dbMock.pullRequestDetail.update).not.toHaveBeenCalled();
  });

  it("is a no-op when no repo-less row matches", async () => {
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);

    await adoptRepolessPullRequestDetail(transactionClient(), {
      branchArtifactId: "branch-artifact-1",
      number: 123,
      repositoryId: "repo-1",
      githubId: "github-pr-123",
    });

    expect(dbMock.pullRequestDetail.update).not.toHaveBeenCalled();
    expect(dbMock.pullRequestDetail.updateMany).not.toHaveBeenCalled();
  });
});

function pullRequestInput() {
  return {
    organizationId: "org-1",
    repositoryId: "repo-1",
    githubId: "github-pr-123",
    number: 123,
    title: "Shared writer",
    body: "Body",
    htmlUrl: "https://github.com/acme/app/pull/123",
    headBranch: "feature/shared",
    baseBranch: "main",
    headSha: "new-sha",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 44,
    deletions: 6,
    changedFiles: 3,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
}

function transactionClient() {
  return dbMock as unknown as Parameters<
    typeof writeExistingBranchPullRequestProjection
  >[0];
}
