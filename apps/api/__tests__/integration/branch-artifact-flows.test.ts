// biome-ignore-all lint/suspicious/noMisplacedAssertion: Integration helpers assert from callbacks invoked by tests.
import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  BranchHeadShaSource,
  BranchPushSource,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import {
  BranchCommentsState,
  BranchDataState,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { BranchViewSyncErrorCode } from "@repo/api/src/types/branch-view";
import { DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState as ApiGitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactType,
  ReviewDecision as DbReviewDecision,
  GitHubInstallationStatus,
  GitHubPRState,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import type * as GitHubModule from "@repo/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postPullRequestAlias } from "@/app/artifact-links/pull-requests/route";
import { branchCommentsService } from "@/app/branches/branch-comments-service";
import { stampBranchFirstPush } from "@/app/branches/branch-push-state";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchService } from "@/app/branches/branch-service";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import { githubService } from "@/app/integrations/github/service";
import {
  comparedFilesMock,
  SINGLE_FILE_COMPARE_MOCK,
} from "../helpers/github-provider-result-mock";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
  linkValidSessionToBranch,
} from "../utils/db-helpers";
import {
  expectSuccess,
  flushPendingPromises,
  handlePushWithTestObservation as handlePush,
  persistedSidecarAuthority,
  routeContext,
  seedBranchWithCurrentPr,
  withFixtureHeadAuthority,
} from "./branch-artifact-flow-helpers";
import {
  createCommittedBranchTestRunner,
  findBranchArtifact,
  makeGrantedClaimDeps,
  pushEvent,
  seedBranchTestContext,
  stampBranchSessionPushes,
  type TestContext,
} from "./branch-artifact-test-helpers";

const {
  authState,
  mockCompareBranchFileChanges,
  mockEncryptTokenPair,
  mockGetInstallationOctokit,
  mockGetSinglePullRequest,
  mockListPullRequestIssueComments,
  mockListPullRequestReviewComments,
  mockListPullRequestReviews,
  mockOctokit,
  mockParseArtifactReferences,
  mockQueryStatusCheckRollup,
  waitUntilState,
} = vi.hoisted(() => ({
  authState: {
    user: { id: "user-1", organizationId: "org-1" },
  },
  mockCompareBranchFileChanges: vi.fn(),
  mockEncryptTokenPair: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
  mockGetSinglePullRequest: vi.fn(),
  mockListPullRequestIssueComments: vi.fn(),
  mockListPullRequestReviewComments: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
  mockParseArtifactReferences: vi.fn(),
  mockQueryStatusCheckRollup: vi.fn(),
  waitUntilState: {
    promises: [] as Promise<unknown>[],
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: { params?: Promise<Record<string, string>> }) =>
      handler(
        { user: authState.user },
        request,
        context?.params ?? Promise.resolve({})
      ),
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  const { toGitHubProviderResultMock, toSuccessfulGitHubProviderResultMock } =
    await import("../helpers/github-provider-result-mock");

  return {
    ...actual,
    compareBranchFileChangesWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockCompareBranchFileChanges(...args)),
    getSinglePullRequestWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(
        withFixtureHeadAuthority(
          await mockGetSinglePullRequest(...args),
          currentTestContext
        )
      ),
    getSinglePullRequest: async (...args: unknown[]) =>
      withFixtureHeadAuthority(
        await mockGetSinglePullRequest(...args),
        currentTestContext
      ),
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    listPullRequestIssueCommentsWithProviderResult: async (
      ...args: unknown[]
    ) =>
      toGitHubProviderResultMock(
        await mockListPullRequestIssueComments(...args)
      ),
    listPullRequestReviewCommentsWithProviderResult: async (
      ...args: unknown[]
    ) =>
      toGitHubProviderResultMock(
        await mockListPullRequestReviewComments(...args)
      ),
    listPullRequestReviewsWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockListPullRequestReviews(...args)),
    queryStatusCheckRollupWithProviderResult: async (...args: unknown[]) =>
      toSuccessfulGitHubProviderResultMock(
        await mockQueryStatusCheckRollup(...args)
      ),
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so restore/reset passes can
  // never strip the marker client the services thread into @repo/github reads.
  // The spy's result is awaited so a test can inject a mint rejection with
  // mockRejectedValueOnce; its resolved value is otherwise ignored and the
  // marker client is always returned.
  getInstallationOctokit: async (installationId: string) => {
    await mockGetInstallationOctokit(installationId);
    return mockOctokit;
  },
}));

vi.mock("@repo/github/keys", () => ({
  keys: vi.fn(() => ({
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  })),
}));

vi.mock("@/lib/integration-encryption", () => ({
  encryptTokenPair: mockEncryptTokenPair,
}));

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: mockParseArtifactReferences,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilState.promises.push(Promise.resolve(promise));
  },
}));

let currentTestContext: TestContext | undefined;
const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const flushWaitUntil = () => flushPendingPromises(waitUntilState.promises);
const runCommittedBranchTest = createCommittedBranchTestRunner(
  setupContext,
  flushWaitUntil
);

function setupContext(): Promise<TestContext> {
  return seedBranchTestContext((ctx) => {
    currentTestContext = ctx;
    authState.user = { id: ctx.userId, organizationId: ctx.organizationId };
    mockParseArtifactReferences.mockReturnValue([
      {
        slug: "FEA-1116",
        docType: DocumentType.Feature,
        prefix: "FEA",
        matchType: "slug",
        source: "branch",
      },
    ]);
  });
}

