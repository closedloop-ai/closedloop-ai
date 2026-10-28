import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { branchReadService } from "@/app/branches/branch-read-service";
import { isCloudBranchEligible } from "@/app/branches/cloud-branch-eligibility";
import {
  hiddenState,
  initialObservedAt,
  listBranchPage,
  newestObservedAt,
  providerRepositoryId,
  readVisibility,
  repositoryFullName,
  type SeededOrganization,
  seedBranches,
  seedOrganization as seedOrganizationWith,
  setAvailableAuthority,
  visibleState,
} from "../support/branches/cloud-eligibility-realdb.test-helpers";
import { createCommittedTestOrganizationTracker } from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const changedObservedAt = new Date("2026-08-11T11:00:00.000Z");
const isolatedObservedAt = new Date("2026-08-11T12:00:00.000Z");
const committedOrganizations = createCommittedTestOrganizationTracker();

function seedOrganization(label: string): Promise<SeededOrganization> {
  return seedOrganizationWith(committedOrganizations, label);
}

afterEach(async () => {
  await committedOrganizations.cleanup();
});

describe.skipIf(!hasDatabase)(
  "ISS-5827 cloud Branch eligibility (real Postgres)",
  () => {
    it("keeps list pagination and direct detail aligned as authority changes", async () => {
      await committedOrganizations.run(async () => {
        const primary = await seedOrganization("primary");
        const isolated = await seedOrganization("isolated");
        const branchIds = await seedBranches(primary, [
          "main",
          "feature/one",
          "feature/two",
        ]);
        await seedHistoricalLegacyPullRequest(
          primary,
          branchIds.get("feature/one") ?? ""
        );

        await setAvailableAuthority(
          primary.repositoryId,
          "main",
          initialObservedAt
        );
        await setAvailableAuthority(
          isolated.repositoryId,
          "feature/two",
          isolatedObservedAt
        );

        const firstPage = await listBranchPage(primary.organizationId, 1, 0);
        const secondPage = await listBranchPage(primary.organizationId, 1, 1);
        expect(firstPage).toMatchObject({ total: 2, hasMore: true });
        expect(secondPage).toMatchObject({ total: 2, hasMore: false });
        expect(
          new Set([
            firstPage.items[0]?.branchName,
            secondPage.items[0]?.branchName,
          ])
        ).toEqual(new Set(["feature/one", "feature/two"]));
        await expect(
          branchReadService.getBranchDetail(
            primary.organizationId,
            branchIds.get("feature/one") ?? ""
          )
        ).resolves.toMatchObject({ branchName: "feature/one" });
        await expect(
          branchReadService.getBranchDetail(
            primary.organizationId,
            branchIds.get("main") ?? ""
          )
        ).resolves.toBeNull();

        await setAvailableAuthority(
          primary.repositoryId,
          "feature/one",
          changedObservedAt
        );

        const afterDefaultChange = await listBranchPage(
          primary.organizationId,
          10,
          0
        );
        expect(afterDefaultChange).toMatchObject({
          total: 2,
          hasMore: false,
        });
        expect(new Set(afterDefaultChange.items.map(rowName))).toEqual(
          new Set(["main", "feature/two"])
        );
        await expect(
          branchReadService.getBranchDetail(
            primary.organizationId,
            branchIds.get("feature/one") ?? ""
          )
        ).resolves.toBeNull();
        await expect(
          branchReadService.getBranchDetail(
            primary.organizationId,
            branchIds.get("main") ?? ""
          )
        ).resolves.toMatchObject({ branchName: "main" });

        const persistedBranches = await withDb((db) =>
          db.branchDetail.count({
            where: {
              organizationId: primary.organizationId,
              repositoryFullName,
            },
          })
        );
        expect(persistedBranches).toBe(3);

        await clearAuthority(primary.repositoryId);
        await expect(
          listBranchPage(primary.organizationId, 10, 0)
        ).resolves.toMatchObject({ items: [], total: 0, hasMore: false });
        await expect(
          branchReadService.getBranchDetail(
            primary.organizationId,
            branchIds.get("main") ?? ""
          )
        ).resolves.toBeNull();

        await setUnavailableAuthority(primary.repositoryId);
        await expect(
          listBranchPage(primary.organizationId, 10, 0)
        ).resolves.toMatchObject({ items: [], total: 0, hasMore: false });
        await expect(
          branchReadService.getBranchDetail(
            primary.organizationId,
            branchIds.get("main") ?? ""
          )
        ).resolves.toBeNull();
        expect(
          await withDb((db) =>
            db.branchDetail.count({
              where: {
                organizationId: primary.organizationId,
                repositoryFullName,
              },
            })
          )
        ).toBe(3);
      });
    }, 25_000);

    it("never falls back from newer conflicting pull-request authority", async () => {
      await committedOrganizations.run(async () => {
        const organization = await seedOrganization("newer-pr");
        const branchName = "feature/provider-conflict";
        const branchId =
          (await seedBranches(organization, [branchName])).get(branchName) ??
          "";
        await setAvailableAuthority(
          organization.repositoryId,
          "main",
          initialObservedAt
        );
        await seedPublicAuthority(
          organization.organizationId,
          "main",
          initialObservedAt
        );
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(visibleState(branchId));

        const pullRequestId = await seedPullRequestAuthority(
          organization,
          branchId,
          {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness: RepositoryDefaultCompleteness.Unavailable,
            reason: RepositoryDefaultReason.ProviderError,
            repositoryFullName,
            providerRepositoryId,
          }
        );
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);

        await updatePullRequestAuthority(pullRequestId, {
          repositoryFullName: "different-owner/cloud-eligibility",
          providerRepositoryId,
        });
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);

        await updatePullRequestAuthority(pullRequestId, {
          repositoryFullName,
          providerRepositoryId: "different-provider-id",
        });
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);
      });
    });

    it("does not let a delayed webhook outrank a newer REST snapshot", async () => {
      await committedOrganizations.run(async () => {
        const organization = await seedOrganization("mixed-freshness");
        const branchName = "main";
        const branchId =
          (await seedBranches(organization, [branchName])).get(branchName) ??
          "";
        await setAvailableAuthority(
          organization.repositoryId,
          "trunk",
          changedObservedAt
        );
        await seedPullRequestAuthority(organization, branchId, {
          availability: RepositoryDefaultAvailability.Available,
          completeness: RepositoryDefaultCompleteness.Complete,
          reason: null,
          repositoryFullName,
          providerRepositoryId,
          defaultBranchName: "main",
          mechanism: GitHubFetchMechanism.Webhook,
          eventAt: initialObservedAt,
          observedAt: newestObservedAt,
        });

        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(visibleState(branchId));
      });
    });

    it("keeps pure and SQL decisions aligned across legacy and fresh authority", async () => {
      await committedOrganizations.run(async () => {
        const organization = await seedOrganization("parity");
        const branchName = "feature/parity";
        const branchId =
          (await seedBranches(organization, [branchName])).get(branchName) ??
          "";
        await clearAuthority(organization.repositoryId);
        await seedHistoricalLegacyPullRequest(organization, branchId);
        const currentPullRequestId = await seedPullRequestAuthority(
          organization,
          branchId,
          {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            reason: null,
            repositoryFullName,
            providerRepositoryId,
            defaultBranchName: "main",
          }
        );

        expect(pureEligibilityWithLegacy(branchName, repositoryFullName)).toBe(
          true
        );
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(visibleState(branchId));

        await clearPullRequestAuthority(currentPullRequestId);
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);

        await updatePullRequestAuthority(currentPullRequestId, {
          repositoryFullName: "different-owner/cloud-eligibility",
          providerRepositoryId,
        });
        expect(
          pureEligibilityWithLegacy(
            branchName,
            "different-owner/cloud-eligibility"
          )
        ).toBe(false);
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);
      });
    });

    it("rejects corrupt persisted provenance and tied partial authority", async () => {
      await committedOrganizations.run(async () => {
        const organization = await seedOrganization("corrupt");
        const branchName = "feature/corrupt-authority";
        const branchId =
          (await seedBranches(organization, [branchName])).get(branchName) ??
          "";
        await setAvailableAuthority(
          organization.repositoryId,
          "main",
          changedObservedAt
        );
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(visibleState(branchId));

        await patchInstallationAuthority(organization.repositoryId, {
          defaultBranchObservedAt: null,
        });
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);

        await setAvailableAuthority(
          organization.repositoryId,
          "main",
          changedObservedAt
        );
        await patchInstallationAuthority(organization.repositoryId, {
          defaultBranchObservationKey: null,
        });
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);

        await setAvailableAuthority(
          organization.repositoryId,
          "main",
          changedObservedAt
        );
        await patchInstallationAuthority(organization.repositoryId, {
          defaultBranchReason: RepositoryDefaultReason.ProviderError,
        });
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);

        await setAvailableAuthority(
          organization.repositoryId,
          "main",
          newestObservedAt
        );
        await seedPublicAuthority(
          organization.organizationId,
          "main",
          newestObservedAt,
          { defaultBranchMechanism: null }
        );
        await expect(
          readVisibility(organization.organizationId, branchId)
        ).resolves.toEqual(hiddenState);
      });
    });
  }
);

