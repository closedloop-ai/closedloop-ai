import {
  ArtifactType,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { GitHubCredentialKind } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { ChecksStatus, withDb } from "@repo/database";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_DATABASE,
  readAssignee,
  seedGitHubConnection,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import { writeReconciledPullRequest } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  backfillPullRequest,
  mockProviderSuccess,
  PROVIDER_AUTHOR_LOGIN,
  refreshTombstoned,
  seedWriterFixture,
  type WriterFixture,
  wireClerkGitHubToken,
} from "../support/integrations/github/pr-lifecycle-writer.test-fixtures";
import {
  autoRollbackTransactionJoining,
  createTestUser,
} from "../utils/db-helpers";
import { pullRequestEvent } from "./branch-artifact-flow-helpers";
import { seedBranchTestContext } from "./branch-artifact-test-helpers";

/**
 * ISS-12463 (PR #8916 review): the owner seed is set-if-NULL, so its first
 * stamp is final. A write that lands a PR's creator while the PR is filed under
 * a Branch other than its GitHub head must not stamp that Branch; the refile
 * that moves the PR seeds the head Branch instead.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin which Branch each GitHub writer seeds inside its own write, not the boundary of the transaction that write opens"
);

const mocks = vi.hoisted(() => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
  publishDirtyScopes: vi.fn().mockResolvedValue(undefined),
  reconcileLabels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: mocks.parseArtifactReferences,
}));

vi.mock(
  "@/app/webhooks/github/handlers/pull-request-label-reconciliation",
  () => ({
    reconcilePullRequestLabelsForWebhook: mocks.reconcileLabels,
  })
);

vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: mocks.publishDirtyScopes,
}));

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

describe.skipIf(!HAS_DATABASE)("ISS-12463 misfiled PR owner seed", () => {
  beforeEach(() => {
    wireClerkGitHubToken();
    vi.mocked(getUserTokenOctokit).mockReturnValue({
      rest: {
        users: {
          getAuthenticated: vi
            .fn()
            .mockResolvedValue({ data: { id: 12_463, login: "iss-12463" } }),
        },
      },
    } as never);
  });

  it("a reconciled misfiled PR seeds its GitHub head Branch, not the Branch it leaves", async () => {
    await joinAmbientTransaction(async () => {
      const fixture = await seedWriterFixture("reconcile-misfiled", {
        createPullRequest: true,
      });
      const author = await connectProviderAuthor(fixture.organizationId);

      const wrote = await writeReconciledPullRequest(
        backfillPullRequest(fixture, {
          headBranch: GITHUB_HEAD,
          headRepository: ownRepositoryHead(
            fixture,
            await readGitHubRepoId(fixture),
            RepositoryDefaultSource.PullRequestGraphql,
            GitHubFetchMechanism.Graphql,
            GitHubFetchCredentialType.GitHubApp
          ),
        }),
        {
          organizationId: fixture.organizationId,
          repositoryId: fixture.repositoryId,
          repositoryFullName: fixture.repositoryFullName,
          credentialKind: GitHubCredentialKind.Installation,
          credentialOwnerId: null,
          now: new Date("2026-08-12T01:00:00.000Z"),
        }
      );

      expect(wrote).toBe(true);
      expect(await readSeedOutcome(fixture)).toEqual({
        filedUnder: GITHUB_HEAD,
        leftBranchAssignee: null,
        headBranchAssignee: author,
      });
    });
  });

  it("a user-token refresh of a misfiled tombstoned PR seeds its GitHub head Branch, not the Branch it leaves", async () => {
    await joinAmbientTransaction(async () => {
      const fixture = await seedWriterFixture("user-refresh-misfiled", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      const author = await connectProviderAuthor(fixture.organizationId);
      mockProviderSuccess(fixture, {
        headBranch: GITHUB_HEAD,
        headRepository: ownRepositoryHead(
          fixture,
          await readGitHubRepoId(fixture),
          RepositoryDefaultSource.PullRequestRest,
          GitHubFetchMechanism.Rest,
          GitHubFetchCredentialType.UserOAuth
        ),
      });

      await refreshTombstoned(fixture, 0);

      expect(await readSeedOutcome(fixture)).toEqual({
        filedUnder: GITHUB_HEAD,
        leftBranchAssignee: null,
        headBranchAssignee: author,
      });
    });
  });

  it("a pull_request delivery whose head Branch does not exist yet leaves the misfiled Branch unseeded", async () => {
    await joinAmbientTransaction(async () => {
      const ctx = await seedBranchTestContext();
      await seedGitHubConnection({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        login: "pr-author",
      });
      const misfiledName = "iss-12463-misfiled";
      const misfiled = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: ctx.organizationId,
            projectId: ctx.projectId,
            type: ArtifactType.Branch,
            name: misfiledName,
            status: GitHubPRState.Open,
            branch: {
              create: {
                organizationId: ctx.organizationId,
                repositoryId: ctx.repositoryId,
                repositoryFullName: ctx.repositoryFullName,
                branchName: misfiledName,
                headSha: "pr-head",
                headShaSource: BranchHeadShaSource.PullRequestWebhook,
                checksStatus: ChecksStatus.UNKNOWN,
              },
            },
          },
          select: { id: true },
        })
      );
      const event = pullRequestEvent(ctx, {
        branchName: GITHUB_HEAD,
        headSha: "pr-head",
      });
      await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: ctx.organizationId,
            branchArtifactId: misfiled.id,
            repositoryId: ctx.repositoryId,
            repositoryFullName: ctx.repositoryFullName,
            number: event.pull_request.number,
            githubId: String(event.pull_request.id),
            htmlUrl: event.pull_request.html_url,
            prState: GitHubPRState.Open,
            isCurrent: true,
            authorLogin: "pr-author",
          },
          select: { id: true },
        })
      );

      await handlePullRequest({
        ...event,
        pull_request: {
          ...event.pull_request,
          user: { login: "pr-author" },
        },
      } as typeof event);

      expect(
        await readFiledBranch(ctx.repositoryId, event.pull_request.number)
      ).toBe(misfiled.id);
      expect(await readAssignee(misfiled.id)).toBeNull();
    });
  });
});

/** A second org member whose GitHub login is the provider fixtures' PR author. */
async function connectProviderAuthor(organizationId: string): Promise<string> {
  const author = await createTestUser(organizationId);
  await seedGitHubConnection({
    organizationId,
    userId: author.id,
    login: PROVIDER_AUTHOR_LOGIN,
  });
  return author.id;
}

