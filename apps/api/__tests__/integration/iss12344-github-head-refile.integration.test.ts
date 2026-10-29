/**
 * ISS-12344 against a real Postgres. Decision record: ISS-12344 comment thread
 * th_1__bTDiF9jNPx9ebLHmn0 (Perrin Upcott, 2026-10-09, "Move it").
 *
 * One command opened two PRs and the desktop filed both under the command's
 * one head. A GitHub read reporting each PR's own head moves it under that
 * head's Branch, creating the Branch through the desktop lane's own
 * materializer and moving the PR with the ISS-6980 relink. The reconcile case
 * drives the production reconciler write, not the helper.
 */
import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { GitHubCredentialKind } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { refilePullRequestUnderGitHubHead } from "@/app/branches/pull-request-github-head-refile";
import { writeReconciledPullRequest } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { createTestOrganization } from "../utils/db-helpers";

const REPOSITORY_FULL_NAME = "acme/iss-12344";
/** One provider id for every authority source, so they agree on identity. */
const REPOSITORY_GITHUB_ID = "12344";
const COMMAND_HEAD = "feat/collaborative-artifacts";
const OTHER_REPOSITORY_FULL_NAME = "acme/iss-12344-other";
const createdOrganizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12344 GitHub-head refile (real Postgres)",
  () => {
    afterEach(async () => {
      for (const organizationId of createdOrganizationIds.splice(0)) {
        await withDb(async (db) => {
          await db.artifact.deleteMany({ where: { organizationId } });
          await db.publicRepository.deleteMany({ where: { organizationId } });
          await db.organization.delete({ where: { id: organizationId } });
        });
      }
    });

    it("moves each of two PRs one command filed under one Branch to its own new head Branch", async () => {
      const fixture = await seedCommandFiling();

      await refilePullRequestUnderGitHubHead(
        fixture.organizationId,
        fixture.pullRequestIds[0],
        read("fix/incremental-reindex-batched-deletes", REPOSITORY_FULL_NAME)
      );
      await refilePullRequestUnderGitHubHead(
        fixture.organizationId,
        fixture.pullRequestIds[1],
        read("fix/search-reads-during-reindex", REPOSITORY_FULL_NAME)
      );

      const filed = await filedBranches(fixture.organizationId);
      expect(filed).toEqual([
        {
          number: 26,
          branchName: "fix/incremental-reindex-batched-deletes",
          projectId: null,
        },
        {
          number: 27,
          branchName: "fix/search-reads-during-reindex",
          projectId: null,
        },
      ]);
      const commandBranch = await withDb((db) =>
        db.branchDetail.findUniqueOrThrow({
          where: { artifactId: fixture.commandBranchArtifactId },
          select: { currentPullRequestDetailId: true },
        })
      );
      // The relink clears the pointer that named a PR it moved away.
      expect(commandBranch.currentPullRequestDetailId).toBeNull();
    });

    it("leaves a PR whose GitHub head lives in a fork where it is", async () => {
      const fixture = await seedCommandFiling();

      await refilePullRequestUnderGitHubHead(
        fixture.organizationId,
        fixture.pullRequestIds[0],
        read("read-config-gypi", "contributor/iss-12344")
      );

      const [first] = await filedBranches(fixture.organizationId);
      expect(first?.branchName).toBe(COMMAND_HEAD);
      await expect(branchCount(fixture.organizationId)).resolves.toBe(1);
    });

    it("moves a PR when the reconciler's GitHub read reports a different head", async () => {
      const fixture = await seedCommandFiling();

      const wrote = await writeReconciledPullRequest(
        readModelPullRequest(26, "fix/incremental-reindex-batched-deletes"),
        {
          organizationId: fixture.organizationId,
          repositoryId: null,
          repositoryFullName: REPOSITORY_FULL_NAME,
          credentialKind: GitHubCredentialKind.Installation,
          credentialOwnerId: null,
          now: new Date("2026-10-09T21:00:00.000Z"),
        }
      );

      expect(wrote).toBe(true);
      const [first, second] = await filedBranches(fixture.organizationId);
      expect(first?.branchName).toBe("fix/incremental-reindex-batched-deletes");
      expect(second?.branchName).toBe(COMMAND_HEAD);
    });

    // ISS-12344 review (PR #8704): a same-named Branch of another repository
    // is not the PR's head Branch, and the reconciler's own gate must see that.
    it("moves a PR the reconciler finds under a same-named Branch of another repository", async () => {
      const fixture = await seedCommandFiling(OTHER_REPOSITORY_FULL_NAME);

      await writeReconciledPullRequest(
        readModelPullRequest(26, COMMAND_HEAD),
        reconcileContext(fixture.organizationId)
      );

      const pullRequest = await withDb((db) =>
        db.pullRequestDetail.findUniqueOrThrow({
          where: { id: fixture.pullRequestIds[0] },
          select: {
            branchArtifact: {
              select: {
                branch: {
                  select: { branchName: true, repositoryFullName: true },
                },
              },
            },
          },
        })
      );
      expect(pullRequest.branchArtifact.branch).toEqual({
        branchName: COMMAND_HEAD,
        repositoryFullName: REPOSITORY_FULL_NAME,
      });
    });

    // ISS-12344 review (PR #8704): the reconciler read head A and committed,
    // then a newer webhook relinked the PR. The move that follows holds the
    // older read and must leave the PR where the newer read filed it.
    it("leaves the PR where it is when the stored row is newer than the caller's read", async () => {
      const fixture = await seedCommandFiling();
      await withDb((db) =>
        db.pullRequestDetail.update({
          where: { id: fixture.pullRequestIds[0] },
          data: { githubUpdatedAt: new Date("2026-10-09T21:05:00.000Z") },
          select: { id: true },
        })
      );

      const moved = await refilePullRequestUnderGitHubHead(
        fixture.organizationId,
        fixture.pullRequestIds[0],
        {
          ...read("fix/original-head", REPOSITORY_FULL_NAME),
          updatedAt: "2026-10-09T21:00:00.000Z",
        }
      );

      expect(moved).toBe(false);
      const [first] = await filedBranches(fixture.organizationId);
      expect(first?.branchName).toBe(COMMAND_HEAD);
      await expect(branchCount(fixture.organizationId)).resolves.toBe(1);
    });
  }
);