function seedHistoricalLegacyPullRequest(
  organization: SeededOrganization,
  branchArtifactId: string
) {
  return withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: organization.organizationId,
        branchArtifactId,
        repositoryId: organization.repositoryId,
        repositoryFullName,
        githubId: `iss-5827-legacy-${branchArtifactId}`,
        number: 5826,
        isCurrent: false,
        headRepositoryGithubId: providerRepositoryId,
        headRepositoryFullName: repositoryFullName,
      },
    })
  );
}

function rowName(row: { branchName: string }): string {
  return row.branchName;
}

function clearAuthority(repositoryId: string) {
  return withDb((db) =>
    db.gitHubInstallationRepository.update({
      where: { id: repositoryId },
      data: {
        defaultBranchName: null,
        defaultBranchAvailability: null,
        defaultBranchCompleteness: null,
        defaultBranchReason: null,
        defaultBranchSource: null,
        defaultBranchMechanism: null,
        defaultBranchTrigger: null,
        defaultBranchCredentialType: null,
        defaultBranchObservationKey: null,
        defaultBranchObservedAt: null,
      },
    })
  );
}

function setUnavailableAuthority(repositoryId: string) {
  return withDb((db) =>
    db.gitHubInstallationRepository.update({
      where: { id: repositoryId },
      data: {
        defaultBranchName: null,
        defaultBranchAvailability: RepositoryDefaultAvailability.Unavailable,
        defaultBranchCompleteness: RepositoryDefaultCompleteness.Unavailable,
        defaultBranchReason: RepositoryDefaultReason.ProviderError,
        defaultBranchSource:
          RepositoryDefaultSource.InstallationRepositoriesRest,
        defaultBranchMechanism: GitHubFetchMechanism.Rest,
        defaultBranchTrigger: GitHubFetchTrigger.UserAction,
        defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
        defaultBranchObservationKey: "iss-5827-unavailable",
        defaultBranchObservedAt: changedObservedAt,
      },
    })
  );
}

