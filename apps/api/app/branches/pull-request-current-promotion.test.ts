import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPullRequestCurrentOwnerChangedError,
  PULL_REQUEST_CURRENT_OWNER_CHANGED_MESSAGE,
  promoteBranchCurrentPullRequest,
} from "./pull-request-current-promotion";

const branchFindUnique = vi.fn();
const branchUpdateMany = vi.fn();
const pullRequestFindFirst = vi.fn();
const pullRequestUpdateMany = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  branchFindUnique.mockResolvedValue({ currentPullRequestDetailId: null });
  branchUpdateMany.mockResolvedValue({ count: 1 });
  pullRequestFindFirst.mockResolvedValue(null);
  pullRequestUpdateMany.mockResolvedValue({ count: 1 });
});

describe("promoteBranchCurrentPullRequest", () => {
  it("promotes a PR and repoints the branch when no provider current row wins", async () => {
    const promoted = await promoteBranchCurrentPullRequest(db(), {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
    });

    expect(promoted).toBe(true);
    expect(branchUpdateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-1",
        organizationId: "org-1",
        currentPullRequestDetailId: null,
      },
      data: { currentPullRequestDetailId: "pr-1" },
    });
    expect(pullRequestUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "pr-1",
        organizationId: "org-1",
        branchArtifactId: "branch-1",
      },
      data: { isCurrent: true },
    });
    expect(pullRequestUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        isCurrent: true,
        id: { not: "pr-1" },
      },
      data: { isCurrent: false },
    });
  });

  it("preserves legacy App-authored current rows that only carry githubId", async () => {
    branchFindUnique.mockResolvedValue({
      currentPullRequestDetailId: "app-pr",
    });
    pullRequestFindFirst.mockResolvedValue({
      fetchMechanism: null,
      githubId: "PR_node",
      additions: null,
      deletions: null,
      changedFiles: null,
    });

    const promoted = await promoteBranchCurrentPullRequest(db(), {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "desktop-pr",
    });

    expect(promoted).toBe(false);
    expect(pullRequestUpdateMany).not.toHaveBeenCalled();
    expect(branchUpdateMany).not.toHaveBeenCalled();
  });

  it("returns false when a concurrent writer changes the branch pointer after the guard read", async () => {
    branchFindUnique.mockResolvedValue({
      currentPullRequestDetailId: "stub-pr",
    });
    branchUpdateMany.mockResolvedValue({ count: 0 });
    pullRequestFindFirst.mockResolvedValue({
      fetchMechanism: null,
      githubId: null,
      additions: null,
      deletions: null,
      changedFiles: null,
    });

    const promoted = await promoteBranchCurrentPullRequest(
      db(),
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "verified-pr",
      },
      { onlyWhenCurrentMissingOrStub: true }
    );

    expect(promoted).toBe(false);
    expect(branchUpdateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-1",
        organizationId: "org-1",
        currentPullRequestDetailId: "stub-pr",
      },
      data: { currentPullRequestDetailId: "verified-pr" },
    });
    expect(pullRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("strict targeted mode refuses to displace a non-empty current row", async () => {
    branchFindUnique.mockResolvedValue({
      currentPullRequestDetailId: "other-pr",
    });
    pullRequestFindFirst.mockResolvedValue({
      fetchMechanism: null,
      githubId: null,
      additions: 10,
      deletions: null,
      changedFiles: null,
    });

    const promoted = await promoteBranchCurrentPullRequest(
      db(),
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "verified-pr",
      },
      { onlyWhenCurrentMissingOrStub: true }
    );

    expect(promoted).toBe(false);
    expect(pullRequestUpdateMany).not.toHaveBeenCalled();
    expect(branchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to displace a githubId-bearing row whatever mechanism last wrote it", async () => {
    // ISS-8522: the exact input where this gate's old predicate and the desktop
    // gate's disagreed. `githubId` is provider-written and never cleared, so a
    // non-App mechanism on top of it does not make the row promotable away.
    branchFindUnique.mockResolvedValue({
      currentPullRequestDetailId: "app-pr-restamped",
    });
    pullRequestFindFirst.mockResolvedValue({
      fetchMechanism: GitHubFetchMechanism.DesktopSync,
      githubId: "PR_kwDO",
      additions: null,
      deletions: null,
      changedFiles: null,
    });

    const promoted = await promoteBranchCurrentPullRequest(db(), {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "desktop-pr",
    });

    expect(promoted).toBe(false);
    expect(pullRequestUpdateMany).not.toHaveBeenCalled();
    expect(branchUpdateMany).not.toHaveBeenCalled();
  });

  it("strict targeted mode refuses to displace a desktop current row with no LOC yet", async () => {
    branchFindUnique.mockResolvedValue({
      currentPullRequestDetailId: "desktop-pr",
    });
    pullRequestFindFirst.mockResolvedValue({
      fetchMechanism: GitHubFetchMechanism.DesktopSync,
      githubId: null,
      additions: null,
      deletions: null,
      changedFiles: null,
    });

    const promoted = await promoteBranchCurrentPullRequest(
      db(),
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "older-verified-pr",
      },
      { onlyWhenCurrentMissingOrStub: true }
    );

    expect(promoted).toBe(false);
    expect(pullRequestUpdateMany).not.toHaveBeenCalled();
    expect(branchUpdateMany).not.toHaveBeenCalled();
  });

  it("strict targeted mode may promote over an empty non-App stub", async () => {
    branchFindUnique.mockResolvedValue({
      currentPullRequestDetailId: "stub-pr",
    });
    pullRequestFindFirst.mockResolvedValue({
      fetchMechanism: null,
      githubId: null,
      additions: null,
      deletions: null,
      changedFiles: null,
    });

    const promoted = await promoteBranchCurrentPullRequest(
      db(),
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "verified-pr",
      },
      { onlyWhenCurrentMissingOrStub: true }
    );

    expect(promoted).toBe(true);
    expect(branchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentPullRequestDetailId: "stub-pr",
        }),
        data: { currentPullRequestDetailId: "verified-pr" },
      })
    );
  });

  it("classifies stale target ownership errors for targeted reconciliation", () => {
    expect(
      isPullRequestCurrentOwnerChangedError(
        new Error(PULL_REQUEST_CURRENT_OWNER_CHANGED_MESSAGE)
      )
    ).toBe(true);
    expect(
      isPullRequestCurrentOwnerChangedError(new Error("database down"))
    ).toBe(false);
  });
});

function db(): TransactionClient {
  return {
    branchDetail: {
      findUnique: branchFindUnique,
      updateMany: branchUpdateMany,
    },
    pullRequestDetail: {
      findFirst: pullRequestFindFirst,
      updateMany: pullRequestUpdateMany,
    },
  } as unknown as TransactionClient;
}