function reconcileContext(organizationId: string) {
  return {
    organizationId,
    repositoryId: null,
    repositoryFullName: REPOSITORY_FULL_NAME,
    credentialKind: GitHubCredentialKind.Installation,
    credentialOwnerId: null,
    now: new Date("2026-10-09T21:00:00.000Z"),
  };
}

/** `commandBranchRepository` is the repository of the Branch both PRs sit under. */
async function seedCommandFiling(
  commandBranchRepository = REPOSITORY_FULL_NAME
): Promise<{
  organizationId: string;
  commandBranchArtifactId: string;
  pullRequestIds: [string, string];
}> {
  const organizationId = await createTestOrganization();
  createdOrganizationIds.push(organizationId);
  return await withDb(async (db) => {
    await db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: REPOSITORY_GITHUB_ID,
          fullName: REPOSITORY_FULL_NAME,
        }),
        owner: "acme",
        name: "iss-12344",
        htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}`,
      },
      select: { id: true },
    });
    const commandBranch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Branch,
        name: COMMAND_HEAD,
        status: GitHubPRState.Open,
        branch: {
          create: {
            organizationId,
            repositoryFullName: commandBranchRepository,
            branchName: COMMAND_HEAD,
          },
        },
      },
      select: { id: true },
    });
    const pullRequestIds: string[] = [];
    for (const number of [26, 27]) {
      const row = await db.pullRequestDetail.create({
        data: {
          branchArtifactId: commandBranch.id,
          organizationId,
          repositoryFullName: REPOSITORY_FULL_NAME,
          number,
          githubId: `iss12344-${number}-${randomUUID()}`,
          prState: GitHubPRState.Merged,
          desktopOriginated: true,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
        },
        select: { id: true },
      });
      pullRequestIds.push(row.id);
    }
    await db.branchDetail.update({
      where: { artifactId: commandBranch.id },
      data: { currentPullRequestDetailId: pullRequestIds[1] },
      select: { artifactId: true },
    });
    return {
      organizationId,
      commandBranchArtifactId: commandBranch.id,
      pullRequestIds: [pullRequestIds[0], pullRequestIds[1]],
    };
  });
}

function filedBranches(organizationId: string) {
  return withDb(async (db) => {
    const rows = await db.pullRequestDetail.findMany({
      where: { organizationId },
      orderBy: { number: "asc" },
      select: {
        number: true,
        branchArtifact: {
          select: { projectId: true, branch: { select: { branchName: true } } },
        },
      },
    });
    return rows.map((row) => ({
      number: row.number,
      branchName: row.branchArtifact.branch?.branchName,
      projectId: row.branchArtifact.projectId,
    }));
  });
}

function branchCount(organizationId: string): Promise<number> {
  return withDb((db) => db.branchDetail.count({ where: { organizationId } }));
}

function read(headBranch: string, headRepositoryFullName: string) {
  return { headBranch, headRepository: headAuthority(headRepositoryFullName) };
}

function headAuthority(fullName: string) {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: REPOSITORY_GITHUB_ID,
      fullName,
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
      observedAt: "2026-10-09T21:00:00.000Z",
    },
  });
}

function readModelPullRequest(
  number: number,
  headBranch: string
): GitHubReadModelPullRequest {
  return {
    githubId: `gh-${number}`,
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${number}`,
    headBranch,
    baseBranch: "main",
    headSha: `oid-${number}`,
    state: GitHubPRState.Merged,
    isDraft: false,
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-09-19T00:52:27.000Z",
    closedAt: "2026-09-19T13:53:29.000Z",
    mergedAt: "2026-09-19T13:53:29.000Z",
    mergeCommitSha: null,
    updatedAt: "2026-09-19T13:53:29.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
    headRepository: headAuthority(REPOSITORY_FULL_NAME),
  };
}
