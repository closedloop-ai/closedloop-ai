import { randomUUID } from "node:crypto";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { clerkClient } from "@repo/auth/server";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { vi } from "vitest";
import { githubServerSyncService } from "@/app/integrations/github/sync-service";
import {
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "../../../utils/db-helpers";

/**
 * The real-Postgres seed and provider fixtures for the non-webhook PR lifecycle
 * writers, shared by `non-webhook-pr-lifecycle-writers-realdb.test.ts` (which
 * asserts what each writer persists) and
 * `pr-projection-producer-roundtrip-realdb.test.ts` (which asserts what the
 * projection READ then serves from those same rows). They live here so the two
 * cannot drift into disagreeing about what a seeded repository, branch, or
 * provider response looks like.
 *
 * Every helper that touches `vi` — `wireClerkGitHubToken`, `mockProviderSuccess`
 * — reads the mock the IMPORTING suite installed, so a consumer owes the
 * matching `vi.mock` for `@repo/auth/server` and `@repo/github`.
 */

export const OPENED_AT = "2026-08-10T12:00:00.000Z";
export const MERGED_AT = "2026-08-11T12:00:00.000Z";

/**
 * The base ref `seedWriterFixture` writes on the owning BRANCH, deliberately
 * different from the base every provider fixture reports for the PR
 * (`PROVIDER_BASE_BRANCH`). It is the retargeted / multi-PR branch: reading the
 * Branch row reported THIS value on every historical PR of that branch, which is
 * the confident wrong answer ISS-8155 removed.
 */
export const SEEDED_BRANCH_BASE = "legacy-base";

/** The base ref GitHub reports for the PR in every provider fixture below. */
export const PROVIDER_BASE_BRANCH = "main";

/** The author GitHub reports for the PR in every provider fixture below. */
export const PROVIDER_AUTHOR_LOGIN = "octocat";
export const PROVIDER_AUTHOR_ID = "123";

export type WriterFixture = {
  organizationId: string;
  userId: string;
  repositoryId: string;
  repositoryFullName: string;
  branchArtifactId: string;
  branchName: string;
  pullRequestId: string | null;
  pullRequestGithubId: string | null;
  pullRequestNumber: number;
  pullRequestHtmlUrl: string;
};

export async function seedWriterFixture(
  label: string,
  options: {
    createPullRequest?: boolean;
    tombstoned?: boolean;
    withSyncAuthority?: boolean;
  } = {}
): Promise<WriterFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const repositoryFullName = `iss-6421/${label}-${suffix}`;
  const branchName = `feature/${label}`;
  const pullRequestNumber = 6421;
  const pullRequestHtmlUrl = `https://github.com/${repositoryFullName}/pull/${pullRequestNumber}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `iss-6421-installation-${suffix}`,
        accountId: `iss-6421-account-${suffix}`,
        accountLogin: "iss-6421",
        accountType: "Organization",
        senderLogin: "iss-6421",
        senderId: `iss-6421-sender-${suffix}`,
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            githubRepoId: `iss-6421-repo-${suffix}`,
            fullName: repositoryFullName,
            name: `${label}-${suffix}`,
            owner: "iss-6421",
            private: true,
            removedAt: options.tombstoned
              ? new Date("2026-08-10T10:00:00.000Z")
              : null,
          },
        },
      },
      include: { repositories: { select: { id: true } } },
    })
  );
  const repositoryId = installation.repositories[0]?.id;
  if (!repositoryId) {
    throw new Error("Expected ISS-6421 repository fixture");
  }
  const branch = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        name: `ISS-6421 ${label}`,
        status: GitHubPRState.Open,
        type: ArtifactType.BRANCH,
        branch: {
          create: {
            organizationId,
            repositoryId,
            repositoryFullName,
            branchName,
            baseBranch: SEEDED_BRANCH_BASE,
            headSha: "legacy-head",
          },
        },
      },
      select: { id: true },
    })
  );
  let pullRequestId: string | null = null;
  let pullRequestGithubId: string | null = null;
  if (options.createPullRequest) {
    pullRequestGithubId = `iss-6421-pr-${suffix}`;
    const pullRequest = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          organizationId,
          branchArtifactId: branch.id,
          repositoryId,
          repositoryFullName,
          githubId: pullRequestGithubId,
          // The projection read excludes a row it cannot identify, so a seeded
          // row needs the link target the live contract always carried.
          htmlUrl: pullRequestHtmlUrl,
          number: pullRequestNumber,
          title: "Legacy title",
          prState: GitHubPRState.Open,
          isCurrent: true,
        },
        select: { id: true },
      })
    );
    pullRequestId = pullRequest.id;
    await withDb((db) =>
      db.branchDetail.update({
        where: { artifactId: branch.id },
        data: { currentPullRequestDetailId: pullRequest.id },
      })
    );
  }
  if (options.withSyncAuthority) {
    if (!pullRequestId) {
      throw new Error("Sync fixture requires a pull request");
    }
    const sessionId = await linkValidSessionToBranch({
      organizationId,
      userId: user.id,
      branchArtifactId: branch.id,
      label,
      linkKind: SessionArtifactLinkKind.SessionPr,
    });
    await withDb(async (db) => {
      await db.artifactLink.updateMany({
        where: { sourceId: sessionId, targetId: branch.id },
        data: {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            repositoryFullName,
            prNumber: pullRequestNumber,
          },
        },
      });
      await db.gitHubUserConnection.create({
        data: {
          organizationId,
          userId: user.id,
          githubUserId: `iss-6421-user-${suffix}`,
          login: `iss-6421-${suffix}`,
          normalizedLogin: `iss-6421-${suffix}`,
          scopes: ["repo"],
          // Inside the registry's sample interval relative to the pinned clock,
          // so the identity refresh short-circuits and the row keeps the
          // fixture's GitHub account instead of rebinding to the stub's.
          lastUsedAt: new Date("2026-08-12T01:00:00.000Z"),
        },
        select: { id: true },
      });
    });
  }
  return {
    organizationId,
    userId: user.id,
    repositoryId,
    repositoryFullName,
    branchArtifactId: branch.id,
    branchName,
    pullRequestId,
    pullRequestGithubId,
    pullRequestNumber,
    pullRequestHtmlUrl,
  };
}

export function backfillInput(
  fixture: WriterFixture,
  overrides: Partial<GitHubReadModelPullRequest> = {}
) {
  return {
    organizationId: fixture.organizationId,
    repository: {
      id: fixture.repositoryId,
      fullName: fixture.repositoryFullName,
    },
    credential: {
      type: GitHubFetchCredentialType.GitHubApp,
      ownerId: null,
    },
    pullRequests: [backfillPullRequest(fixture, overrides)],
  };
}

export function backfillPullRequest(
  fixture: WriterFixture,
  overrides: Partial<GitHubReadModelPullRequest> = {}
): GitHubReadModelPullRequest {
  return {
    githubId: seededOrCreatedGithubId(fixture),
    number: fixture.pullRequestNumber,
    title: "Projected title",
    htmlUrl: fixture.pullRequestHtmlUrl,
    headBranch: fixture.branchName,
    baseBranch: PROVIDER_BASE_BRANCH,
    headSha: "projected-head",
    state: GitHubPRState.Merged,
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: OPENED_AT,
    closedAt: MERGED_AT,
    mergedAt: MERGED_AT,
    mergeCommitSha: "projected-merge",
    updatedAt: MERGED_AT,
    author: PROVIDER_AUTHOR_LOGIN,
    source: GitHubReadModelSource.Provider,
    headRepository: headRepositoryAuthority(
      fixture,
      RepositoryDefaultSource.PullRequestGraphql,
      GitHubFetchMechanism.Graphql,
      GitHubFetchTrigger.Backfill,
      GitHubFetchCredentialType.GitHubApp
    ),
    ...overrides,
  };
}

export function providerPullRequest(
  fixture: WriterFixture,
  overrides: Partial<GitHubSinglePullRequestResult> = {}
): GitHubSinglePullRequestResult {
  return {
    githubId: seededOrCreatedGithubId(fixture),
    number: fixture.pullRequestNumber,
    title: "Projected title",
    htmlUrl: fixture.pullRequestHtmlUrl,
    headBranch: fixture.branchName,
    baseBranch: PROVIDER_BASE_BRANCH,
    state: GitHubPRState.Merged,
    createdAt: OPENED_AT,
    mergedAt: MERGED_AT,
    closedAt: MERGED_AT,
    authorLogin: PROVIDER_AUTHOR_LOGIN,
    authorProviderUserId: PROVIDER_AUTHOR_ID,
    authorActorType: GitHubActorType.User,
    isDraft: false,
    headSha: "projected-head",
    baseSha: "base-head",
    mergeCommitSha: "projected-merge",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    headRepository: headRepositoryAuthority(
      fixture,
      RepositoryDefaultSource.PullRequestRest,
      GitHubFetchMechanism.Rest,
      GitHubFetchTrigger.UserAction,
      GitHubFetchCredentialType.UserOAuth
    ),
    ...overrides,
  };
}

export function mockProviderSuccess(
  fixture: WriterFixture,
  overrides: Partial<GitHubSinglePullRequestResult> = {}
): void {
  vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue(
    providerSuccess(fixture, overrides)
  );
}

export function providerSuccess(
  fixture: WriterFixture,
  overrides: Partial<GitHubSinglePullRequestResult> = {}
) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: providerPullRequest(fixture, overrides),
  } as const;
}

export function refreshTombstoned(fixture: WriterFixture, offsetMs: number) {
  return githubServerSyncService.refreshTombstonedBranchPullRequest({
    actorUserId: fixture.userId,
    branchArtifactId: fixture.branchArtifactId,
    organizationId: fixture.organizationId,
    now: new Date(Date.parse("2026-08-12T01:00:00.000Z") + offsetMs),
  });
}

export function deleteFixture(organizationId: string): Promise<void> {
  return withDb.tx(async (db) => {
    await db.artifact.deleteMany({ where: { organizationId } });
    await db.computeTarget.deleteMany({ where: { organizationId } });
    await db.gitHubAccessCapability.deleteMany({ where: { organizationId } });
    await db.gitHubUserConnection.deleteMany({ where: { organizationId } });
    await db.gitHubInstallation.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.delete({ where: { id: organizationId } });
  });
}

/**
 * The user lane reads its token from Clerk (PLN-1742 M5 tail), so a suite that
 * drives it stands up a Clerk that serves one — without it every write under
 * test denies with `no_credential` before reaching the writer it is meant to
 * exercise.
 */
export function wireClerkGitHubToken(): void {
  vi.mocked(clerkClient).mockResolvedValue({
    users: {
      getUserOauthAccessToken: vi.fn().mockResolvedValue({
        data: [
          {
            token: "clerk-user-token",
            scopes: ["repo"],
            externalAccountId: "ext_iss_6421",
          },
        ],
      }),
    },
  } as never);
}

function headRepositoryAuthority(
  fixture: WriterFixture,
  source: RepositoryDefaultSource,
  mechanism: GitHubFetchMechanism,
  trigger: GitHubFetchTrigger,
  credentialType: GitHubFetchCredentialType
) {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: `head-${fixture.repositoryId}`,
      fullName: `fork/${fixture.branchName.replace("/", "-")}`,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "trunk",
    },
    provenance: {
      source,
      mechanism,
      trigger,
      credentialType,
      credentialOwnerId:
        credentialType === GitHubFetchCredentialType.UserOAuth
          ? fixture.userId
          : undefined,
      observationKey: `iss-6421-${mechanism}-${fixture.branchArtifactId}`,
      observedAt: "2026-08-12T00:00:00.000Z",
    },
  });
}

/**
 * The PR's provider id: the seeded row's when the fixture created one, and
 * otherwise a stable id for the row a writer is about to CREATE — the shape the
 * backfill lane is driven in.
 */
function seededOrCreatedGithubId(fixture: WriterFixture): string {
  return (
    fixture.pullRequestGithubId ??
    `iss-6421-created-${fixture.branchArtifactId}`
  );
}