describe.skipIf(!hasDatabase)("branch artifact API integration flows", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    waitUntilState.promises = [];
    mockCompareBranchFileChanges.mockResolvedValue(comparedFilesMock());
    mockEncryptTokenPair.mockResolvedValue({
      encryptedAccessToken: "encrypted-access-token",
      encryptedRefreshToken: "encrypted-refresh-token",
    });
    mockGetSinglePullRequest.mockResolvedValue(null);
    mockListPullRequestIssueComments.mockResolvedValue([]);
    mockListPullRequestReviewComments.mockResolvedValue([]);
    mockListPullRequestReviews.mockResolvedValue([]);
    mockQueryStatusCheckRollup.mockResolvedValue({
      ok: true,
      state: null,
      checks: [],
      totalCount: 0,
      truncated: false,
    });
  });

  it.each([
    ["completed", BranchSyncStatus.Fresh, null],
    ["failed", BranchSyncStatus.Failed, BranchViewSyncErrorCode.PrSyncFailed],
  ] as const)(
    "does not let a standalone stale late file-cache failure overwrite a newer %s sync",
    async (_name, newerStatus, newerErrorCode) => {
      await autoRollbackTransaction(async () => {
        const ctx = await setupContext();
        const seeded = await seedBranchWithCurrentPr(ctx, {
          branchName: `FEA-1479-standalone-stale-${_name}`,
        });
        await withDb((db) =>
          db.branchDetail.update({
            where: { artifactId: seeded.artifactId },
            data: {
              lastSyncStartedAt: new Date(Date.now() - 6000),
              syncStatus: BranchSyncStatus.Fresh,
            },
          })
        );
        const supersedingStartedAt = new Date(Date.now() + 1000);
        const supersedingCompletedAt = new Date(Date.now() + 2000);
        const supersedingErrorMessage = newerErrorCode
          ? "newer standalone failure wins"
          : null;
        mockCompareBranchFileChanges.mockImplementationOnce(async () => {
          await withDb((db) =>
            db.branchDetail.update({
              where: { artifactId: seeded.artifactId },
              data: {
                lastSyncCompletedAt: supersedingCompletedAt,
                lastSyncErrorCode: newerErrorCode,
                lastSyncErrorMessage: supersedingErrorMessage,
                lastSyncStartedAt: supersedingStartedAt,
                syncStatus: newerStatus,
              },
            })
          );
          return null;
        });

        const result = await refreshBranchFileChangeCache(seeded.artifactId, {
          organizationId: ctx.organizationId,
        });
        const branch = await withDb((db) =>
          db.branchDetail.findUnique({
            where: { artifactId: seeded.artifactId },
          })
        );

        expect(result).toEqual({ ok: false, error: 500 });
        expect(branch).toMatchObject({
          lastSyncCompletedAt: supersedingCompletedAt,
          lastSyncErrorCode: newerErrorCode,
          lastSyncErrorMessage: supersedingErrorMessage,
          lastSyncStartedAt: supersedingStartedAt,
          syncStatus: newerStatus,
        });
      });
    }
  );

  it.each([
    ["completed", BranchSyncStatus.Fresh, null],
    ["failed", BranchSyncStatus.Failed, BranchViewSyncErrorCode.PrSyncFailed],
  ] as const)(
    "does not let a standalone stale late file-cache success overwrite a newer %s sync",
    async (_name, newerStatus, newerErrorCode) => {
      await autoRollbackTransaction(async () => {
        const ctx = await setupContext();
        const seeded = await seedBranchWithCurrentPr(ctx, {
          branchName: `FEA-1479-standalone-stale-success-${_name}`,
        });
        await withDb((db) =>
          db.branchDetail.update({
            where: { artifactId: seeded.artifactId },
            data: {
              lastSyncStartedAt: new Date(Date.now() - 6000),
              syncStatus: BranchSyncStatus.Fresh,
            },
          })
        );
        const supersedingStartedAt = new Date(Date.now() + 1000);
        const supersedingCompletedAt = new Date(Date.now() + 2000);
        const supersedingErrorMessage = newerErrorCode
          ? "newer standalone success race failure wins"
          : null;
        mockCompareBranchFileChanges.mockImplementationOnce(async () => {
          await withDb((db) =>
            db.branchDetail.update({
              where: { artifactId: seeded.artifactId },
              data: {
                lastSyncCompletedAt: supersedingCompletedAt,
                lastSyncErrorCode: newerErrorCode,
                lastSyncErrorMessage: supersedingErrorMessage,
                lastSyncStartedAt: supersedingStartedAt,
                syncStatus: newerStatus,
              },
            })
          );
          return SINGLE_FILE_COMPARE_MOCK;
        });

        const result = await refreshBranchFileChangeCache(seeded.artifactId, {
          organizationId: ctx.organizationId,
        });
        const branch = await withDb((db) =>
          db.branchDetail.findUnique({
            where: { artifactId: seeded.artifactId },
          })
        );

        expect(result).toEqual({
          ok: true,
          value: {
            throttled: false,
            fileCount: 1,
            patchBytes: 21,
          },
        });
        expect(branch).toMatchObject({
          fileCacheHeadSha: "migrated-head",
          fileCacheStatus: BranchFileCacheStatus.Fresh,
          lastSyncCompletedAt: supersedingCompletedAt,
          lastSyncErrorCode: newerErrorCode,
          lastSyncErrorMessage: supersedingErrorMessage,
          lastSyncStartedAt: supersedingStartedAt,
          syncStatus: newerStatus,
        });
      });
    }
  );

  it("relinks stale branch artifacts when repositories are added after reinstall", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const oldInstallation = await seedStaleInstallation(ctx, "added-old");
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const stale = await seedBranchWithCurrentPr(
        {
          ...ctx,
          installationId: oldInstallation.installationId,
          repositoryId: staleRepository.id,
        },
        {
          branchName: "FEA-1128-added-repo-relink",
          prNumber: 2128,
          title: "Added repository relink PR",
        }
      );

      await githubService.addRepositories(ctx.installationRecordId, [
        {
          githubRepoId: String(ctx.githubRepoId),
          fullName: ctx.repositoryFullName,
          name: ctx.repositoryFullName.split("/")[1] ?? "repo",
          owner: "owner",
          private: false,
        },
      ]);

      const repaired = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: stale.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      expect(repaired?.repositoryId).toBe(ctx.repositoryId);
      expect(repaired?.currentPullRequestDetail?.repositoryId).toBe(
        ctx.repositoryId
      );
    });
  });

  it("does not relink stored branch artifacts during installation claim before repository fetch", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const originalFetch = globalThis.fetch;
      await withDb((db) =>
        db.gitHubInstallation.update({
          where: { id: ctx.installationRecordId },
          data: {
            organizationId: null,
            status: GitHubInstallationStatus.PENDING_CLAIM,
          },
        })
      );
      const oldInstallation = await seedStaleInstallation(
        ctx,
        "activation-old"
      );
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const stale = await seedBranchWithCurrentPr(
        {
          ...ctx,
          installationId: oldInstallation.installationId,
          repositoryId: staleRepository.id,
        },
        {
          branchName: "FEA-1128-activation-relink",
          prNumber: 3129,
          title: "Activation relink PR",
        }
      );
      // PLN-1742 M5: no OAuth code exchange — the claim verifies the
      // installation through the injected app-JWT lookup, so the only real
      // fetch left is the installation-repositories walk.
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: { get: vi.fn().mockReturnValue(null) },
        json: () => Promise.resolve({ repositories: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        const result = await githubService.claimGitHubInstallation(
          {
            installationId: String(ctx.installationId),
            organizationId: ctx.organizationId,
            userId: ctx.userId,
          },
          makeGrantedClaimDeps(ctx.installationId)
        );

        expect(result).toEqual({ status: "connected" });
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }

      const repaired = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: stale.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      expect(repaired?.repositoryId).toBe(staleRepository.id);
      expect(repaired?.currentPullRequestDetail?.repositoryId).toBe(
        staleRepository.id
      );
    });
  });

  it("does not relink stale branch artifacts owned by another organization", async () => {
    await autoRollbackTransaction(async () => {
      const activeCtx = await setupContext();
      const otherCtx = await setupContext();
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `other-old-${activeCtx.githubRepoId}`,
            accountId: `other-old-${activeCtx.githubRepoId}`,
            accountLogin: "owner",
            accountType: "Organization",
            senderLogin: "sender",
            senderId: "sender-id",
            status: GitHubInstallationStatus.UNINSTALLED,
            repositories: {
              create: {
                githubRepoId: String(activeCtx.githubRepoId),
                fullName: activeCtx.repositoryFullName,
                name: activeCtx.repositoryFullName.split("/")[1] ?? "repo",
                owner: "owner",
                private: false,
              },
            },
          },
          include: { repositories: true },
        })
      );
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const seeded = await seedBranchWithCurrentPr(
        {
          ...otherCtx,
          githubRepoId: activeCtx.githubRepoId,
          installationId: oldInstallation.installationId,
          repositoryFullName: activeCtx.repositoryFullName,
          repositoryId: staleRepository.id,
        },
        {
          branchName: "FEA-1128-cross-org-reinstall",
          prNumber: 2128,
          title: "Cross-org stale PR",
        }
      );

      await githubService.syncRepositories(activeCtx.installationRecordId, [
        {
          githubRepoId: String(activeCtx.githubRepoId),
          fullName: activeCtx.repositoryFullName,
          name: activeCtx.repositoryFullName.split("/")[1] ?? "repo",
          owner: "owner",
          private: false,
        },
      ]);

      const untouched = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      expect(untouched?.repositoryId).toBe(staleRepository.id);
      expect(untouched?.currentPullRequestDetail?.repositoryId).toBe(
        staleRepository.id
      );
    });
  });

  it("normalizes current PR state when relinking a same-branch PR detail collision", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const oldInstallation = await seedStaleInstallation(ctx, "collision-old");
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const stale = await seedBranchWithCurrentPr(
        {
          ...ctx,
          installationId: oldInstallation.installationId,
          repositoryId: staleRepository.id,
        },
        {
          branchName: "FEA-1128-pr-collision-reinstall",
          githubId: "stale-pr-collision-3128",
          prNumber: 3128,
          title: "Stale PR collision",
        }
      );
      const activePr = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: ctx.organizationId,
            branchArtifactId: stale.artifactId,
            repositoryId: ctx.repositoryId,
            githubId: "active-pr-collision-3128",
            number: 3128,
            title: "Active PR collision",
            htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/3128`,
            prState: GitHubPRState.OPEN,
            isCurrent: false,
            reviewDecision: DbReviewDecision.APPROVED,
          },
          select: { id: true },
        })
      );

      await githubService.syncRepositories(ctx.installationRecordId, [
        {
          githubRepoId: String(ctx.githubRepoId),
          fullName: ctx.repositoryFullName,
          name: ctx.repositoryFullName.split("/")[1] ?? "repo",
          owner: "owner",
          private: false,
        },
      ]);

      const repaired = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: stale.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      const stalePr = await withDb((db) =>
        db.pullRequestDetail.findUnique({
          where: { id: stale.prDetailId },
        })
      );
      expect(repaired?.repositoryId).toBe(ctx.repositoryId);
      expect(repaired?.currentPullRequestDetailId).toBe(activePr.id);
      expect(repaired?.currentPullRequestDetail?.repositoryId).toBe(
        ctx.repositoryId
      );
      expect(stalePr?.repositoryId).toBe(staleRepository.id);
      expect(stalePr?.isCurrent).toBe(false);
      expect(repaired?.currentPullRequestDetail?.isCurrent).toBe(true);
    });
  });

  it("does not adopt a cross-org active PR detail collision", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const otherOrganizationId = await createTestOrganization();
      const otherUser = await createTestUser(otherOrganizationId);
      const otherProjectId = await createTestProject(
        otherOrganizationId,
        otherUser.id
      );
      const oldInstallation = await seedStaleInstallation(
        ctx,
        "cross-org-pr-collision-old"
      );
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const stale = await seedBranchWithCurrentPr(
        {
          ...ctx,
          installationId: oldInstallation.installationId,
          repositoryId: staleRepository.id,
        },
        {
          branchName: "FEA-1128-cross-org-pr-collision",
          githubId: "stale-cross-org-pr-collision-6128",
          prNumber: 6128,
          title: "Stale cross-org PR collision",
        }
      );
      const otherArtifact = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: otherOrganizationId,
            projectId: otherProjectId,
            type: ArtifactType.BRANCH,
            name: "other-org-pr-collision",
            status: GitHubPRState.OPEN,
            externalUrl: `https://github.com/${ctx.repositoryFullName}/tree/other-org-pr-collision`,
            branch: {
              create: {
                organizationId: otherOrganizationId,
                repositoryFullName: ctx.repositoryFullName,
                repositoryId: ctx.repositoryId,
                branchName: "other-org-pr-collision",
                baseBranch: "main",
              },
            },
          },
          select: { id: true },
        })
      );
      const otherPr = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: otherOrganizationId,
            branchArtifactId: otherArtifact.id,
            repositoryId: ctx.repositoryId,
            githubId: "active-cross-org-pr-collision-6128",
            number: 6128,
            title: "Other org PR collision",
            htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/6128`,
            prState: GitHubPRState.OPEN,
            isCurrent: true,
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: otherArtifact.id },
          data: { currentPullRequestDetailId: otherPr.id },
        })
      );

      await githubService.syncRepositories(ctx.installationRecordId, [
        {
          githubRepoId: String(ctx.githubRepoId),
          fullName: ctx.repositoryFullName,
          name: ctx.repositoryFullName.split("/")[1] ?? "repo",
          owner: "owner",
          private: false,
        },
      ]);

      const untouched = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: stale.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      const stalePr = await withDb((db) =>
        db.pullRequestDetail.findUnique({
          where: { id: stale.prDetailId },
        })
      );
      expect(untouched?.repositoryId).toBe(staleRepository.id);
      expect(untouched?.currentPullRequestDetailId).toBe(stale.prDetailId);
      expect(untouched?.currentPullRequestDetail?.repositoryId).toBe(
        staleRepository.id
      );
      expect(stalePr?.isCurrent).toBe(true);
    });
  });

  it("repairs a contaminated current PR pointer during stale repository relink", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const otherOrganizationId = await createTestOrganization();
      const otherUser = await createTestUser(otherOrganizationId);
      const otherProjectId = await createTestProject(
        otherOrganizationId,
        otherUser.id
      );
      const oldInstallation = await seedStaleInstallation(
        ctx,
        "bad-current-old"
      );
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const stale = await seedBranchWithCurrentPr(
        {
          ...ctx,
          installationId: oldInstallation.installationId,
          repositoryId: staleRepository.id,
        },
        {
          branchName: "FEA-1128-contaminated-current",
          githubId: "stale-contaminated-current-7128",
          prNumber: 7128,
          title: "Stale contaminated current PR",
        }
      );
      const otherArtifact = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: otherOrganizationId,
            projectId: otherProjectId,
            type: ArtifactType.BRANCH,
            name: "foreign-current-pointer",
            status: GitHubPRState.OPEN,
            externalUrl: `https://github.com/${ctx.repositoryFullName}/tree/foreign-current-pointer`,
            branch: {
              create: {
                organizationId: otherOrganizationId,
                repositoryFullName: ctx.repositoryFullName,
                repositoryId: ctx.repositoryId,
                branchName: "foreign-current-pointer",
                baseBranch: "main",
              },
            },
          },
          select: { id: true },
        })
      );
      const foreignPr = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: otherOrganizationId,
            branchArtifactId: otherArtifact.id,
            repositoryId: ctx.repositoryId,
            githubId: "foreign-current-pointer-7128",
            number: 8128,
            title: "Foreign current pointer",
            htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/8128`,
            prState: GitHubPRState.OPEN,
            isCurrent: true,
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: stale.artifactId },
          data: { currentPullRequestDetailId: foreignPr.id },
        })
      );

      await githubService.syncRepositories(ctx.installationRecordId, [
        {
          githubRepoId: String(ctx.githubRepoId),
          fullName: ctx.repositoryFullName,
          name: ctx.repositoryFullName.split("/")[1] ?? "repo",
          owner: "owner",
          private: false,
        },
      ]);

      const repaired = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: stale.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      const stalePr = await withDb((db) =>
        db.pullRequestDetail.findUnique({
          where: { id: stale.prDetailId },
        })
      );
      expect(repaired?.repositoryId).toBe(ctx.repositoryId);
      expect(repaired?.currentPullRequestDetailId).toBe(stale.prDetailId);
      expect(repaired?.currentPullRequestDetail?.repositoryId).toBe(
        ctx.repositoryId
      );
      expect(stalePr?.repositoryId).toBe(ctx.repositoryId);
      expect(stalePr?.isCurrent).toBe(true);
    });
  });

  it("prevents a duplicate branch row for the same D2 identity (PRD-510 D2 — no PR-state split)", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "FEA-1128-branch-collision";
      await seedBranchWithCurrentPr(ctx, {
        branchName,
        prNumber: 4128,
        title: "Active branch collision",
      });
      // Pre-D2, a re-installed/duplicate repo could own a SECOND branch row for
      // the same (org, repoFullName, branchName) under a different repositoryId,
      // splitting PR state across two rows. The D2 identity key now makes that
      // row structurally impossible: the duplicate insert is rejected, so a
      // single row owns the branch's PR state. (Reconciling the stale
      // installation repo itself is Phase 2 reconciliation work.)
      const oldInstallation = await seedStaleInstallation(
        ctx,
        "branch-collision-old"
      );
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }

      // The stale repo shares (org, repoFullName, branchName) with the active
      // branch, so the D2 unique index rejects the duplicate with P2002.
      await expect(
        seedBranchWithCurrentPr(
          {
            ...ctx,
            installationId: oldInstallation.installationId,
            repositoryId: staleRepository.id,
          },
          {
            branchName,
            prNumber: 5128,
            title: "Stale branch collision",
          }
        )
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  it("ignores wrong-repository current PR rows when listing local branches", async () => {
    await runCommittedBranchTest(async (ctx) => {
      const branchName = "FEA-2527-wrong-repo-pr";
      const headSha = "local-only-head-sha";
      const sidecarFullName = `${ctx.repositoryFullName}-wrong-pr`;
      const sidecarRepository = await withDb((db) =>
        db.gitHubInstallationRepository.create({
          data: {
            installationId: ctx.installationRecordId,
            githubRepoId: `${ctx.githubRepoId}-wrong-pr`,
            fullName: sidecarFullName,
            name: sidecarFullName.split("/")[1] ?? "wrong-pr",
            owner: sidecarFullName.split("/")[0] ?? "owner",
            private: false,
          },
          select: { id: true },
        })
      );
      const localResult = await branchService.upsertBranchArtifact({
        organizationId: ctx.organizationId,
        repositoryId: ctx.repositoryId,
        repositoryFullName: ctx.repositoryFullName,
        branchName,
        defaultBranch: "main",
        projectId: ctx.projectId,
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
        headSha,
        headShaSource: BranchHeadShaSource.HarnessInput,
      });
      expect(localResult.ok).toBe(true);
      if (!localResult.ok) {
        throw new Error("Expected local branch materialization to succeed");
      }
      await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: ctx.organizationId,
            branchArtifactId: localResult.value.id,
            repositoryId: sidecarRepository.id,
            githubId: `wrong-repo-current-pr-2527-${ctx.organizationId}`,
            number: 2527,
            title: "Foreign searchable PR",
            htmlUrl: `https://github.com/${sidecarFullName}/pull/2527`,
            prState: GitHubPRState.OPEN,
            isCurrent: true,
          },
        })
      );

      await expect(
        branchReadService.getBranchDetail(
          ctx.organizationId,
          localResult.value.id
        )
      ).resolves.toBeNull();
      await expect(
        branchReadService.listBranches(ctx.organizationId, {
          limit: 50,
          offset: 0,
          repository: [ctx.repositoryFullName],
          search: "Foreign searchable PR",
          status: [BranchStatus.Open],
        })
      ).resolves.toMatchObject({
        items: [],
        total: 0,
      });
    });
  });

  it("verifies live GitHub state for the deprecated pull-request alias when payload includes headSha", async () => {
    // ISS-11104: committed — the live-verify path opens its own budgeted tx.
    await runCommittedBranchTest(async (ctx) => {
      const [, repoName] = ctx.repositoryFullName.split("/");
      mockGetSinglePullRequest.mockResolvedValueOnce({
        githubId: "980098",
        number: 98,
        title: "Live legacy alias PR",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/98`,
        headBranch: "FEA-1116-alias-live-head",
        baseBranch: "main",
        state: ApiGitHubPRState.Open,
        mergedAt: null,
        closedAt: null,
        authorLogin: "author",
        isDraft: false,
        headSha: "live-head-sha",
        baseSha: "base-sha",
      });
      const response = await postPullRequestAlias(
        new NextRequest(
          "https://api.example.test/artifact-links/pull-requests",
          {
            method: "POST",
            body: JSON.stringify({
              projectId: ctx.projectId,
              title: "Payload legacy alias PR",
              externalUrl: `https://github.com/${ctx.repositoryFullName}/pull/98`,
              number: 98,
              githubId: "980098",
              headBranch: "FEA-1116-alias-payload-head",
              baseBranch: "main",
              headSha: "live-head-sha",
              state: ApiGitHubPRState.Open,
            }),
          }
        ),
        routeContext({})
      );
      const result = await expectSuccess<{ id: string }>(response);
      const branch = await findBranchArtifact(
        ctx.repositoryId,
        "FEA-1116-alias-live-head"
      );
      expect(branch).toMatchObject({
        artifactId: result.id,
        headSha: "live-head-sha",
        headShaSource: BranchHeadShaSource.PullRequestWebhook,
      });
      expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
        ctx.installationId
      );
      expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
        mockOctokit,
        "owner",
        repoName,
        98,
        expect.anything()
      );
      const pullRequestDetail = await withDb((db) =>
        db.pullRequestDetail.findFirst({
          where: {
            branchArtifactId: result.id,
            repositoryId: ctx.repositoryId,
          },
        })
      );
      expect(pullRequestDetail).toMatchObject({
        title: "Live legacy alias PR",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/98`,
      });
    });
  });

  it("rejects the deprecated pull-request alias when headSha cannot be resolved", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const [, repoName] = ctx.repositoryFullName.split("/");
      const response = await postPullRequestAlias(
        new NextRequest(
          "https://api.example.test/artifact-links/pull-requests",
          {
            method: "POST",
            body: JSON.stringify({
              projectId: ctx.projectId,
              title: "Legacy alias PR without head",
              externalUrl: `https://github.com/${ctx.repositoryFullName}/pull/101`,
              number: 101,
              githubId: "101101",
              headBranch: "FEA-1116-missing-head",
              baseBranch: "main",
              state: ApiGitHubPRState.Open,
            }),
          }
        ),
        routeContext({})
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: "Pull request head SHA could not be resolved",
        code: "pull_request_head_unavailable",
      });
      expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
        mockOctokit,
        "owner",
        repoName,
        101,
        expect.anything()
      );
      const branch = await withDb((db) =>
        db.branchDetail.findFirst({
          where: {
            repositoryId: ctx.repositoryId,
            branchName: "FEA-1116-missing-head",
          },
        })
      );
      expect(branch).toBeNull();
    });
  });

  it("rejects the deprecated pull-request alias when the installation client mint fails", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      mockGetInstallationOctokit.mockRejectedValueOnce(
        new Error("token exchange failed")
      );

      const response = await postPullRequestAlias(
        new NextRequest(
          "https://api.example.test/artifact-links/pull-requests",
          {
            method: "POST",
            body: JSON.stringify({
              projectId: ctx.projectId,
              title: "Legacy alias PR with failed mint",
              externalUrl: `https://github.com/${ctx.repositoryFullName}/pull/102`,
              number: 102,
              githubId: "102102",
              headBranch: "FEA-1116-mint-failure",
              baseBranch: "main",
              state: ApiGitHubPRState.Open,
            }),
          }
        ),
        routeContext({})
      );

      // A mint rejection resolves to the same typed BadRequest as an
      // unresolvable head instead of escaping as a route 500.
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: "Pull request head SHA could not be resolved",
        code: "pull_request_head_unavailable",
      });
      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      const branch = await withDb((db) =>
        db.branchDetail.findFirst({
          where: {
            repositoryId: ctx.repositoryId,
            branchName: "FEA-1116-mint-failure",
          },
        })
      );
      expect(branch).toBeNull();
    });
  });

  // PLN-1099 Phase 2: explicit push state (`firstPushedAt`/`pushSource`) is
  // set-once by the EARLIEST verified evidence and converges across producers
  // (webhook + desktop session) in any delivery order, never derived from
  // `headShaSource` or row existence.
  describe("push-state reconciliation (PRD-510 FR2)", () => {
    const ZERO_SHA = "0".repeat(40);

    it("push webhook stamps firstPushedAt + pushSource=webhook, set-once across re-delivery", async () => {
      await autoRollbackTransaction(async () => {
        const ctx = await setupContext();
        const branchName = "FEA-2129-webhook-pushed";

        await handlePush(
          pushEvent(ctx, {
            branchName,
            before: ZERO_SHA,
            after: "sha-1",
            created: true,
            pushedAt: "2026-05-15T10:00:00Z",
          })
        );
        await flushWaitUntil();
        let branch = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(branch.firstPushedAt?.toISOString()).toBe(
          "2026-05-15T10:00:00.000Z"
        );
        expect(branch.pushSource).toBe(BranchPushSource.Webhook);

        // A later sequential push must NOT move the earliest stamp forward.
        await handlePush(
          pushEvent(ctx, {
            branchName,
            before: "sha-1",
            after: "sha-2",
            pushedAt: "2026-05-16T10:00:00Z",
          })
        );
        await flushWaitUntil();
        branch = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(branch.firstPushedAt?.toISOString()).toBe(
          "2026-05-15T10:00:00.000Z"
        );
        expect(branch.pushSource).toBe(BranchPushSource.Webhook);
      });
    });

    it("a branch-delete push neither stamps nor clears push state", async () => {
      await autoRollbackTransaction(async () => {
        const ctx = await setupContext();
        const branchName = "FEA-2129-delete-nostamp";

        await handlePush(
          pushEvent(ctx, {
            branchName,
            before: ZERO_SHA,
            after: "sha-1",
            created: true,
            pushedAt: "2026-05-15T10:00:00Z",
          })
        );
        await flushWaitUntil();

        await handlePush(
          pushEvent(ctx, {
            branchName,
            before: "sha-1",
            after: ZERO_SHA,
            deleted: true,
            pushedAt: "2026-05-17T10:00:00Z",
          })
        );
        await flushWaitUntil();

        const branch = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(branch.firstPushedAt?.toISOString()).toBe(
          "2026-05-15T10:00:00.000Z"
        );
        expect(branch.pushSource).toBe(BranchPushSource.Webhook);
        expect(branch.deletedAt).not.toBeNull();
      });
    });

    it("desktop session push then a LATER webhook push keeps the earliest stamp (session wins)", async () => {
      await autoRollbackTransaction(async () => {
        const ctx = await setupContext();
        const branchName = "FEA-2129-session-first";

        // Desktop producer: create the branch row un-pushed (no head), then a
        // C1-verified in-session push stamps session evidence at T1.
        const created = await branchService.upsertBranchArtifact({
          organizationId: ctx.organizationId,
          repositoryId: ctx.repositoryId,
          repositoryFullName: ctx.repositoryFullName,
          branchName,
          defaultBranch: "main",
          projectId: ctx.projectId,
        });
        expect(created.ok).toBe(true);
        const seeded = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(seeded.firstPushedAt).toBeNull();
        await withDb((db) =>
          stampBranchFirstPush(
            db,
            seeded.artifactId,
            new Date("2026-05-15T09:00:00Z"),
            BranchPushSource.Session
          )
        );

        // A later webhook push (T2 > T1) must not override the session stamp.
        await handlePush(
          pushEvent(ctx, {
            branchName,
            before: ZERO_SHA,
            after: "sha-1",
            created: true,
            pushedAt: "2026-05-15T12:00:00Z",
          })
        );
        await flushWaitUntil();

        const branch = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(branch.firstPushedAt?.toISOString()).toBe(
          "2026-05-15T09:00:00.000Z"
        );
        expect(branch.pushSource).toBe(BranchPushSource.Session);
      });
    });

    it("a webhook push then an EARLIER session push lets the session earliest-win", async () => {
      await autoRollbackTransaction(async () => {
        const ctx = await setupContext();
        const branchName = "FEA-2129-webhook-first";

        await handlePush(
          pushEvent(ctx, {
            branchName,
            before: ZERO_SHA,
            after: "sha-1",
            created: true,
            pushedAt: "2026-05-15T12:00:00Z",
          })
        );
        await flushWaitUntil();
        let branch = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(branch.firstPushedAt?.toISOString()).toBe(
          "2026-05-15T12:00:00.000Z"
        );
        expect(branch.pushSource).toBe(BranchPushSource.Webhook);

        // The desktop later syncs a session whose push happened earlier (T1<T2).
        await withDb((db) =>
          stampBranchFirstPush(
            db,
            branch.artifactId,
            new Date("2026-05-15T09:00:00Z"),
            BranchPushSource.Session
          )
        );
        branch = await findBranchArtifact(ctx.repositoryId, branchName);
        expect(branch.firstPushedAt?.toISOString()).toBe(
          "2026-05-15T09:00:00.000Z"
        );
        expect(branch.pushSource).toBe(BranchPushSource.Session);
      });
    });
  });

  it("enriches only the matching repository-scoped branch's head on push, leaving the same-named sidecar branch's head untouched", async () => {
    await runCommittedBranchTest(async (ctx) => {
      const branchName = "FEA-2527-existing-local";
      const headSha = "same-head-sha";
      const sidecarFullName = `${ctx.repositoryFullName}-sidecar`;
      const sidecarRepository = await withDb((db) =>
        db.gitHubInstallationRepository.create({
          data: {
            installationId: ctx.installationRecordId,
            ...persistedSidecarAuthority(ctx, sidecarFullName),
            name: sidecarFullName.split("/")[1] ?? "sidecar",
            owner: sidecarFullName.split("/")[0] ?? "owner",
            private: false,
          },
          select: { id: true },
        })
      );
      const primaryResult = await branchService.upsertBranchArtifact({
        organizationId: ctx.organizationId,
        repositoryId: ctx.repositoryId,
        repositoryFullName: ctx.repositoryFullName,
        branchName,
        defaultBranch: "main",
        projectId: ctx.projectId,
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
        headSha,
        headShaSource: BranchHeadShaSource.ExplicitSync,
      });
      const sidecarResult = await branchService.upsertBranchArtifact({
        organizationId: ctx.organizationId,
        repositoryId: sidecarRepository.id,
        repositoryFullName: sidecarFullName,
        branchName,
        defaultBranch: "main",
        projectId: ctx.projectId,
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
        headSha,
        headShaSource: BranchHeadShaSource.ExplicitSync,
      });
      expect(primaryResult.ok).toBe(true);
      expect(sidecarResult.ok).toBe(true);
      if (!(primaryResult.ok && sidecarResult.ok)) {
        throw new Error("Expected local branch materialization to succeed");
      }

      // Give both branches the same Wrote + verified-session-push Product
      // evidence so this remains a repository-scoped head-enrichment test.
      const primarySessionId = await linkValidSessionToBranch({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        branchArtifactId: primaryResult.value.id,
        label: `${branchName}-primary`,
      });
      const sidecarSessionId = await linkValidSessionToBranch({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        branchArtifactId: sidecarResult.value.id,
        label: `${branchName}-sidecar`,
      });
      await stampBranchSessionPushes(
        [primaryResult.value.id, sidecarResult.value.id],
        new Date("2026-05-15T00:00:00Z")
      );

      await expect(
        branchReadService.getBranchDetail(
          ctx.organizationId,
          primaryResult.value.id
        )
      ).resolves.toMatchObject({
        id: primaryResult.value.id,
        dataState: BranchDataState.Ready,
      });
      await expect(
        branchReadService.getBranchDetail(
          ctx.organizationId,
          sidecarResult.value.id
        )
      ).resolves.toMatchObject({
        id: sidecarResult.value.id,
        dataState: BranchDataState.Ready,
      });
      const primaryBefore = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(primaryBefore).toMatchObject({
        headSha,
        headShaSource: BranchHeadShaSource.ExplicitSync,
      });

      mockCompareBranchFileChanges.mockResolvedValueOnce(comparedFilesMock());
      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "parent-head-sha",
          after: headSha,
          pushedAt: "2026-05-15T01:00:00Z",
        })
      );
      await flushWaitUntil();

      // The push enriches only the primary branch and records its prior head.
      const pushedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(pushedBranch).toMatchObject({
        artifactId: primaryResult.value.id,
        headSha,
        headShaSource: BranchHeadShaSource.PushWebhook,
        lastPushBeforeSha: "parent-head-sha",
      });
      const list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([
        expect.objectContaining({
          id: primaryResult.value.id,
          branchName,
          dataState: BranchDataState.Ready,
          prNumber: null,
          sessionIds: [primarySessionId],
          status: BranchStatus.Open,
        }),
      ]);
      await expect(
        branchCommentsService.getBranchComments(
          ctx.organizationId,
          primaryResult.value.id
        )
      ).resolves.toMatchObject({
        branchId: primaryResult.value.id,
        state: BranchCommentsState.UnsyncedUnknown,
        prNumber: null,
        prUrl: null,
      });

      // Repository-scoped isolation: the primary-repo push did NOT touch the
      // sidecar's head — its source stays the original ExplicitSync, not PushWebhook.
      const sidecarBefore = await findBranchArtifact(
        sidecarRepository.id,
        branchName
      );
      expect(sidecarBefore).toMatchObject({
        artifactId: sidecarResult.value.id,
        headShaSource: BranchHeadShaSource.ExplicitSync,
      });
      // The sidecar stays visible under its own repo scope, keyed to its own
      // session (its Ready detail was already asserted pre-push above).
      await expect(
        branchReadService.listBranches(ctx.organizationId, {
          limit: 50,
          offset: 0,
          repository: [sidecarFullName],
          search: branchName,
          status: [BranchStatus.Open],
        })
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            id: sidecarResult.value.id,
            sessionIds: [sidecarSessionId],
          }),
        ],
      });
    });
  });

  it("re-lists a push-only branch when GitHub deletes and recreates the ref", async () => {
    await runCommittedBranchTest(async (ctx) => {
      const branchName = "FEA-2528-delete-recreate";
      const zeroSha = "0000000000000000000000000000000000000000";

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: zeroSha,
          after: "head-before-delete",
          created: true,
          pushedAt: "2026-05-15T00:00:00Z",
        })
      );
      await flushWaitUntil();
      const initialBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(initialBranch.deletedAt).toBeNull();
      // FEA-4225 corpus eligibility also needs ≥1 valid linked session. Attach
      // one to the artifact the first push materialized, so the delete/recreate
      // listing assertions below keep testing ref lifecycle rather than the
      // session gate. The artifact id is stable across the tombstone/recreate
      // cycle, so this single link covers every later read.
      const sessionId = await linkValidSessionToBranch({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        branchArtifactId: initialBranch.artifactId,
        label: branchName,
      });

      let list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([
        expect.objectContaining({
          branchName,
          dataState: BranchDataState.Ready,
          prNumber: null,
          sessionIds: [sessionId],
          status: BranchStatus.Open,
        }),
      ]);

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "head-before-delete",
          after: zeroSha,
          deleted: true,
          pushedAt: "2026-05-15T01:00:00Z",
        })
      );
      const tombstonedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(tombstonedBranch.deletedAt).toEqual(expect.any(Date));
      list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([]);

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: zeroSha,
          after: "head-before-delete",
          created: true,
          pushedAt: "2026-05-15T00:00:00Z",
        })
      );
      await flushWaitUntil();
      const stillTombstonedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(stillTombstonedBranch).toMatchObject({
        deletedAt: expect.any(Date),
        headSha: "head-before-delete",
        lastPushBeforeSha: zeroSha,
      });
      list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([]);

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: zeroSha,
          after: "head-after-recreate",
          created: true,
          pushedAt: "2026-05-15T02:00:00Z",
        })
      );
      await flushWaitUntil();
      const recreatedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(recreatedBranch).toMatchObject({
        deletedAt: null,
        headSha: "head-after-recreate",
        lastPushBeforeSha: zeroSha,
      });
      list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([
        expect.objectContaining({
          branchName,
          dataState: BranchDataState.Ready,
          prNumber: null,
          sessionIds: [sessionId],
          status: BranchStatus.Open,
        }),
      ]);

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "head-before-delete",
          after: zeroSha,
          deleted: true,
          pushedAt: "2026-05-15T01:00:00Z",
        })
      );
      const stillRecreatedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(stillRecreatedBranch).toMatchObject({
        deletedAt: null,
        headSha: "head-after-recreate",
        lastPushBeforeSha: zeroSha,
      });
      list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([
        expect.objectContaining({
          branchName,
          dataState: BranchDataState.Ready,
          prNumber: null,
          sessionIds: [sessionId],
          status: BranchStatus.Open,
        }),
      ]);
    });
  });

  it("re-lists a delete-first branch when a later GitHub create push arrives", async () => {
    await runCommittedBranchTest(async (ctx) => {
      const branchName = "FEA-2528-delete-first-recreate";
      const zeroSha = "0000000000000000000000000000000000000000";

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "head-before-delete",
          after: zeroSha,
          deleted: true,
          pushedAt: "2026-05-15T01:00:00Z",
        })
      );
      const tombstonedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(tombstonedBranch).toMatchObject({
        deletedAt: expect.any(Date),
        headSha: null,
      });
      // Seeded before the recreate so the later create push is the only
      // variable that flips this branch back into the corpus.
      const sessionId = await linkValidSessionToBranch({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        branchArtifactId: tombstonedBranch.artifactId,
        label: branchName,
      });

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: zeroSha,
          after: "stale-created-head",
          created: true,
          pushedAt: "2026-05-15T00:00:00Z",
        })
      );
      const stillTombstonedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(stillTombstonedBranch).toMatchObject({
        deletedAt: expect.any(Date),
        headSha: null,
      });

      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: zeroSha,
          after: "head-after-recreate",
          created: true,
          pushedAt: "2026-05-15T02:00:00Z",
        })
      );
      await flushWaitUntil();
      const recreatedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(recreatedBranch).toMatchObject({
        deletedAt: null,
        headSha: "head-after-recreate",
        lastPushBeforeSha: zeroSha,
      });

      const list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([
        expect.objectContaining({
          branchName,
          dataState: BranchDataState.Ready,
          prNumber: null,
          sessionIds: [sessionId],
          status: BranchStatus.Open,
        }),
      ]);
    });
  });
});

/**
 * An UNINSTALLED installation already owning `ctx`'s repository — the stale row
 * a reinstall has to relink away from. `slug` only keeps the installation and
 * account ids unique per case.
 */
function seedStaleInstallation(ctx: TestContext, slug: string) {
  return withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId: null,
        installationId: `${slug}-${ctx.githubRepoId}`,
        accountId: `${slug}-${ctx.githubRepoId}`,
        accountLogin: "owner",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: GitHubInstallationStatus.UNINSTALLED,
        repositories: {
          create: {
            githubRepoId: String(ctx.githubRepoId),
            fullName: ctx.repositoryFullName,
            name: ctx.repositoryFullName.split("/")[1] ?? "repo",
            owner: "owner",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
}
