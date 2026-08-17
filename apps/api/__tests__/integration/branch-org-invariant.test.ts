import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  ArtifactType,
  GitHubInstallationStatus,
  GitHubPRState,
  withDb,
} from "@repo/database";
import { describe, expect, it } from "vitest";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchService } from "@/app/branches/branch-service";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
  linkValidSessionToBranch,
} from "../utils/db-helpers";

/**
 * PRD-510 FR13 invariant (PLN-1099 Phase 0): `BranchDetail.organizationId` is a
 * write-once denormalization of the parent `Artifact.organizationId` (the org
 * SSOT). Every branch row must satisfy `branch_detail.organization_id =
 * artifacts.organization_id`; this suite fails loud on drift and also proves the
 * D2 key column (`repository_full_name`) is stored normalized.
 *
 * Each test runs inside `autoRollbackTransaction`, so all seeded rows are rolled
 * back — no manual cleanup, and no cross-test residue (the org→artifact/project/
 * user/installation FKs are RESTRICT, so a direct `organization.delete` teardown
 * would throw anyway).
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function seedRepo(organizationId: string): Promise<{
  providerRepositoryId: string;
  repositoryId: string;
  repositoryFullName: string;
}> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const fullName = `Org/Repo-${suffix}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${suffix}`,
        accountId: `acct-${suffix}`,
        accountLogin: "org",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: `repo-${suffix}`,
              fullName,
            }),
            name: "repo",
            owner: "org",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repo = installation.repositories[0];
  if (!repo) {
    throw new Error("Failed to seed repository for test");
  }
  return {
    providerRepositoryId: repo.githubRepoId,
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
  };
}

describe.skipIf(!hasDatabase)("branch org-SSOT (FR13) invariant", () => {
  it("writes branch_detail.organization_id from the parent artifact and normalizes the repo full name", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const { repositoryId, repositoryFullName } =
        await seedRepo(organizationId);

      const result = await branchService.upsertBranchArtifact({
        organizationId,
        repositoryId,
        // Deliberately pass a MixedCase/`.git` name: the write path must
        // normalize it into the stored D2 key column.
        repositoryFullName: `${repositoryFullName}.git`,
        branchName: "feature/org-invariant",
        projectId,
      });
      expect(result.ok).toBe(true);

      const branch = await withDb((db) =>
        db.branchDetail.findFirst({
          where: { organizationId, branchName: "feature/org-invariant" },
          include: { artifact: { select: { organizationId: true } } },
        })
      );
      expect(branch).not.toBeNull();
      // FR13: the denormalized copy equals the parent Artifact's org (the SSOT).
      expect(branch?.organizationId).toBe(organizationId);
      expect(branch?.organizationId).toBe(branch?.artifact.organizationId);
      // D2: the stored full name is normalized (lowercase, no trailing `.git`).
      expect(branch?.repositoryFullName).toBe(repositoryFullName.toLowerCase());
    });
  });

  it("holds branch_detail.organization_id = artifacts.organization_id across every row in the org", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const { repositoryId, repositoryFullName } =
        await seedRepo(organizationId);

      for (const branchName of ["feature/a", "feature/b", "feature/c"]) {
        const result = await branchService.upsertBranchArtifact({
          organizationId,
          repositoryId,
          repositoryFullName,
          branchName,
          projectId,
        });
        expect(result.ok).toBe(true);
      }

      // Scan every branch artifact in the org and assert no org drift on any row.
      const rows = await withDb((db) =>
        db.artifact.findMany({
          where: { organizationId, type: ArtifactType.BRANCH },
          select: {
            organizationId: true,
            branch: { select: { organizationId: true } },
          },
        })
      );
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(row.branch?.organizationId).toBe(row.organizationId);
      }
    });
  });

  it("returns persisted active and historical PRs through Branch detail", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const { providerRepositoryId, repositoryId, repositoryFullName } =
        await seedRepo(organizationId);
      const branch = await branchService.upsertBranchArtifact({
        organizationId,
        repositoryId,
        repositoryFullName,
        branchName: "FEA-4313-associated-history",
        projectId,
      });
      expect(branch.ok).toBe(true);
      if (!branch.ok) {
        throw new Error("Expected Branch materialization to succeed");
      }
      await linkValidSessionToBranch({
        organizationId,
        userId: user.id,
        branchArtifactId: branch.value.id,
        label: "fea-4313-history",
      });
      await withDb((db) =>
        db.pullRequestDetail.createMany({
          data: [
            {
              organizationId,
              branchArtifactId: branch.value.id,
              repositoryId,
              githubId: "4312",
              number: 4312,
              title: "Historical Branch PR",
              htmlUrl: `https://github.com/${repositoryFullName}/pull/4312`,
              prState: GitHubPRState.CLOSED,
              isCurrent: true,
              closedAt: new Date("2026-08-01T00:00:00.000Z"),
              lastVerifiedAt: new Date("2026-08-01T00:01:00.000Z"),
              ...persistedPullRequestHeadAuthority(
                providerRepositoryId,
                repositoryFullName
              ),
            },
            {
              organizationId,
              branchArtifactId: branch.value.id,
              repositoryId,
              githubId: "4313",
              number: 4313,
              title: "Active Branch PR",
              htmlUrl: `https://github.com/${repositoryFullName}/pull/4313`,
              prState: GitHubPRState.OPEN,
              isCurrent: false,
              lastVerifiedAt: new Date("2026-08-02T00:01:00.000Z"),
              ...persistedPullRequestHeadAuthority(
                providerRepositoryId,
                repositoryFullName
              ),
            },
          ],
        })
      );

      const detail = await branchReadService.getBranchDetail(
        organizationId,
        branch.value.id
      );

      expect(detail?.associatedPullRequests).toMatchObject({
        selectedId: `${repositoryFullName.toLowerCase()}#4313`,
        selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
        },
      });
      expect(
        detail?.associatedPullRequests?.items.map(({ number }) => number)
      ).toEqual([4312, 4313]);

      const bySelectedStatus = await branchReadService.listBranches(
        organizationId,
        { limit: 10, offset: 0, status: [BranchStatus.Open] }
      );
      const bySelectedTitle = await branchReadService.listBranches(
        organizationId,
        { limit: 10, offset: 0, search: "Active Branch PR" }
      );
      expect(bySelectedStatus.items.map(({ id }) => id)).toContain(
        branch.value.id
      );
      expect(bySelectedTitle.items.map(({ id }) => id)).toContain(
        branch.value.id
      );
    });
  });
});

function persistedPullRequestHeadAuthority(
  providerRepositoryId: string,
  repositoryFullName: string
) {
  const authority = persistedGitHubRepositoryAuthority({
    githubRepoId: providerRepositoryId,
    fullName: repositoryFullName,
  });
  return {
    headRepositoryGithubId: authority.githubRepoId,
    headRepositoryFullName: authority.fullName,
    headRepositoryDefaultBranchName: authority.defaultBranchName,
    headRepositoryDefaultBranchAvailability:
      authority.defaultBranchAvailability,
    headRepositoryDefaultBranchCompleteness:
      authority.defaultBranchCompleteness,
    headRepositoryDefaultBranchReason: authority.defaultBranchReason,
    headRepositoryDefaultBranchSource: authority.defaultBranchSource,
    headRepositoryDefaultBranchMechanism: authority.defaultBranchMechanism,
    headRepositoryDefaultBranchTrigger: authority.defaultBranchTrigger,
    headRepositoryDefaultBranchCredentialType:
      authority.defaultBranchCredentialType,
    headRepositoryDefaultBranchCredentialOwnerId:
      authority.defaultBranchCredentialOwnerId,
    headRepositoryDefaultBranchObservationKey:
      authority.defaultBranchObservationKey,
    headRepositoryDefaultBranchObservedAt: authority.defaultBranchObservedAt,
    headRepositoryDefaultBranchEventAt: authority.defaultBranchEventAt,
  };
}