/** Where the fixture's PR sits now, and who each Branch involved is assigned to. */
async function readSeedOutcome(fixture: WriterFixture) {
  const filed = await withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id: fixture.pullRequestId ?? "" },
      select: {
        branchArtifactId: true,
        branchArtifact: {
          select: { branch: { select: { branchName: true } } },
        },
      },
    })
  );
  return {
    filedUnder: filed.branchArtifact.branch?.branchName,
    leftBranchAssignee: await readAssignee(fixture.branchArtifactId),
    headBranchAssignee: await readAssignee(filed.branchArtifactId),
  };
}

async function readFiledBranch(
  repositoryId: string,
  number: number
): Promise<string> {
  const filed = await withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { repositoryId_number: { repositoryId, number } },
      select: { branchArtifactId: true },
    })
  );
  return filed.branchArtifactId;
}

async function readGitHubRepoId(fixture: WriterFixture): Promise<string> {
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findUniqueOrThrow({
      where: { id: fixture.repositoryId },
      select: { githubRepoId: true },
    })
  );
  return repository.githubRepoId;
}

/** GitHub's head reported in the PR's own repository, so the head is confirmed. */
function ownRepositoryHead(
  fixture: WriterFixture,
  providerRepositoryId: string,
  source: RepositoryDefaultSource,
  mechanism: GitHubFetchMechanism,
  credentialType: GitHubFetchCredentialType
) {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName: fixture.repositoryFullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source,
      mechanism,
      trigger: GitHubFetchTrigger.Backfill,
      credentialType,
      credentialOwnerId:
        credentialType === GitHubFetchCredentialType.UserOAuth
          ? fixture.userId
          : undefined,
      observationKey: `iss-12463-${mechanism}-${fixture.branchArtifactId}`,
      observedAt: "2026-08-12T00:00:00.000Z",
    },
  });
}

const GITHUB_HEAD = "feature/iss-12463-github-head";
