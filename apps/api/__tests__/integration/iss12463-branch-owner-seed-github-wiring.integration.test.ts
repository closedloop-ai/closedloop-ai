import { randomUUID } from "node:crypto";
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
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  FIRST_PUSHED_AT,
  HAS_DATABASE,
  readAssignee,
  seedBranch,
  seedCommit,
  seedGitHubConnection,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import { refilePullRequestUnderGitHubHead } from "@/app/branches/pull-request-github-head-refile";
import { commitService } from "@/app/commits/commit-service";
import { writeReconciledPullRequest } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { githubBackfillProjectionWriter } from "@/app/integrations/github/backfill-projection-writer";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  backfillInput,
  backfillPullRequest,
  mockProviderSuccess,
  PROVIDER_AUTHOR_LOGIN,
  refreshTombstoned,
  seedWriterFixture,
  wireClerkGitHubToken,
} from "../support/integrations/github/pr-lifecycle-writer.test-fixtures";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";
import { pullRequestEvent } from "./branch-artifact-flow-helpers";
import { seedBranchTestContext } from "./branch-artifact-test-helpers";

/**
 * ISS-12463 / PLN-2192 T-3.2b: each GitHub writer C3 hooks stamps the branch
 * assignee once its own write makes the Owner chain resolve — commit recording
 * (T-1.5) and the five PR-creator writers (T-1.6).
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin that each GitHub writer seeds the branch assignee inside its own write, not the boundary of the transaction that write opens"
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

describe.skipIf(!HAS_DATABASE)("ISS-12463 GitHub owner seed wiring", () => {
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

  it("recording webhook commits seeds the earliest commit author", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const committer = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: committer.id,
        login: "committer",
      });
      const branchId = await seedBranch(organizationId, "commits", {
        firstPushedAt: null,
      });

      await commitService.recordWebhookCommits({
        organizationId,
        repositoryFullName: "acme/commits",
        branchArtifactId: branchId,
        commits: [
          {
            sha: "e".repeat(40),
            authorLogin: "committer",
            committedAt: FIRST_PUSHED_AT,
          },
        ],
      });

      expect(await readAssignee(branchId)).toBe(committer.id);
    });
  });

  it("a push that fills the author of a commit stored on another Branch seeds that Branch", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const committer = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: committer.id,
        login: "committer",
      });
      const storedOn = await seedBranch(organizationId, "stored-on", {
        firstPushedAt: null,
      });
      const pushedTo = await seedBranch(organizationId, "pushed-to", {
        firstPushedAt: null,
      });
      const sha = "d".repeat(40);
      await seedCommit({
        organizationId,
        branchId: storedOn,
        sha,
        authorLogin: null,
        committedAt: FIRST_PUSHED_AT,
      });

      await commitService.recordWebhookCommits({
        organizationId,
        repositoryFullName: `acme/${sha}`,
        branchArtifactId: pushedTo,
        commits: [
          { sha, authorLogin: "committer", committedAt: FIRST_PUSHED_AT },
        ],
      });

      expect(await readAssignee(storedOn)).toBe(committer.id);
    });
  });

  it("the pull_request webhook seeds the PR creator on the Branch it files the PR under", async () => {
    await joinAmbientTransaction(async () => {
      const ctx = await seedBranchTestContext();
      const branchName = "iss-12463-webhook";
      await seedGitHubConnection({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        login: "pr-author",
      });
      const branch = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: ctx.organizationId,
            projectId: ctx.projectId,
            type: ArtifactType.Branch,
            name: branchName,
            status: GitHubPRState.Open,
            branch: {
              create: {
                organizationId: ctx.organizationId,
                repositoryId: ctx.repositoryId,
                repositoryFullName: ctx.repositoryFullName,
                branchName,
                headSha: "pr-head",
                headShaSource: BranchHeadShaSource.PullRequestWebhook,
                checksStatus: ChecksStatus.UNKNOWN,
              },
            },
          },
          select: { id: true },
        })
      );
      const event = pullRequestEvent(ctx, { branchName, headSha: "pr-head" });

      await handlePullRequest({
        ...event,
        pull_request: {
          ...event.pull_request,
          user: { login: "pr-author" },
        },
      } as typeof event);

      expect(await readAssignee(branch.id)).toBe(ctx.userId);
    });
  });

  it("a reconciled PR seeds its creator", async () => {
    await joinAmbientTransaction(async () => {
      const fixture = await seedWriterFixture("reconcile", {
        createPullRequest: true,
      });
      const author = await connectProviderAuthor(fixture.organizationId);

      const wrote = await writeReconciledPullRequest(
        backfillPullRequest(fixture),
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
      expect(await readAssignee(fixture.branchArtifactId)).toBe(author);
    });
  });

  it("a refile seeds the moved PR's creator on its new head Branch", async () => {
    await joinAmbientTransaction(async () => {
      const filing = await seedMisfiledPullRequest();

      const moved = await refilePullRequestUnderGitHubHead(
        filing.organizationId,
        filing.pullRequestId,
        {
          headBranch: REFILE_HEAD,
          headRepository: refileHeadAuthority(),
        }
      );

      expect(moved).toBe(true);
      const head = await withDb((db) =>
        db.pullRequestDetail.findUniqueOrThrow({
          where: { id: filing.pullRequestId },
          select: { branchArtifactId: true },
        })
      );
      expect(head.branchArtifactId).not.toBe(filing.misfiledBranchId);
      expect(await readAssignee(head.branchArtifactId)).toBe(filing.authorId);
    });
  });

  it("the GitHub backfill seeds the Branches it filed PRs under", async () => {
    await joinAmbientTransaction(async () => {
      const fixture = await seedWriterFixture("backfill", {
        createPullRequest: true,
      });
      const author = await connectProviderAuthor(fixture.organizationId);
      // The backfill read carries no author, so the creator is already on the
      // row: evidence that landed while no seeding writer ran.
      await withDb((db) =>
        db.pullRequestDetail.update({
          where: { id: fixture.pullRequestId ?? "" },
          data: { authorLogin: PROVIDER_AUTHOR_LOGIN },
          select: { id: true },
        })
      );
      expect(await readAssignee(fixture.branchArtifactId)).toBeNull();

      await githubBackfillProjectionWriter.write(backfillInput(fixture));

      expect(await readAssignee(fixture.branchArtifactId)).toBe(author);
    });
  });

  it("a user-token refresh of a tombstoned repository's PR seeds its creator", async () => {
    await joinAmbientTransaction(async () => {
      const fixture = await seedWriterFixture("user-refresh", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      const author = await connectProviderAuthor(fixture.organizationId);
      mockProviderSuccess(fixture);

      await refreshTombstoned(fixture, 0);

      expect(await readAssignee(fixture.branchArtifactId)).toBe(author);
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

/** A PR whose creator is connected, filed under a Branch other than its GitHub head. */
async function seedMisfiledPullRequest(): Promise<{
  organizationId: string;
  authorId: string;
  misfiledBranchId: string;
  pullRequestId: string;
}> {
  const organizationId = await createTestOrganization();
  const author = await createTestUser(organizationId);
  await seedGitHubConnection({
    organizationId,
    userId: author.id,
    login: "refiled",
  });
  return await withDb(async (db) => {
    await db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: REFILE_REPOSITORY_GITHUB_ID,
          fullName: REFILE_REPOSITORY,
        }),
        owner: "acme",
        name: "iss-12463",
        htmlUrl: `https://github.com/${REFILE_REPOSITORY}`,
      },
      select: { id: true },
    });
    const misfiled = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Branch,
        name: "feat/misfiled",
        status: GitHubPRState.Open,
        branch: {
          create: {
            organizationId,
            repositoryFullName: REFILE_REPOSITORY,
            branchName: "feat/misfiled",
          },
        },
      },
      select: { id: true },
    });
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        branchArtifactId: misfiled.id,
        organizationId,
        repositoryFullName: REFILE_REPOSITORY,
        number: 12_463,
        githubId: `iss12463-${randomUUID()}`,
        prState: GitHubPRState.Merged,
        authorLogin: "refiled",
        desktopOriginated: true,
        fetchMechanism: GitHubFetchMechanism.DesktopSync,
      },
      select: { id: true },
    });
    return {
      organizationId,
      authorId: author.id,
      misfiledBranchId: misfiled.id,
      pullRequestId: pullRequest.id,
    };
  });
}

function refileHeadAuthority() {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: REFILE_REPOSITORY_GITHUB_ID,
      fullName: REFILE_REPOSITORY,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source: RepositoryDefaultSource.PullRequestGraphql,
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.Backfill,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: `graphql-${randomUUID()}`,
      observedAt: "2026-10-16T12:00:00.000Z",
    },
  });
}

const REFILE_REPOSITORY = "acme/iss-12463";
const REFILE_REPOSITORY_GITHUB_ID = "12463";
const REFILE_HEAD = "feat/github-head";
