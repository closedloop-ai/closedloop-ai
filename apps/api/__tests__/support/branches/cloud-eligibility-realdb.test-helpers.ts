/**
 * Real-Postgres seeding shared by the cloud Branch eligibility suites.
 *
 * ISS-5827 owns the authority-precedence cases and ISS-8422 the unobserved
 * pull-request ones; both stand up the same organization, installation
 * repository, branch and PR rows, so the seeding lives here rather than being
 * copied into whichever file grows next.
 */
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
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
import { branchReadService } from "@/app/branches/branch-read-service";
import {
  createTestProject,
  createTestUser,
  linkValidSessionToBranch,
} from "../../utils/db-helpers";

export const repositoryFullName = "iss-5827/cloud-eligibility";
export const providerRepositoryId = "5827";
export const initialObservedAt = new Date("2026-08-11T10:00:00.000Z");
export const newestObservedAt = new Date("2026-08-11T13:00:00.000Z");
export const hiddenState = { ids: [], total: 0, detailId: null };

export type SeededOrganization = {
  organizationId: string;
  userId: string;
  projectId: string;
  repositoryId: string;
};

/** Each suite owns its own tracker, so the caller passes one in. */
type OrganizationTracker = { create: () => Promise<string> };

export async function seedOrganization(
  organizations: OrganizationTracker,
  label: string
): Promise<SeededOrganization> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `iss-5827-${label}-${organizationId}`,
        accountId: `iss-5827-${label}`,
        accountLogin: label,
        accountType: "Organization",
        senderLogin: "sender",
        senderId: `sender-${label}`,
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            githubRepoId: providerRepositoryId,
            fullName: repositoryFullName,
            name: "cloud-eligibility",
            owner: "iss-5827",
            private: false,
          },
        },
      },
      include: { repositories: { select: { id: true } } },
    })
  );
  const repositoryId = installation.repositories[0]?.id;
  if (!repositoryId) {
    throw new Error("Expected installation repository fixture");
  }
  return { organizationId, userId: user.id, projectId, repositoryId };
}

export async function seedBranches(
  organization: SeededOrganization,
  branchNames: string[]
): Promise<Map<string, string>> {
  const branchIds = new Map<string, string>();
  for (const branchName of branchNames) {
    const branch = await withDb((db) =>
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
              repositoryFullName,
              branchName,
              firstPushedAt: initialObservedAt,
              pushSource: BranchPushSource.Session,
            },
          },
        },
        select: { id: true },
      })
    );
    await linkValidSessionToBranch({
      organizationId: organization.organizationId,
      userId: organization.userId,
      branchArtifactId: branch.id,
      label: branchName.replaceAll("/", "-"),
    });
    branchIds.set(branchName, branch.id);
  }
  return branchIds;
}

export function listBranchPage(
  organizationId: string,
  limit: number,
  offset: number
) {
  return branchReadService.listBranches(organizationId, { limit, offset });
}

export function setAvailableAuthority(
  repositoryId: string,
  defaultBranchName: string,
  observedAt: Date
) {
  return withDb((db) =>
    db.gitHubInstallationRepository.update({
      where: { id: repositoryId },
      data: {
        defaultBranchName,
        defaultBranchAvailability: RepositoryDefaultAvailability.Available,
        defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
        defaultBranchReason: null,
        defaultBranchSource:
          RepositoryDefaultSource.InstallationRepositoriesRest,
        defaultBranchMechanism: GitHubFetchMechanism.Rest,
        defaultBranchTrigger: GitHubFetchTrigger.UserAction,
        defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
        defaultBranchObservationKey: `iss-5827-${observedAt.toISOString()}`,
        defaultBranchObservedAt: observedAt,
      },
    })
  );
}

export async function readVisibility(organizationId: string, branchId: string) {
  const page = await listBranchPage(organizationId, 10, 0);
  const detail = await branchReadService.getBranchDetail(
    organizationId,
    branchId
  );
  return {
    ids: page.items.map(({ id }) => id),
    total: page.total,
    detailId: detail?.id ?? null,
  };
}

export function visibleState(branchId: string) {
  return { ids: [branchId], total: 1, detailId: branchId };
}

/**
 * The row the desktop lane writes the moment a PR is opened: server-derived
 * identity and not one observed fact (ISS-8422).
 */
export async function seedFactlessCurrentPullRequest(
  organization: SeededOrganization,
  branchArtifactId: string,
  label: string,
  number = 8422,
  // A second snapshot of the SAME pull request has to omit the repository id:
  // `@@unique([repositoryId, number])` admits only one row that carries it,
  // and the desktop lane writes exactly this shape.
  { withRepositoryId = true }: { withRepositoryId?: boolean } = {}
) {
  const pullRequestId = await withDb(async (db) => {
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        organizationId: organization.organizationId,
        branchArtifactId,
        ...(withRepositoryId
          ? { repositoryId: organization.repositoryId }
          : {}),
        repositoryFullName,
        githubId: `iss-8422-${label}-${branchArtifactId}`,
        number,
        isCurrent: true,
        headRepositoryFullName: repositoryFullName,
        htmlUrl: `https://github.com/${repositoryFullName}/pull/${number}`,
      },
      select: { id: true },
    });
    return pullRequest.id;
  });
  await pointBranchAtPullRequest(branchArtifactId, pullRequestId);
  return pullRequestId;
}

export function setArtifactStatus(branchArtifactId: string, status: string) {
  return withDb((db) =>
    db.artifact.update({
      where: { id: branchArtifactId },
      data: { status },
    })
  );
}

/** Head identity WITHOUT the default-branch authority group beside it. */
export function setPullRequestHeadRepository(
  pullRequestId: string,
  headRepositoryFullName: string
) {
  return withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: pullRequestId },
      data: { headRepositoryFullName },
    })
  );
}

/**
 * A merged PR that is NOT the branch's current pointer — the terminal row the
 * SQL twin would resolve if the ambiguity gate were missing.
 */
export function seedHistoricalMergedPullRequest(
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
        githubId: `iss-8422-merged-${branchArtifactId}`,
        number: 8400,
        isCurrent: false,
        prState: GitHubPRState.Merged,
        mergedAt: initialObservedAt,
        lastVerifiedAt: initialObservedAt,
        headRepositoryFullName: repositoryFullName,
      },
      select: { id: true },
    })
  );
}

export function pointBranchAtPullRequest(
  branchArtifactId: string,
  pullRequestId: string
) {
  return withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: branchArtifactId },
      data: { currentPullRequestDetailId: pullRequestId },
    })
  );
}

/** Gives a previously factless PR row a complete head-repository authority group. */
export function setPullRequestAuthorityGroup(
  pullRequestId: string,
  identity: {
    repositoryFullName: string;
    providerRepositoryId: string;
    observedAt: Date;
  }
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
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestRest,
        headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Rest,
        headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
        headRepositoryDefaultBranchCredentialType:
          GitHubFetchCredentialType.GitHubApp,
        headRepositoryDefaultBranchObservationKey: `iss-8422-${identity.providerRepositoryId}`,
        headRepositoryDefaultBranchObservedAt: identity.observedAt,
      },
    })
  );
}
