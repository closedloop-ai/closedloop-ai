import {
  BranchStatus,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { ArtifactType, withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { getTrackedPullRequestState } from "./tracked-pull-requests";

/**
 * ISS-8903 — the REPOSITORY scope on the nested canonical candidate list,
 * against real Postgres: a PR row belonging to a different repo must not be
 * tracked as the branch's own.
 *
 * The unit suite mocks `@repo/database`, so its `artifact.findMany` double returns
 * the same fixtures whatever `where` it is handed — it cannot observe a nested
 * relation predicate at all, which is why these defects survived that file. Here
 * the predicate is executed by Postgres, so the foreign row is excluded by the
 * query or not at all.
 *
 * The seeded shape is the one the schema permits and nothing forbids: PR rows
 * share a `branchArtifactId` — the canonical population's only key — while
 * naming a different repository. The ORGANIZATION axis is no longer seedable
 * here: since ISS-10170 (#7216), `pull_request_detail_branch_artifact_tenant_fkey`
 * refuses a row whose denormalized `organizationId` disagrees with its branch
 * artifact's, so the cross-tenant shape this file used to stage cannot exist
 * and the two cases that staged it were retired. The constraint itself is
 * exercised in `packages/database/__tests__/integration/iss10170-pull-request-detail-branch-tenant-fk.integration.test.ts`;
 * the read keeps its `organizationId` term regardless, for the reason
 * `branchOwnedPullRequestWhere`'s docstring gives.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const BRANCH_REPOSITORY = "acme/widgets";
const FOREIGN_REPOSITORY = "acme/other";
const BRANCH_NAME = "feat/iss-8903";
const OWN_PULL_NUMBER = 11;
const FOREIGN_PULL_NUMBER = 99;
const OWN_PULL_URL = `https://github.com/${BRANCH_REPOSITORY}/pull/${OWN_PULL_NUMBER}`;
const FOREIGN_PULL_URL = `https://github.com/${FOREIGN_REPOSITORY}/pull/${FOREIGN_PULL_NUMBER}`;
const OPENED_AT = new Date("2026-08-01T10:00:00.000Z");
const MERGED_AT = new Date("2026-08-02T10:00:00.000Z");

/**
 * An org, a project, and a BRANCH artifact for {@link BRANCH_REPOSITORY} whose
 * promotion pointer is absent on purpose: the unpromoted shape is what routes
 * the resolution through the owned-set arm, where a foreign row competes.
 *
 * `appBacked` seeds a GitHub App installation repository and puts its surrogate
 * id on the branch, selecting the other arm of `branchOwnedPullRequestWhere`.
 * `repositoryId` can deliberately reuse an existing surrogate to model a
 * malformed branch detail whose tenant differs from the repository owner.
 */
async function seedBranchArtifact(options: {
  appBacked: boolean;
  organizationId?: string;
  projectId?: string;
  repositoryId?: string | null;
}): Promise<{
  organizationId: string;
  projectId: string;
  artifactId: string;
  repositoryId: string | null;
}> {
  const organizationId =
    options.organizationId ?? (await createTestOrganization());
  let projectId = options.projectId;
  if (!projectId) {
    const user = await createTestUser(organizationId);
    projectId = await createTestProject(organizationId, user.id);
  }
  let repositoryId: string | null;
  if (Object.hasOwn(options, "repositoryId")) {
    repositoryId = options.repositoryId ?? null;
  } else if (options.appBacked) {
    repositoryId = await seedInstallationRepository(organizationId);
  } else {
    repositoryId = null;
  }
  const artifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.BRANCH,
        name: BRANCH_NAME,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryId,
        repositoryFullName: normalizeRepoFullName(BRANCH_REPOSITORY),
        branchName: BRANCH_NAME,
        currentPullRequestDetailId: null,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
  return { organizationId, projectId, artifactId, repositoryId };
}

async function seedInstallationRepository(
  organizationId: string
): Promise<string> {
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${organizationId}`,
        accountId: `acct-${organizationId}`,
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: `fixture-${organizationId}`,
              fullName: BRANCH_REPOSITORY,
            }),
            owner: "acme",
            name: "widgets",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repositoryId = installation.repositories[0]?.id;
  if (!repositoryId) {
    throw new Error("failed to seed the App repository");
  }
  return repositoryId;
}

/**
 * The branch's own, MERGED pull request. Terminal on purpose: the canonical
 * arbitration ranks a live fact-carrying row above a terminal one, so every
 * foreign row below out-ranks this one and wins whenever the query fails to
 * exclude it. A case whose own PR were live would pass with no predicate at all.
 */
function ownMergedPullRequest(input: {
  branchArtifactId: string;
  organizationId: string;
  repositoryId: string | null;
}) {
  return {
    ...input,
    repositoryFullName: normalizeRepoFullName(BRANCH_REPOSITORY),
    number: OWN_PULL_NUMBER,
    title: "The branch's own pull request",
    htmlUrl: OWN_PULL_URL,
    prState: GitHubPRState.Merged,
    githubCreatedAt: OPENED_AT,
    mergedAt: MERGED_AT,
    fetchMechanism: GitHubFetchMechanism.Webhook,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
  };
}

describeIfDb("getTrackedPullRequestState repository scope", () => {
  it("tracks the branch's own PR when a foreign live PR shares its branch artifact", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, projectId, artifactId } =
        await seedBranchArtifact({ appBacked: false });
      await withDb((db) =>
        db.pullRequestDetail.createMany({
          data: [
            ownMergedPullRequest({
              branchArtifactId: artifactId,
              organizationId,
              repositoryId: null,
            }),
            {
              branchArtifactId: artifactId,
              organizationId,
              repositoryId: null,
              repositoryFullName: normalizeRepoFullName(FOREIGN_REPOSITORY),
              number: FOREIGN_PULL_NUMBER,
              title: "A live pull request in another repository",
              htmlUrl: FOREIGN_PULL_URL,
              prState: GitHubPRState.Open,
              githubCreatedAt: OPENED_AT,
              fetchMechanism: GitHubFetchMechanism.Webhook,
              additions: 1,
              deletions: 1,
              changedFiles: 1,
            },
          ],
        })
      );

      const result = await getTrackedPullRequestState({
        organizationId,
        projectId,
        repositoryFullName: BRANCH_REPOSITORY,
        repositoryId: null,
      });

      // Unscoped, the foreign live row wins the arbitration and this URL is its
      // own — which the number extractor then discards, emptying `trackedPrNumbers`.
      expect(result.trackedBranches).toHaveLength(1);
      expect(result.trackedBranches[0]?.pullRequestUrl).toBe(OWN_PULL_URL);
      expect(result.trackedPrUrls).toEqual([OWN_PULL_URL]);
      expect(result.trackedPrNumbers).toEqual([OWN_PULL_NUMBER]);
    });
  });

  it("tracks an App-backed branch's own PR while that PR row is still un-adopted", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, projectId, artifactId, repositoryId } =
        await seedBranchArtifact({ appBacked: true });
      // The asymmetry the schema documents: an App-backed BRANCH whose own PR
      // row was written by desktop sync and has not been adopted yet, so it
      // carries no `repositoryId` and is identified by its full name alone.
      await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            branchArtifactId: artifactId,
            organizationId,
            repositoryId: null,
            repositoryFullName: normalizeRepoFullName(BRANCH_REPOSITORY),
            number: OWN_PULL_NUMBER,
            title: "An un-adopted repo-less row for this repository",
            htmlUrl: OWN_PULL_URL,
            prState: GitHubPRState.Open,
            githubCreatedAt: OPENED_AT,
            fetchMechanism: GitHubFetchMechanism.DesktopSync,
            additions: 5,
            deletions: 1,
            changedFiles: 2,
          },
          select: { id: true },
        })
      );

      const result = await getTrackedPullRequestState({
        organizationId,
        projectId,
        repositoryFullName: BRANCH_REPOSITORY,
        repositoryId,
      });

      expect(result.trackedBranches[0]?.pullRequestUrl).toBe(OWN_PULL_URL);
      expect(result.trackedPrNumbers).toEqual([OWN_PULL_NUMBER]);
    });
  });
});
