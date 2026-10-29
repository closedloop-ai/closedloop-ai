import { randomUUID } from "node:crypto";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchCompatibilityOutcome } from "@repo/api/src/types/branch-compatibility";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { branchCompatibilityResolver } from "@/app/branches/branch-compatibility-resolver";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
  linkValidSessionToBranch,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const observedAt = new Date("2026-08-18T12:00:00.000Z");
const unavailable = { outcome: BranchCompatibilityOutcome.Unavailable };

describe.skipIf(!hasDatabase)(
  "Branch compatibility resolver privacy boundary (real Postgres)",
  () => {
    it("keeps every unavailable class identical across two organizations", async () => {
      await autoRollbackTransaction(
        async () => {
          const owned = await seedOrganization("owned");
          const foreign = await seedOrganization("foreign");
          const ownedEligible = await seedBranch(
            owned,
            "feature/owned",
            41,
            true
          );
          const foreignEligible = await seedBranch(
            foreign,
            "feature/foreign",
            42,
            true
          );
          const deleted = await seedBranch(owned, "feature/deleted", 43, true);
          const ineligible = await seedBranch(
            owned,
            "feature/ineligible",
            44,
            false
          );
          await withDb((db) =>
            db.branchDetail.update({
              where: { artifactId: deleted.branchArtifactId },
              data: { deletedAt: observedAt },
            })
          );

          await expect(
            branchCompatibilityResolver.resolve(
              owned.organizationId,
              ownedEligible.branchArtifactId
            )
          ).resolves.toEqual({
            branchArtifactId: ownedEligible.branchArtifactId,
            outcome: BranchCompatibilityOutcome.Eligible,
            providerUrl: ownedEligible.providerUrl,
          });

          const resolutions = await Promise.all([
            branchCompatibilityResolver.resolve(
              owned.organizationId,
              foreignEligible.branchArtifactId
            ),
            branchCompatibilityResolver.resolve(
              owned.organizationId,
              deleted.branchArtifactId
            ),
            branchCompatibilityResolver.resolve(
              owned.organizationId,
              randomUUID()
            ),
            branchCompatibilityResolver.resolve(
              owned.organizationId,
              ineligible.branchArtifactId
            ),
          ]);
          expect(resolutions).toEqual([
            unavailable,
            unavailable,
            unavailable,
            unavailable,
          ]);
        },
        { timeout: 20_000 }
      );
    }, 25_000);
  }
);

type SeededOrganization = {
  organizationId: string;
  projectId: string;
  providerRepositoryId: string;
  repositoryFullName: string;
  repositoryId: string;
  userId: string;
};

async function seedOrganization(label: string): Promise<SeededOrganization> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const repositoryFullName = `iss-6400/${label}-${randomUUID().slice(0, 8)}`;
  const providerRepositoryId = `iss-6400-repo-${label}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `iss-6400-${label}-${randomUUID()}`,
        accountId: `iss-6400-${label}`,
        accountLogin: `iss-6400-${label}`,
        accountType: "Organization",
        senderLogin: "iss-6400-test",
        senderId: `iss-6400-sender-${label}`,
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            githubRepoId: providerRepositoryId,
            fullName: repositoryFullName,
            name: repositoryFullName.split("/")[1] ?? label,
            owner: "iss-6400",
            private: false,
            defaultBranchName: "main",
            defaultBranchAvailability: RepositoryDefaultAvailability.Available,
            defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
            defaultBranchSource:
              RepositoryDefaultSource.InstallationRepositoriesRest,
            defaultBranchMechanism: GitHubFetchMechanism.Rest,
            defaultBranchTrigger: GitHubFetchTrigger.UserAction,
            defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
            defaultBranchObservationKey: `iss-6400-${label}`,
            defaultBranchObservedAt: observedAt,
          },
        },
      },
      include: { repositories: { select: { id: true } } },
    })
  );
  const repositoryId = installation.repositories[0]?.id;
  if (!repositoryId) {
    throw new Error("Expected compatibility fixture repository");
  }
  return {
    organizationId,
    projectId,
    providerRepositoryId,
    repositoryFullName,
    repositoryId,
    userId: user.id,
  };
}

async function seedBranch(
  organization: SeededOrganization,
  branchName: string,
  number: number,
  eligible: boolean
) {
  const branchArtifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: organization.organizationId,
        projectId: organization.projectId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: BranchStatus.Open,
        branch: {
          create: {
            organizationId: organization.organizationId,
            repositoryId: organization.repositoryId,
            repositoryFullName: organization.repositoryFullName,
            branchName,
            firstPushedAt: observedAt,
            pushSource: BranchPushSource.Session,
          },
        },
      },
      select: { id: true },
    })
  );
  if (eligible) {
    await linkValidSessionToBranch({
      organizationId: organization.organizationId,
      userId: organization.userId,
      branchArtifactId: branchArtifact.id,
      label: branchName.replaceAll("/", "-"),
    });
  }
  const providerUrl = `https://github.com/${organization.repositoryFullName}/pull/${number}`;
  const pullRequest = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: organization.organizationId,
        branchArtifactId: branchArtifact.id,
        repositoryId: organization.repositoryId,
        repositoryFullName: organization.repositoryFullName,
        githubId: `iss-6400-pr-${randomUUID()}`,
        number,
        htmlUrl: providerUrl,
        isCurrent: true,
        headRepositoryGithubId: organization.providerRepositoryId,
        headRepositoryFullName: organization.repositoryFullName,
        headRepositoryDefaultBranchName: "main",
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Available,
        headRepositoryDefaultBranchCompleteness:
          RepositoryDefaultCompleteness.Complete,
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestRest,
        headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Rest,
        headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
        headRepositoryDefaultBranchCredentialType:
          GitHubFetchCredentialType.GitHubApp,
        headRepositoryDefaultBranchObservationKey: `iss-6400-pr-${number}`,
        headRepositoryDefaultBranchObservedAt: observedAt,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: branchArtifact.id },
      data: { currentPullRequestDetailId: pullRequest.id },
    })
  );
  return { branchArtifactId: branchArtifact.id, providerUrl };
}