function patchInstallationAuthority(
  repositoryId: string,
  data: {
    defaultBranchObservedAt?: Date | null;
    defaultBranchObservationKey?: string | null;
    defaultBranchReason?: string | null;
  }
) {
  return withDb((db) =>
    db.gitHubInstallationRepository.update({
      where: { id: repositoryId },
      data,
    })
  );
}

function seedPublicAuthority(
  organizationId: string,
  defaultBranchName: string,
  observedAt: Date,
  overrides: { defaultBranchMechanism?: string | null } = {}
) {
  return withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        githubRepoId: providerRepositoryId,
        fullName: repositoryFullName,
        owner: "iss-5827",
        name: "cloud-eligibility",
        htmlUrl: `https://github.com/${repositoryFullName}`,
        defaultBranchName,
        defaultBranchAvailability: RepositoryDefaultAvailability.Available,
        defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
        defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
        defaultBranchMechanism:
          "defaultBranchMechanism" in overrides
            ? overrides.defaultBranchMechanism
            : GitHubFetchMechanism.Rest,
        defaultBranchTrigger: GitHubFetchTrigger.UserAction,
        defaultBranchCredentialType: GitHubFetchCredentialType.Unauthenticated,
        defaultBranchObservationKey: `public-${observedAt.toISOString()}`,
        defaultBranchObservedAt: observedAt,
      },
    })
  );
}

