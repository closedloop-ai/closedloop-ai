/**
 * ISS-7721 M2 + M3 regression fixture, retained after PRD-683 P0-C retired the
 * observed-repository fallback from post-connect backfill.
 *
 * The unit suites mock the database, so every repo-less predicate in this lane
 * is only as true as a `where` object a double accepted. That is the exact
 * shape of the bug this milestone fixes: the query ran, matched nothing, and
 * reported a zero that read as "this org has no repositories". Here the
 * candidate selection, the self-heal target discovery, and the projection write
 * are all the real thing, and only GitHub is faked.
 *
 * Reintroducing the observed fallback fails this on `repositoryCount` and the
 * provider call assertions below.
 */
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubProviderBudgetState,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  getRepositoryBranches: vi.fn(),
  getRepositoryPullRequestsWithMetadata: vi.fn(),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
  listPullRequestIssueCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewsWithProviderResult: vi.fn(),
  queryStatusCheckRollupWithProviderResult: vi.fn(),
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));

import {
  GitHubProviderResultStatus,
  getRepositoryBranches,
  getRepositoryPullRequestsWithMetadata,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviewsWithProviderResult,
  queryBundledPullRequestsWithProviderResult,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import { githubBackfillService } from "@/app/integrations/github/backfill-service";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const asMock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

const REPOSITORY = "acme/oauth-only";
const OWNER = "acme";
const NAME = "oauth-only";
const HEAD_BRANCH = "feat/installation-free";
const PULL_NUMBER = 7;
const PROVIDER_TITLE = "Backfilled through the pool lane";
const UPDATED_AT = new Date("2026-08-25T11:00:00.000Z");

function providerPullRequest() {
  return {
    githubId: "PR_installation_free_backfill",
    number: PULL_NUMBER,
    title: PROVIDER_TITLE,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}`,
    headBranch: HEAD_BRANCH,
    baseBranch: "main",
    headSha: "head-sha-7",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: UPDATED_AT.toISOString(),
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: UPDATED_AT.toISOString(),
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

async function seedInstallationFreeOrg(credentialOwnerId: string) {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId, {
    id: credentialOwnerId,
  });
  await withDb((db) =>
    db.gitHubObservedRepository.create({
      data: {
        organizationId,
        repositoryFullName: REPOSITORY,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
        owner: OWNER,
        name: NAME,
        githubRepoId: "606060",
        isPrivate: true,
      },
    })
  );
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: HEAD_BRANCH,
        status: GitHubPRState.Open,
        branch: {
          create: {
            organizationId,
            // The repo-less identity: no installation-repo surrogate exists
            // for this org, so every predicate must key on the full name.
            repositoryFullName: REPOSITORY,
            branchName: HEAD_BRANCH,
          },
        },
        pullRequestDetails: {
          create: {
            organizationId,
            repositoryFullName: REPOSITORY,
            githubId: "PR_installation_free_backfill",
            number: PULL_NUMBER,
            title: "Stale title from genesis",
            htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}`,
            prState: GitHubPRState.Open,
            isCurrent: true,
          },
        },
      },
      select: {
        id: true,
        pullRequestDetails: { select: { id: true } },
      },
    })
  );
  const pullRequestDetailId = artifact.pullRequestDetails[0]?.id ?? "";
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: artifact.id },
      data: { currentPullRequestDetailId: pullRequestDetailId },
      select: { artifactId: true },
    })
  );
  return { organizationId, pullRequestDetailId, userId: user.id };
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getRepositoryBranches).mockResolvedValue([{ name: "main" }]);
  asMock(getRepositoryPullRequestsWithMetadata).mockResolvedValue({
    pullRequests: [providerPullRequest()],
    hasMore: false,
    truncated: false,
    pageInfo: null,
    stopReason: null,
    missingTargetNumbers: [],
  });
  asMock(queryBundledPullRequestsWithProviderResult).mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests: [providerPullRequest()],
      rateLimit: {
        cost: 1,
        remaining: 4000,
        resetAt: null,
        state: GitHubProviderBudgetState.Available,
      },
    },
  });
  const emptyList = { status: GitHubProviderResultStatus.Success, value: [] };
  asMock(listPullRequestIssueCommentsWithProviderResult).mockResolvedValue(
    emptyList
  );
  asMock(listPullRequestReviewCommentsWithProviderResult).mockResolvedValue(
    emptyList
  );
  asMock(listPullRequestReviewsWithProviderResult).mockResolvedValue(emptyList);
  asMock(queryStatusCheckRollupWithProviderResult).mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: null,
  });
});

describeIfDb("backfill on an installation-free org", () => {
  it("does not fall back to verified observations after the observed lane is retired", async () => {
    await autoRollbackTransaction(
      async () => {
        const credentialOwnerId = "6f0f1f6e-2b1a-4c3d-9e8f-1a2b3c4d5e6f";
        const { organizationId, pullRequestDetailId } =
          await seedInstallationFreeOrg(credentialOwnerId);
        asMock(getGitHubSyncClient).mockResolvedValue({
          ok: true,
          value: {
            octokit: { marker: "pooled" },
            kind: GitHubCredentialKind.OauthUser,
            actingAs: { githubUserId: "gh-1", login: "octocat" },
            credentialOwnerId,
            rateLimitTier: null,
            recordRateLimit: vi.fn().mockResolvedValue(undefined),
            recordRepoAccess: vi.fn().mockResolvedValue(undefined),
          },
        });

        const summary = await githubBackfillService.runPostConnectBackfill({
          organizationId,
          approvedForVisibleWrites: true,
        });

        expect(summary.repositoryCount).toBe(0);
        expect(summary.branchCount).toBe(0);
        expect(summary.pullRequestCount).toBe(0);
        expect(summary.failures).toEqual([]);
        expect(getGitHubSyncClient).not.toHaveBeenCalled();
        expect(
          queryBundledPullRequestsWithProviderResult
        ).not.toHaveBeenCalled();

        const persisted = await withDb((db) =>
          db.pullRequestDetail.findUniqueOrThrow({
            where: { id: pullRequestDetailId },
            select: {
              title: true,
              repositoryId: true,
              repositoryFullName: true,
              fetchCredentialType: true,
              fetchCredentialOwnerId: true,
            },
          })
        );
        expect(persisted).toEqual({
          title: "Stale title from genesis",
          repositoryId: null,
          repositoryFullName: REPOSITORY,
          fetchCredentialType: null,
          fetchCredentialOwnerId: null,
        });
      },
      { maxWait: 5000, timeout: 20_000 }
    );
  });
});
