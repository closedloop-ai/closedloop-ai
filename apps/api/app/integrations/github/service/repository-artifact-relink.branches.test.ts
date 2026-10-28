/**
 * Branch coverage for `runRepositoryArtifactRelink` (ISS-11280), driven
 * directly against a fake transaction client. `service-relink.test.ts` covers
 * the happy path and the guarded-write throws through
 * `githubService.relinkBranchViewRepositoryCredential`; this file pins the
 * arms that entry point never reaches: candidate filtering, ambiguous active
 * identities, current-PR pointer validation and fallback, same-branch PR
 * number collisions, cross-branch/cross-org collisions that block a branch,
 * and the current-pointer ownership miss.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

import { GitHubInstallationStatus } from "@repo/database";
import {
  ACTIVE_REPO_ID,
  activeCandidate,
  BRANCH_ID,
  branchRelinkWrite,
  createRelinkTx,
  GITHUB_REPO_ID,
  INSTALLATION_ID,
  ORG_ID,
  OTHER_ORG_ID,
  relinkResult,
  runRelink,
  STALE_REPO_ID,
  staleBranch,
} from "@/__tests__/support/integrations/github/repository-artifact-relink.test-fixtures";
import {
  RepositoryArtifactRelinkReason,
  RepositoryArtifactRelinkStatus,
} from "./repository-relink-telemetry";

describe("runRepositoryArtifactRelink branch arms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips with no_active_repositories when every candidate lacks an identity field", async () => {
    const tx = createRelinkTx();

    const result = await runRelink([
      activeCandidate({ fullName: "" }),
      activeCandidate({ githubRepoId: "" }),
    ]);

    expect(result).toEqual(
      relinkResult({
        activeRepositoryCount: 0,
        reasons: [RepositoryArtifactRelinkReason.NoActiveRepositories],
      })
    );
    expect(tx.gitHubInstallation.findFirst).not.toHaveBeenCalled();
  });

  it("drops every active candidate that shares a GitHub id, even a third duplicate", async () => {
    const tx = createRelinkTx();

    const result = await runRelink([
      activeCandidate({ id: "repo-a" }),
      activeCandidate({ id: "repo-b" }),
      activeCandidate({ id: "repo-c" }),
    ]);

    // One skip for the duplicate seen in the active list, one for the stale
    // repository whose identity no longer resolves to a single active row.
    // A third duplicate must not re-seed the identity as unambiguous.
    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Partial,
        reasons: [RepositoryArtifactRelinkReason.ActiveRepositoryAmbiguous],
        activeRepositoryCount: 3,
        staleRepositoryCount: 1,
        ambiguousRepositorySkippedCount: 2,
      })
    );
    expect(tx.branchDetail.findMany).not.toHaveBeenCalled();
    expect(tx.gitHubInstallation.findFirst).toHaveBeenCalledWith({
      where: {
        id: INSTALLATION_ID,
        status: GitHubInstallationStatus.ACTIVE,
        organizationId: { not: null },
      },
      select: { organizationId: true, status: true },
    });
  });

  it("scopes the stale read to the installation's org and skips the collision read when no branch is stale", async () => {
    const tx = createRelinkTx({ staleBranches: [] });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(relinkResult({ staleRepositoryCount: 1 }));
    expect(tx.gitHubInstallationRepository.findMany).toHaveBeenCalledWith({
      where: {
        installationId: { not: INSTALLATION_ID },
        githubRepoId: { in: [GITHUB_REPO_ID] },
        branchDetails: {
          some: { artifact: { organizationId: ORG_ID } },
        },
        installation: {
          OR: [
            { organizationId: null },
            { status: { not: GitHubInstallationStatus.ACTIVE } },
          ],
        },
      },
      select: { id: true, githubRepoId: true, fullName: true },
    });
    // Only the stale-branch read: no active-repository collision read runs
    // for an empty branch-name list.
    expect(tx.branchDetail.findMany.mock.calls).toEqual([
      [
        {
          where: {
            repositoryId: STALE_REPO_ID,
            artifact: { organizationId: ORG_ID },
          },
          select: {
            artifactId: true,
            branchName: true,
            currentPullRequestDetailId: true,
          },
        },
      ],
    ]);
  });

  it("adopts the stale row marked current when the branch has no pointer", async () => {
    const tx = createRelinkTx({
      stalePrDetails: [
        { id: "pr-old", isCurrent: false, number: 1 },
        { id: "pr-current", isCurrent: true, number: 2 },
      ],
    });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
        pullRequestRelinkedCount: 2,
      })
    );
    // A null pointer is never validated against the database.
    expect(tx.pullRequestDetail.findFirst).not.toHaveBeenCalled();
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: BRANCH_ID,
        repositoryId: STALE_REPO_ID,
        branchArtifact: { organizationId: ORG_ID },
      },
      select: { id: true, isCurrent: true, number: true },
    });
    expect(tx.pullRequestDetail.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            branchArtifactId: BRANCH_ID,
            isCurrent: true,
            id: { not: "pr-current" },
          },
          data: { isCurrent: false },
        },
      ],
      [
        {
          where: {
            id: "pr-current",
            branchArtifactId: BRANCH_ID,
            branchArtifact: { organizationId: ORG_ID },
            repositoryId: ACTIVE_REPO_ID,
          },
          data: { isCurrent: true },
        },
      ],
    ]);
    expect(tx.pullRequestDetail.update).toHaveBeenCalledWith({
      where: { id: "pr-old" },
      data: { isCurrent: false, repositoryId: ACTIVE_REPO_ID },
      select: { id: true },
    });
    expect(tx.pullRequestDetail.update).toHaveBeenCalledWith({
      where: { id: "pr-current" },
      data: { isCurrent: true, repositoryId: ACTIVE_REPO_ID },
      select: { id: true },
    });
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite("pr-current")],
    ]);
  });

  it("relinks a PR-less branch with a null pointer and no PR reads or pointer writes", async () => {
    const tx = createRelinkTx({ stalePrDetails: [] });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
      })
    );
    // Only the stale-detail read: an empty number list never queries the
    // active repository for collisions.
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledTimes(1);
    expect(tx.pullRequestDetail.updateMany).not.toHaveBeenCalled();
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite(null)],
    ]);
  });

  it("replaces a pointer that no longer belongs to the branch with the stale current row", async () => {
    const tx = createRelinkTx({
      staleBranches: [
        staleBranch({ currentPullRequestDetailId: "pr-foreign" }),
      ],
      validPointerId: null,
      stalePrDetails: [{ id: "pr-current", isCurrent: true, number: 9 }],
    });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
        pullRequestRelinkedCount: 1,
      })
    );
    expect(tx.pullRequestDetail.findFirst).toHaveBeenCalledWith({
      where: {
        id: "pr-foreign",
        branchArtifactId: BRANCH_ID,
        branchArtifact: { organizationId: ORG_ID },
        OR: [{ repositoryId: STALE_REPO_ID }, { repositoryId: ACTIVE_REPO_ID }],
      },
      select: { id: true },
    });
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite("pr-current")],
    ]);
  });

  it("reuses same-branch active PR rows on number collision and moves the pointer onto them", async () => {
    const tx = createRelinkTx({
      staleBranches: [
        staleBranch({ currentPullRequestDetailId: "pr-stale-7" }),
      ],
      validPointerId: "pr-stale-7",
      stalePrDetails: [
        { id: "pr-stale-7", isCurrent: true, number: 7 },
        { id: "pr-stale-8", isCurrent: false, number: 8 },
      ],
      activePrCollisions: [7, 8].map((number) => ({
        id: `pr-active-${number}`,
        number,
        branchArtifactId: BRANCH_ID,
        branchArtifact: { organizationId: ORG_ID },
      })),
    });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Partial,
        reasons: [RepositoryArtifactRelinkReason.PullRequestNumberCollision],
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
        pullRequestCollisionSkippedCount: 2,
      })
    );
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledWith({
      where: { repositoryId: ACTIVE_REPO_ID, number: { in: [7, 8] } },
      select: {
        id: true,
        number: true,
        branchArtifactId: true,
        branchArtifact: { select: { organizationId: true } },
      },
    });
    expect(tx.branchDetail.findMany).toHaveBeenCalledWith({
      where: {
        repositoryId: ACTIVE_REPO_ID,
        branchName: { in: ["feature/relink"] },
      },
      select: { artifactId: true, branchName: true },
    });
    // Colliding stale rows are never moved onto the active repository.
    expect(tx.pullRequestDetail.update).not.toHaveBeenCalled();
    expect(tx.pullRequestDetail.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            branchArtifactId: BRANCH_ID,
            isCurrent: true,
            id: { not: "pr-active-7" },
          },
          data: { isCurrent: false },
        },
      ],
      [
        {
          where: {
            id: "pr-active-7",
            branchArtifactId: BRANCH_ID,
            branchArtifact: { organizationId: ORG_ID },
            repositoryId: ACTIVE_REPO_ID,
          },
          data: { isCurrent: true },
        },
      ],
    ]);
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite("pr-active-7")],
    ]);
  });

  it.each([
    {
      name: "another organization",
      collisionBranchArtifactId: BRANCH_ID,
      collisionOrganizationId: OTHER_ORG_ID,
    },
    {
      name: "another branch in the same organization",
      collisionBranchArtifactId: "branch-artifact-other",
      collisionOrganizationId: ORG_ID,
    },
  ])(
    "blocks the whole branch when an active PR number collision belongs to $name",
    async ({ collisionBranchArtifactId, collisionOrganizationId }) => {
      const tx = createRelinkTx({
        stalePrDetails: [{ id: "pr-stale-7", isCurrent: true, number: 7 }],
        activePrCollisions: [
          {
            id: "pr-active-7",
            number: 7,
            branchArtifactId: collisionBranchArtifactId,
            branchArtifact: { organizationId: collisionOrganizationId },
          },
        ],
      });

      const result = await runRelink([activeCandidate()]);

      expect(result).toEqual(
        relinkResult({
          status: RepositoryArtifactRelinkStatus.Partial,
          reasons: [
            RepositoryArtifactRelinkReason.PullRequestNumberCollision,
            RepositoryArtifactRelinkReason.GuardedWriteFailed,
          ],
          staleRepositoryCount: 1,
          pullRequestCollisionSkippedCount: 1,
          blockedBranchCount: 1,
        })
      );
      expect(tx.pullRequestDetail.update).not.toHaveBeenCalled();
      expect(tx.pullRequestDetail.updateMany).not.toHaveBeenCalled();
      expect(tx.branchDetail.update).not.toHaveBeenCalled();
    }
  );

  it("clears the branch's current PR when the scoped current-pointer update misses", async () => {
    const tx = createRelinkTx({
      stalePrDetails: [{ id: "pr-current", isCurrent: true, number: 3 }],
      setCurrentCount: 0,
    });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
        pullRequestRelinkedCount: 1,
      })
    );
    expect(tx.pullRequestDetail.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            branchArtifactId: BRANCH_ID,
            isCurrent: true,
            id: { not: "pr-current" },
          },
          data: { isCurrent: false },
        },
      ],
      [
        {
          where: {
            id: "pr-current",
            branchArtifactId: BRANCH_ID,
            branchArtifact: { organizationId: ORG_ID },
            repositoryId: ACTIVE_REPO_ID,
          },
          data: { isCurrent: true },
        },
      ],
      [
        {
          where: { branchArtifactId: BRANCH_ID, isCurrent: true },
          data: { isCurrent: false },
        },
      ],
    ]);
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite(null)],
    ]);
  });

  // The pointer names a row a previous sweep already moved to the active
  // repository, while the only stale row is not current. Keeping the validated
  // pointer is what distinguishes it from the stale-`isCurrent` fallback,
  // which here would find nothing and null the pointer.
  it("keeps a validated pointer instead of falling back to the stale current row", async () => {
    const tx = createRelinkTx({
      staleBranches: [
        staleBranch({ currentPullRequestDetailId: "pr-active-9" }),
      ],
      validPointerId: "pr-active-9",
      stalePrDetails: [{ id: "pr-old", isCurrent: false, number: 1 }],
    });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
        pullRequestRelinkedCount: 1,
      })
    );
    expect(tx.pullRequestDetail.update.mock.calls).toEqual([
      [
        {
          where: { id: "pr-old" },
          data: { isCurrent: false, repositoryId: ACTIVE_REPO_ID },
          select: { id: true },
        },
      ],
    ]);
    expect(tx.pullRequestDetail.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            branchArtifactId: BRANCH_ID,
            isCurrent: true,
            id: { not: "pr-active-9" },
          },
          data: { isCurrent: false },
        },
      ],
      [
        {
          where: {
            id: "pr-active-9",
            branchArtifactId: BRANCH_ID,
            branchArtifact: { organizationId: ORG_ID },
            repositoryId: ACTIVE_REPO_ID,
          },
          data: { isCurrent: true },
        },
      ],
    ]);
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite("pr-active-9")],
    ]);
  });

  // The stale read and the collision read are separate statements, so a
  // concurrent relink can move a row between them and the collision read
  // returns that same row. It is the row itself, not a collision: it is
  // relinked (idempotently), never counted as skipped or blocking.
  it("does not treat the stale row itself as its own PR number collision", async () => {
    const tx = createRelinkTx({
      stalePrDetails: [{ id: "pr-moved", isCurrent: true, number: 5 }],
      activePrCollisions: [
        {
          id: "pr-moved",
          number: 5,
          branchArtifactId: BRANCH_ID,
          branchArtifact: { organizationId: ORG_ID },
        },
      ],
    });

    const result = await runRelink([activeCandidate()]);

    expect(result).toEqual(
      relinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        staleRepositoryCount: 1,
        branchRelinkedCount: 1,
        pullRequestRelinkedCount: 1,
      })
    );
    expect(tx.pullRequestDetail.update.mock.calls).toEqual([
      [
        {
          where: { id: "pr-moved" },
          data: { isCurrent: true, repositoryId: ACTIVE_REPO_ID },
          select: { id: true },
        },
      ],
    ]);
    expect(tx.branchDetail.update.mock.calls).toEqual([
      [branchRelinkWrite("pr-moved")],
    ]);
  });
});