function seedPullRequestAuthority(
  organization: SeededOrganization,
  branchArtifactId: string,
  authority: {
    availability: RepositoryDefaultAvailability;
    completeness: RepositoryDefaultCompleteness;
    reason: RepositoryDefaultReason | null;
    repositoryFullName: string;
    providerRepositoryId: string;
    defaultBranchName?: string;
    mechanism?: GitHubFetchMechanism;
    eventAt?: Date;
    observedAt?: Date;
  }
) {
  return withDb(async (db) => {
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        organizationId: organization.organizationId,
        branchArtifactId,
        repositoryId: organization.repositoryId,
        repositoryFullName,
        githubId: `iss-5827-pr-${branchArtifactId}`,
        number: 5827,
        isCurrent: true,
        headRepositoryGithubId: authority.providerRepositoryId,
        headRepositoryFullName: authority.repositoryFullName,
        headRepositoryDefaultBranchName: authority.defaultBranchName,
        headRepositoryDefaultBranchAvailability: authority.availability,
        headRepositoryDefaultBranchCompleteness: authority.completeness,
        headRepositoryDefaultBranchReason: authority.reason,
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestRest,
        headRepositoryDefaultBranchMechanism:
          authority.mechanism ?? GitHubFetchMechanism.Rest,
        headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
        headRepositoryDefaultBranchCredentialType:
          GitHubFetchCredentialType.GitHubApp,
        headRepositoryDefaultBranchObservationKey: "newer-unavailable",
        headRepositoryDefaultBranchObservedAt:
          authority.observedAt ?? newestObservedAt,
        headRepositoryDefaultBranchEventAt: authority.eventAt,
      },
      select: { id: true },
    });
    await db.branchDetail.update({
      where: { artifactId: branchArtifactId },
      data: { currentPullRequestDetailId: pullRequest.id },
      select: { artifactId: true },
    });
    return pullRequest.id;
  });
}

function updatePullRequestAuthority(
  pullRequestId: string,
  identity: { repositoryFullName: string; providerRepositoryId: string }
) {
  return withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: pullRequestId },
      data: {
        headRepositoryGithubId: identity.providerRepositoryId,
        headRepositoryFullName: identity.repositoryFullName,
        headRepositoryDefaultBranchName: "main",
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Available,
        headRepositoryDefaultBranchCompleteness:
          RepositoryDefaultCompleteness.Complete,
        headRepositoryDefaultBranchReason: null,
        headRepositoryDefaultBranchObservationKey: `identity-${identity.providerRepositoryId}`,
      },
    })
  );
}

function clearPullRequestAuthority(pullRequestId: string) {
  return withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: pullRequestId },
      data: {
        headRepositoryDefaultBranchName: null,
        headRepositoryDefaultBranchAvailability: null,
        headRepositoryDefaultBranchCompleteness: null,
        headRepositoryDefaultBranchReason: null,
        headRepositoryDefaultBranchSource: null,
        headRepositoryDefaultBranchMechanism: null,
        headRepositoryDefaultBranchTrigger: null,
        headRepositoryDefaultBranchCredentialType: null,
        headRepositoryDefaultBranchCredentialOwnerId: null,
        headRepositoryDefaultBranchObservationKey: null,
        headRepositoryDefaultBranchObservedAt: null,
        headRepositoryDefaultBranchEventAt: null,
      },
    })
  );
}

function pureEligibilityWithLegacy(
  branchName: string,
  freshRepositoryFullName: string
): boolean {
  return isCloudBranchEligible({
    branchName,
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName: repositoryFullName,
    },
    authorities: [
      {
        repository: {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId,
          fullName: repositoryFullName,
        },
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          reason: RepositoryDefaultReason.LegacyRecord,
        },
      },
      {
        repository: {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId,
          fullName: freshRepositoryFullName,
        },
        evidence: {
          availability: RepositoryDefaultAvailability.Available,
          completeness: RepositoryDefaultCompleteness.Complete,
          defaultBranch: "main",
        },
        provenance: {
          source: RepositoryDefaultSource.PullRequestRest,
          mechanism: GitHubFetchMechanism.Rest,
          trigger: GitHubFetchTrigger.SurfaceOpen,
          credentialType: GitHubFetchCredentialType.GitHubApp,
          observationKey: "parity-current-pr",
          observedAt: newestObservedAt.toISOString(),
        },
      },
    ],
  });
}
