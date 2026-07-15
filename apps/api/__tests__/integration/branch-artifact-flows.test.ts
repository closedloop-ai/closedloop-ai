// biome-ignore-all lint/suspicious/noMisplacedAssertion: Integration helpers assert from callbacks invoked by tests.
import type { PushEvent } from "@octokit/webhooks-types";
import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  BranchHeadShaSource,
  BranchPushSource,
  BranchSyncStatus,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  BranchCommentsState,
  BranchDataState,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BRANCH_VIEW_IN_FLIGHT_STALE_MS,
  BranchViewCheckKind,
  BranchViewChecksProviderState,
  type BranchViewData,
  BranchViewFileCacheSyncErrorCode,
  BranchViewLoadErrorCode,
  BranchViewPrLifecycleRepairStatus,
  BranchViewSyncErrorCode,
  BranchViewSyncPresentationState,
  BranchViewSyncScope,
  BranchViewSyncThrottleReason,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import { DocumentType } from "@repo/api/src/types/document";
import {
  GitHubPRState as ApiGitHubPRState,
  StatusCheckRollupFailureReason,
} from "@repo/api/src/types/github";
import type { LoopDetail } from "@repo/api/src/types/loop";
import { LoopBranchMaterializationRole } from "@repo/api/src/types/loop-body";
import { Result, Status } from "@repo/api/src/types/result";
import {
  ArtifactSubtype,
  ArtifactType,
  ChecksStatus,
  ReviewDecision as DbReviewDecision,
  GitHubInstallationStatus,
  GitHubPRState,
  LoopCommand,
  LoopStatus,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import type * as GitHubModule from "@repo/github";
import { GitHubProviderResultStatus } from "@repo/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postPullRequestAlias } from "@/app/artifact-links/pull-requests/route";
import { GET as getBranchView } from "@/app/branch-view/[externalLinkId]/route";
import { POST as syncBranchView } from "@/app/branch-view/[externalLinkId]/sync/route";
import { branchCommentsService } from "@/app/branches/branch-comments-service";
import { stampBranchFirstPush } from "@/app/branches/branch-push-state";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchService } from "@/app/branches/branch-service";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import { deploymentService } from "@/app/deployments/deployment-service";
import { GET as getDocumentPullRequests } from "@/app/documents/[id]/pull-request/route";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import { githubService } from "@/app/integrations/github/service";
import { createLoopBranchArtifact } from "@/app/loops/[id]/branch-artifact/branch-artifact-service";
import { POST as postLoopBranchArtifact } from "@/app/loops/[id]/branch-artifact/route";
import { GET as getLoop } from "@/app/loops/[id]/route";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { handlePush } from "@/app/webhooks/github/handlers/push-handler";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const {
  authState,
  mockCompareBranchFileChanges,
  mockEncryptTokenPair,
  mockAuthenticateLoopRunnerRequest,
  mockGetSinglePullRequest,
  mockListPullRequestIssueComments,
  mockListPullRequestReviewComments,
  mockListPullRequestReviews,
  mockParseArtifactReferences,
  mockQueryStatusCheckRollup,
  waitUntilState,
} = vi.hoisted(() => ({
  authState: {
    user: { id: "user-1", organizationId: "org-1" },
  },
  mockCompareBranchFileChanges: vi.fn(),
  mockEncryptTokenPair: vi.fn(),
  mockAuthenticateLoopRunnerRequest: vi.fn(),
  mockGetSinglePullRequest: vi.fn(),
  mockListPullRequestIssueComments: vi.fn(),
  mockListPullRequestReviewComments: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockParseArtifactReferences: vi.fn(),
  mockQueryStatusCheckRollup: vi.fn(),
  waitUntilState: {
    promises: [] as Promise<unknown>[],
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: any[]) => Promise<Response>) =>
    (request: Request, context: { params?: Promise<Record<string, string>> }) =>
      handler(
        { user: authState.user },
        request,
        context?.params ?? Promise.resolve({})
      ),
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: mockAuthenticateLoopRunnerRequest,
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  const { toGitHubProviderResultMock, toSuccessfulGitHubProviderResultMock } =
    await import("../helpers/github-provider-result-mock");

  return {
    ...actual,
    compareBranchFileChanges: mockCompareBranchFileChanges,
    compareBranchFileChangesWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockCompareBranchFileChanges(...args)),
    getSinglePullRequestWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockGetSinglePullRequest(...args)),
    getSinglePullRequest: mockGetSinglePullRequest,
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    listPullRequestIssueComments: mockListPullRequestIssueComments,
    listPullRequestIssueCommentsWithProviderResult: async (
      ...args: unknown[]
    ) =>
      toGitHubProviderResultMock(
        await mockListPullRequestIssueComments(...args)
      ),
    listPullRequestReviewComments: mockListPullRequestReviewComments,
    listPullRequestReviewCommentsWithProviderResult: async (
      ...args: unknown[]
    ) =>
      toGitHubProviderResultMock(
        await mockListPullRequestReviewComments(...args)
      ),
    listPullRequestReviews: mockListPullRequestReviews,
    listPullRequestReviewsWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockListPullRequestReviews(...args)),
    queryStatusCheckRollup: mockQueryStatusCheckRollup,
    queryStatusCheckRollupWithProviderResult: async (...args: unknown[]) =>
      toSuccessfulGitHubProviderResultMock(
        await mockQueryStatusCheckRollup(...args)
      ),
  };
});

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

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

type TestContext = {
  organizationId: string;
  userId: string;
  projectId: string;
  sourceArtifactId: string;
  repositoryId: string;
  repositoryFullName: string;
  githubRepoId: number;
  installationRecordId: string;
  installationId: string;
};

async function flushWaitUntil() {
  const pending = waitUntilState.promises.splice(0);
  await Promise.all(pending);
}

async function setupContext(): Promise<TestContext> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const githubRepoId = Math.floor(Math.random() * 1_000_000_000);
  const suffix = organizationId.replaceAll("-", "").slice(0, 8);
  const repositoryFullName = `owner/repo-${suffix}`;
  const installationId = `100000${githubRepoId}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId,
        accountId: `acct-${suffix}`,
        accountLogin: "owner",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            githubRepoId: String(githubRepoId),
            fullName: repositoryFullName,
            name: `repo-${suffix}`,
            owner: "owner",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repository = installation.repositories[0];
  if (!repository) {
    throw new Error("Failed to seed repository");
  }

  const projectId = await createTestProject(organizationId, user.id);

  // Single-team inheritance is the supported way a project resolves its
  // primary repository (FEA-1058 removed the legacy project-settings repo
  // pointer). Curate the seeded repo as the team's primary and attach the
  // project to that team so `loadProjectRepoDefaults` /
  // `loadProjectPrLinkRepositories` resolve it.
  await withDb((db) =>
    db.team.create({
      data: {
        organizationId,
        name: `Team ${suffix}`,
        slug: `team-${suffix}`,
        repositories: {
          create: {
            installationRepositoryId: repository.id,
            isDefaultSelected: true,
            isPrimary: true,
          },
        },
        projects: {
          create: { projectId },
        },
      },
    })
  );

  const sourceArtifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        name: "FEA-1116 integration fixture",
        slug: "FEA-1116",
        status: "APPROVED",
        assigneeId: user.id,
        createdById: user.id,
        document: {
          create: {
            repositorySnapshot: {
              repositories: [
                {
                  fullName: repository.fullName,
                  role: "primary",
                  position: 0,
                  branch: "main",
                },
              ],
              source: "project_defaults",
            },
            versions: {
              create: {
                version: 1,
                content: "Branch artifact integration fixture",
                createdById: user.id,
              },
            },
          },
        },
      },
      select: { id: true },
    })
  );

  authState.user = { id: user.id, organizationId };
  mockParseArtifactReferences.mockReturnValue([
    {
      slug: "FEA-1116",
      docType: DocumentType.Feature,
      prefix: "FEA",
      matchType: "slug",
      source: "branch",
    },
  ]);

  return {
    organizationId,
    userId: user.id,
    projectId,
    sourceArtifactId: sourceArtifact.id,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    githubRepoId,
    installationRecordId: installation.id,
    installationId: installation.installationId,
  };
}

function pushEvent(
  ctx: TestContext,
  input: {
    branchName: string;
    before: string;
    after: string;
    created?: boolean;
    deleted?: boolean;
    pushedAt?: string;
  }
): PushEvent {
  return {
    ref: `refs/heads/${input.branchName}`,
    before: input.before,
    after: input.after,
    repository: {
      id: ctx.githubRepoId,
      name: ctx.repositoryFullName.split("/")[1],
      full_name: ctx.repositoryFullName,
      default_branch: "main",
      pushed_at: input.pushedAt ?? "2026-05-15T00:00:00Z",
    },
    commits: [
      {
        id: input.after,
        message: "Update branch",
        timestamp: "2026-05-15T00:00:00Z",
        added: [],
        removed: [],
        modified: [],
      },
    ],
    installation: { id: Number(ctx.installationId.replace(/\D/g, "") || 1) },
    created: input.created ?? false,
    deleted: input.deleted ?? false,
  } as unknown as PushEvent;
}

function pullRequestEvent(
  ctx: TestContext,
  input: {
    branchName: string;
    number?: number;
    id?: number;
    title?: string;
    htmlUrl?: string;
    headSha?: string;
  }
) {
  const number = input.number ?? 42;
  const id = input.id ?? 4200;
  return {
    action: "opened",
    repository: {
      id: ctx.githubRepoId,
      full_name: ctx.repositoryFullName,
    },
    installation: { id: Number(ctx.installationId.replace(/\D/g, "") || 1) },
    pull_request: {
      id,
      number,
      title: input.title ?? "FEA-1116 branch artifact PR",
      body: null,
      state: "open",
      draft: false,
      merged: false,
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      html_url:
        input.htmlUrl ??
        `https://github.com/${ctx.repositoryFullName}/pull/${number}`,
      head: {
        ref: input.branchName,
        sha: input.headSha ?? "pr-head-sha",
      },
      base: {
        ref: "main",
        repo: { default_branch: "main" },
      },
    },
  } as Parameters<typeof handlePullRequest>[0];
}

function freshPullRequest(
  ctx: TestContext,
  input: { branchName: string; headSha: string; number: number; title: string }
) {
  return {
    githubId: `github-pr-${input.number}`,
    number: input.number,
    title: input.title,
    htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/${input.number}`,
    headBranch: input.branchName,
    baseBranch: "main",
    state: ApiGitHubPRState.Open,
    mergedAt: null,
    closedAt: null,
    authorLogin: "octocat",
    isDraft: false,
    headSha: input.headSha,
    baseSha: "base-sha",
    mergeCommitSha: null,
  };
}

async function findBranchArtifact(repositoryId: string, branchName: string) {
  const branch = await withDb((db) =>
    db.branchDetail.findFirst({
      where: {
        repositoryId,
        branchName,
      },
      include: {
        artifact: true,
        currentPullRequestDetail: true,
      },
    })
  );
  if (!branch) {
    throw new Error(`Branch artifact not found for ${branchName}`);
  }
  return branch;
}

async function expectSuccess<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  return body.data as T;
}

async function expectBranchViewUnavailable(
  response: Response,
  code = BranchViewLoadErrorCode.PullRequestUnavailable
) {
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body).toMatchObject({
    success: false,
    code,
  });
  return body;
}

function branchViewRequest(externalLinkId: string) {
  return new NextRequest(
    `https://api.example.test/branch-view/${externalLinkId}`
  );
}

function branchViewSyncRequest(externalLinkId: string) {
  return new NextRequest(
    `https://api.example.test/branch-view/${externalLinkId}/sync`,
    { method: "POST" }
  );
}

function loopBranchArtifactRequest(loopId: string, body: unknown) {
  return new Request(
    `https://api.example.test/api/loops/${loopId}/branch-artifact`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

function routeContext<TParams extends Record<string, string>>(params: TParams) {
  return { params: Promise.resolve(params) };
}

async function seedBranchWithCurrentPr(
  ctx: TestContext,
  input: {
    branchName: string;
    githubId?: string;
    lastRefreshAttemptAt?: Date | null;
    lastVerifiedAt?: Date | null;
    prNumber?: number;
    title?: string;
  }
) {
  const branchName = input.branchName;
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: GitHubPRState.OPEN,
        externalUrl: `https://github.com/${ctx.repositoryFullName}/tree/${encodeURIComponent(
          branchName
        )}`,
        branch: {
          create: {
            organizationId: ctx.organizationId,
            repositoryFullName: ctx.repositoryFullName,
            repositoryId: ctx.repositoryId,
            branchName,
            baseBranch: "main",
            baseBranchSource: BranchBaseBranchSource.MigrationPrBase,
            headSha: "migrated-head",
            headShaSource: BranchHeadShaSource.MigrationPrHead,
            headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
            checksStatus: ChecksStatus.PASSING,
            fileCacheStatus: BranchFileCacheStatus.Fresh,
            fileCacheHeadSha: "migrated-head",
            fileCacheFileCount: 1,
            fileCachePatchBytes: 12,
            fileCacheUpdatedAt: new Date("2026-05-15T00:01:00Z"),
            syncStatus: BranchSyncStatus.Fresh,
          },
        },
      },
      select: { id: true },
    })
  );
  const prDetail = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: ctx.organizationId,
        branchArtifactId: artifact.id,
        repositoryId: ctx.repositoryId,
        githubId: input.githubId ?? `${input.prNumber ?? 87_000}`,
        number: input.prNumber ?? 87,
        title: input.title ?? "Migrated PR title",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/${
          input.prNumber ?? 87
        }`,
        prState: GitHubPRState.OPEN,
        isCurrent: true,
        reviewDecision: DbReviewDecision.APPROVED,
        lastVerifiedAt:
          input.lastVerifiedAt === undefined
            ? new Date()
            : input.lastVerifiedAt,
        lastRefreshAttemptAt:
          input.lastRefreshAttemptAt === undefined
            ? null
            : input.lastRefreshAttemptAt,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: artifact.id },
      data: { currentPullRequestDetailId: prDetail.id },
    })
  );
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: ctx.organizationId,
        sourceId: ctx.sourceArtifactId,
        targetId: artifact.id,
        linkType: LinkType.Produces,
      },
    })
  );
  await withDb((db) =>
    db.branchFileChange.create({
      data: {
        branchArtifactId: artifact.id,
        headSha: "migrated-head",
        path: "src/migrated.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ migrated",
        patchBytes: 12,
        isBinary: false,
      },
    })
  );
  return { artifactId: artifact.id, prDetailId: prDetail.id };
}

describe.skipIf(!hasDatabase)("branch artifact API integration flows", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    waitUntilState.promises = [];
    mockCompareBranchFileChanges.mockResolvedValue([]);
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

  it("returns local-dedupe throttle through POST sync without provider calls", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1479-local-dedupe",
      });
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: seeded.artifactId },
          data: {
            lastSyncStartedAt: new Date(),
            syncStatus: BranchSyncStatus.Fresh,
          },
        })
      );

      const response = await syncBranchView(
        branchViewSyncRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body).toMatchObject({
        success: false,
        code: BranchViewSyncErrorCode.SyncThrottled,
        details: {
          throttleReason: BranchViewSyncThrottleReason.LocalDedupe,
        },
      });
      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
    });
  });

  it("returns active in-flight throttle through POST sync without provider calls", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1479-in-flight",
      });
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: seeded.artifactId },
          data: {
            lastSyncStartedAt: new Date(),
            syncStatus: BranchSyncStatus.Syncing,
          },
        })
      );

      const response = await syncBranchView(
        branchViewSyncRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body).toMatchObject({
        success: false,
        code: BranchViewSyncErrorCode.SyncThrottled,
        details: {
          throttleReason: BranchViewSyncThrottleReason.InFlight,
        },
      });
      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
    });
  });

  it("reacquires stale active Syncing rows through POST sync and settles the real DB state", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1479-stale-syncing-reacquire",
      });
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: seeded.artifactId },
          data: {
            lastSyncStartedAt: new Date(
              Date.now() - BRANCH_VIEW_IN_FLIGHT_STALE_MS - 1000
            ),
            syncStatus: BranchSyncStatus.Syncing,
          },
        })
      );
      mockGetSinglePullRequest.mockResolvedValueOnce(
        freshPullRequest(ctx, {
          branchName: "FEA-1479-stale-syncing-reacquire",
          headSha: "migrated-head",
          number: 88,
          title: "Stale syncing reacquired",
        })
      );

      await expectSuccess<{ synced: true }>(
        await syncBranchView(
          branchViewSyncRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      const branch = await withDb((db) =>
        db.branchDetail.findUnique({ where: { artifactId: seeded.artifactId } })
      );
      expect(mockGetSinglePullRequest).toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).toHaveBeenCalled();
      expect(mockCompareBranchFileChanges).toHaveBeenCalled();
      expect(branch).toMatchObject({
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      });
      expect(branch?.lastSyncCompletedAt).toBeInstanceOf(Date);
    });
  });

  it("reacquires a settled sync after the local dedupe window", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1479-reacquire",
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
      mockGetSinglePullRequest.mockResolvedValueOnce(
        freshPullRequest(ctx, {
          branchName: "FEA-1479-reacquire",
          headSha: "migrated-head",
          number: 87,
          title: "Migrated PR title",
        })
      );

      await expectSuccess<{ synced: true }>(
        await syncBranchView(
          branchViewSyncRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      expect(mockCompareBranchFileChanges).toHaveBeenCalled();
    });
  });

  it("settles provider-throttled POST sync attempts through the real DB boundary", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1479-provider-throttle",
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
      mockCompareBranchFileChanges.mockResolvedValueOnce({
        status: GitHubProviderResultStatus.ProviderRateLimit,
        retryAfterSeconds: 88,
      });

      const response = await syncBranchView(
        branchViewSyncRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      const body = await response.json();
      const branch = await withDb((db) =>
        db.branchDetail.findUnique({ where: { artifactId: seeded.artifactId } })
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("88");
      expect(body).toMatchObject({
        success: false,
        code: BranchViewSyncErrorCode.SyncThrottled,
        details: {
          retryAfterSeconds: 88,
          throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
        },
      });
      expect(branch).toMatchObject({
        syncStatus: BranchSyncStatus.Failed,
        lastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
      });
    });
  });

  it("keeps status-check provider throttles durable when file-cache compare succeeds", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1479-check-throttle-file-success",
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
      mockGetSinglePullRequest.mockResolvedValueOnce(
        freshPullRequest(ctx, {
          branchName: "FEA-1479-check-throttle-file-success",
          headSha: "migrated-head",
          number: 87,
          title: "Status-check throttle with file-cache success",
        })
      );
      mockQueryStatusCheckRollup.mockResolvedValueOnce({
        status: GitHubProviderResultStatus.ProviderRateLimit,
        retryAfterSeconds: 33,
      });
      mockCompareBranchFileChanges.mockResolvedValueOnce([
        {
          filename: "src/provider-throttle.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: "@@ provider throttle",
        },
      ]);

      const response = await syncBranchView(
        branchViewSyncRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      const body = await response.json();
      const branch = await withDb((db) =>
        db.branchDetail.findUnique({ where: { artifactId: seeded.artifactId } })
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("33");
      expect(body).toMatchObject({
        success: false,
        code: BranchViewSyncErrorCode.SyncThrottled,
        details: {
          retryAfterSeconds: 33,
          throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
        },
      });
      expect(branch).toMatchObject({
        fileCacheStatus: BranchFileCacheStatus.Fresh,
        fileCacheHeadSha: "migrated-head",
        fileCacheFileCount: 1,
        syncStatus: BranchSyncStatus.Failed,
        lastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
        lastSyncErrorMessage: "GitHub rate limited Branch View refresh",
      });
      expect(branch?.lastSyncStartedAt).toBeInstanceOf(Date);
      expect(branch?.lastSyncCompletedAt).toBeInstanceOf(Date);
    });
  });

  it.each([
    ["completed", BranchSyncStatus.Fresh, null],
    ["failed", BranchSyncStatus.Failed, BranchViewSyncErrorCode.PrSyncFailed],
  ])("does not let a stale late provider throttle overwrite a newer %s sync", async (_name, newerStatus, newerErrorCode) => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: `FEA-1479-stale-${_name}`,
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
        ? "newer failure wins"
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
        return {
          status: GitHubProviderResultStatus.ProviderRateLimit,
          retryAfterSeconds: 70,
        };
      });

      const response = await syncBranchView(
        branchViewSyncRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      const branch = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
        })
      );

      expect(response.status).toBe(429);
      expect(branch).toMatchObject({
        lastSyncCompletedAt: supersedingCompletedAt,
        lastSyncErrorCode: newerErrorCode,
        lastSyncErrorMessage: supersedingErrorMessage,
        lastSyncStartedAt: supersedingStartedAt,
        syncStatus: newerStatus,
      });
    });
  });

  it.each([
    ["lifecycle", "completed", BranchSyncStatus.Fresh, null],
    [
      "lifecycle",
      "failed",
      BranchSyncStatus.Failed,
      BranchViewSyncErrorCode.PrSyncFailed,
    ],
    ["file-cache", "completed", BranchSyncStatus.Fresh, null],
    [
      "file-cache",
      "failed",
      BranchSyncStatus.Failed,
      BranchViewSyncErrorCode.PrSyncFailed,
    ],
  ] as const)("does not let a stale late %s failure overwrite a newer %s sync", async (failurePath, newerName, newerStatus, newerErrorCode) => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = `FEA-1479-stale-${failurePath}-${newerName}`;
      const seeded = await seedBranchWithCurrentPr(ctx, { branchName });
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
        ? "newer ordinary failure wins"
        : null;
      const writeSupersedingSyncOutcome = () =>
        withDb((db) =>
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

      if (failurePath === "lifecycle") {
        mockGetSinglePullRequest.mockImplementationOnce(async () => {
          await writeSupersedingSyncOutcome();
          return null;
        });
      } else {
        mockGetSinglePullRequest.mockResolvedValueOnce(
          freshPullRequest(ctx, {
            branchName,
            headSha: "migrated-head",
            number: 89,
            title: "File-cache stale ordinary failure",
          })
        );
        mockCompareBranchFileChanges.mockImplementationOnce(async () => {
          await writeSupersedingSyncOutcome();
          return null;
        });
      }

      const response = await syncBranchView(
        branchViewSyncRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      const branch = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
        })
      );

      expect(response.status).toBe(failurePath === "lifecycle" ? 502 : 500);
      expect(branch).toMatchObject({
        lastSyncCompletedAt: supersedingCompletedAt,
        lastSyncErrorCode: newerErrorCode,
        lastSyncErrorMessage: supersedingErrorMessage,
        lastSyncStartedAt: supersedingStartedAt,
        syncStatus: newerStatus,
      });
    });
  });

  it.each([
    ["completed", BranchSyncStatus.Fresh, null],
    ["failed", BranchSyncStatus.Failed, BranchViewSyncErrorCode.PrSyncFailed],
  ] as const)("does not let a standalone stale late file-cache failure overwrite a newer %s sync", async (_name, newerStatus, newerErrorCode) => {
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
  });

  it.each([
    ["completed", BranchSyncStatus.Fresh, null],
    ["failed", BranchSyncStatus.Failed, BranchViewSyncErrorCode.PrSyncFailed],
  ] as const)("does not let a standalone stale late file-cache success overwrite a newer %s sync", async (_name, newerStatus, newerErrorCode) => {
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
        return [
          {
            filename: "src/standalone-success.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ standalone success",
          },
        ];
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
  });

  it("schedules GET read repair for stale local open PR lifecycle and converges to closed", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1356-get-closed",
        lastVerifiedAt: null,
        lastRefreshAttemptAt: null,
        prNumber: 7356,
        title: "Stale local open PR from GET",
      });
      mockGetSinglePullRequest.mockResolvedValueOnce({
        githubId: "github-pr-7356",
        number: 7356,
        title: "Closed by GET repair",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/7356`,
        headBranch: "FEA-1356-get-closed",
        baseBranch: "main",
        state: ApiGitHubPRState.Closed,
        mergedAt: null,
        closedAt: "2026-05-19T20:41:49Z",
        authorLogin: "octocat",
        isDraft: false,
        headSha: "closed-from-get-head-sha",
        baseSha: "base-sha",
        mergeCommitSha: null,
      });

      const firstView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      expect(firstView.prState).toBe(ApiGitHubPRState.Open);
      expect(firstView.prLifecycleRepair).toEqual({
        status: BranchViewPrLifecycleRepairStatus.Pending,
      });
      expect(waitUntilState.promises.length).toBeGreaterThan(0);

      await flushWaitUntil();

      const secondView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      const persisted = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { artifact: true, currentPullRequestDetail: true },
        })
      );

      expect(mockGetSinglePullRequest).toHaveBeenCalledOnce();
      expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
      expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
      expect(mockListPullRequestReviews).not.toHaveBeenCalled();
      expect(secondView.prState).toBe(ApiGitHubPRState.Closed);
      expect(secondView.currentPullRequest).toMatchObject({
        number: 7356,
        title: "Closed by GET repair",
        state: ApiGitHubPRState.Closed,
      });
      expect(secondView.prLifecycleRepair).toEqual({
        status: BranchViewPrLifecycleRepairStatus.Idle,
      });
      expect(persisted?.artifact.status).toBe(GitHubPRState.CLOSED);
      expect(persisted?.currentPullRequestDetail).toMatchObject({
        prState: GitHubPRState.CLOSED,
        closedAt: new Date("2026-05-19T20:41:49Z"),
        mergedAt: null,
      });
      expect(
        persisted?.currentPullRequestDetail?.lastVerifiedAt
      ).toBeInstanceOf(Date);
    });
  });

  it("returns idle from GET and does not schedule repair for a recently verified PR", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1356-get-recent",
        prNumber: 7357,
        title: "Recently verified local open PR",
      });
      await withDb((db) =>
        db.pullRequestDetail.update({
          where: { id: seeded.prDetailId },
          data: {
            lastVerifiedAt: new Date(),
            lastRefreshAttemptAt: null,
          },
        })
      );

      const view = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      expect(view.prState).toBe(ApiGitHubPRState.Open);
      expect(view.prLifecycleRepair).toEqual({
        status: BranchViewPrLifecycleRepairStatus.Idle,
      });
      expect(waitUntilState.promises).toHaveLength(1);

      await flushWaitUntil();

      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
      expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
      expect(mockListPullRequestReviews).not.toHaveBeenCalled();
    });
  });

  it("returns pending from GET without rescheduling during a recent lifecycle repair attempt", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1356-get-recent-attempt",
        lastVerifiedAt: null,
        lastRefreshAttemptAt: new Date(),
        prNumber: 7358,
        title: "Recently attempted local open PR",
      });

      const view = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      expect(view.prState).toBe(ApiGitHubPRState.Open);
      expect(view.prLifecycleRepair).toEqual({
        status: BranchViewPrLifecycleRepairStatus.Pending,
      });

      await flushWaitUntil();

      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
      expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
      expect(mockListPullRequestReviews).not.toHaveBeenCalled();
    });
  });

  it("refreshes a stale open PR to closed through POST sync and GET branch view", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1356-closed",
        prNumber: 1356,
        title: "Stale local open PR",
      });
      mockGetSinglePullRequest.mockResolvedValueOnce({
        githubId: "github-pr-1356",
        number: 1356,
        title: "Closed from GitHub",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/1356`,
        headBranch: "FEA-1356-closed",
        baseBranch: "main",
        state: ApiGitHubPRState.Closed,
        mergedAt: null,
        closedAt: "2026-05-19T20:41:49Z",
        authorLogin: "octocat",
        isDraft: false,
        headSha: "closed-head-sha",
        baseSha: "base-sha",
        mergeCommitSha: null,
      });

      await expectSuccess<{ synced: true }>(
        await syncBranchView(
          branchViewSyncRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      const persisted = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { artifact: true, currentPullRequestDetail: true },
        })
      );

      expect(branchView.prState).toBe(ApiGitHubPRState.Closed);
      expect(branchView.currentPullRequest).toMatchObject({
        number: 1356,
        title: "Closed from GitHub",
        state: ApiGitHubPRState.Closed,
      });
      expect(persisted?.artifact.status).toBe(GitHubPRState.CLOSED);
      expect(persisted?.headSha).toBe("closed-head-sha");
      expect(persisted?.baseBranch).toBe("main");
      expect(persisted?.currentPullRequestDetail).toMatchObject({
        prState: GitHubPRState.CLOSED,
        title: "Closed from GitHub",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/1356`,
        isDraft: false,
        closedAt: new Date("2026-05-19T20:41:49Z"),
        mergedAt: null,
      });
    });
  });

  it("refreshes a stale open PR to merged through POST sync and GET branch view", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1356-merged",
        prNumber: 1357,
        title: "Stale local open PR",
      });
      mockGetSinglePullRequest.mockResolvedValueOnce({
        githubId: "github-pr-1357",
        number: 1357,
        title: "Merged from GitHub",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/1357`,
        headBranch: "FEA-1356-merged",
        baseBranch: "main",
        state: ApiGitHubPRState.Merged,
        mergedAt: "2026-05-20T10:00:00Z",
        closedAt: "2026-05-20T10:00:01Z",
        authorLogin: "octocat",
        isDraft: true,
        headSha: "merged-head-sha",
        baseSha: "base-sha",
        mergeCommitSha: "merge-commit-sha",
      });

      await expectSuccess<{ synced: true }>(
        await syncBranchView(
          branchViewSyncRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      const persisted = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { artifact: true, currentPullRequestDetail: true },
        })
      );

      expect(branchView.prState).toBe(ApiGitHubPRState.Merged);
      expect(branchView.currentPullRequest).toMatchObject({
        number: 1357,
        title: "Merged from GitHub",
        state: ApiGitHubPRState.Merged,
      });
      expect(persisted?.artifact.status).toBe(GitHubPRState.MERGED);
      expect(persisted?.headSha).toBe("merged-head-sha");
      expect(persisted?.currentPullRequestDetail).toMatchObject({
        prState: GitHubPRState.MERGED,
        title: "Merged from GitHub",
        isDraft: true,
        closedAt: new Date("2026-05-20T10:00:01Z"),
        mergedAt: new Date("2026-05-20T10:00:00Z"),
        mergeCommitSha: "merge-commit-sha",
      });
    });
  });

  it("relinks PR-backed branch artifacts when GitHub reinstall creates an active replacement repository", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const suffix = ctx.organizationId.replaceAll("-", "").slice(0, 8);
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `old-${ctx.githubRepoId}`,
            accountId: `old-acct-${suffix}`,
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
      const staleRepository = oldInstallation.repositories[0];
      if (!staleRepository) {
        throw new Error("Failed to seed stale repository");
      }
      const staleCtx = {
        ...ctx,
        repositoryId: staleRepository.id,
        installationId: oldInstallation.installationId,
      };
      const seeded = await seedBranchWithCurrentPr(staleCtx, {
        branchName: "FEA-1128-reinstall",
        lastRefreshAttemptAt: null,
        lastVerifiedAt: null,
        prNumber: 1128,
        title: "Reinstall branch view PR",
      });

      const readNoWriteState = () =>
        withDb(async (db) => {
          const [branch, branchRows, pullRequest, fileRows, repositories] =
            await Promise.all([
              db.branchDetail.findUnique({
                where: { artifactId: seeded.artifactId },
                select: {
                  repositoryId: true,
                  currentPullRequestDetailId: true,
                  fileCacheHeadSha: true,
                  fileCacheFileCount: true,
                  fileCachePatchBytes: true,
                  syncStatus: true,
                  lastSyncStartedAt: true,
                  lastSyncCompletedAt: true,
                  lastSyncErrorCode: true,
                  lastSyncErrorMessage: true,
                },
              }),
              db.branchDetail.findMany({
                where: { branchName: "FEA-1128-reinstall" },
                select: {
                  artifactId: true,
                  repositoryId: true,
                  currentPullRequestDetailId: true,
                },
                orderBy: { artifactId: "asc" },
              }),
              db.pullRequestDetail.findUnique({
                where: { id: seeded.prDetailId },
                select: {
                  repositoryId: true,
                  branchArtifactId: true,
                  lastRefreshAttemptAt: true,
                  lastVerifiedAt: true,
                  prState: true,
                  title: true,
                },
              }),
              db.branchFileChange.findMany({
                where: { branchArtifactId: seeded.artifactId },
                select: { headSha: true, path: true, patchBytes: true },
                orderBy: [{ headSha: "asc" }, { path: "asc" }],
              }),
              db.gitHubInstallationRepository.findMany({
                where: { id: { in: [staleRepository.id, ctx.repositoryId] } },
                select: {
                  id: true,
                  installationId: true,
                  githubRepoId: true,
                  removedAt: true,
                },
                orderBy: { id: "asc" },
              }),
            ]);
          return { branch, branchRows, pullRequest, fileRows, repositories };
        });
      const beforeGet = await readNoWriteState();
      const staleResponse = await getBranchView(
        branchViewRequest(seeded.artifactId),
        routeContext({ externalLinkId: seeded.artifactId })
      );
      expect(staleResponse.status).toBe(200);
      await flushWaitUntil();
      const afterGet = await readNoWriteState();
      expect(afterGet).toEqual(beforeGet);
      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      const beforeRelink = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      expect(beforeRelink?.repositoryId).toBe(staleRepository.id);
      expect(beforeRelink?.currentPullRequestDetail?.repositoryId).toBe(
        staleRepository.id
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
          where: { artifactId: seeded.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      expect(repaired?.repositoryId).toBe(ctx.repositoryId);
      expect(repaired?.currentPullRequestDetail?.repositoryId).toBe(
        ctx.repositoryId
      );

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(branchView).toMatchObject({
        externalLinkId: seeded.artifactId,
        prNumber: 1128,
        prTitle: "Reinstall branch view PR",
        repoFullName: ctx.repositoryFullName,
      });
      await flushWaitUntil();

      const repoName = ctx.repositoryFullName.split("/")[1] ?? "repo";
      mockGetSinglePullRequest.mockResolvedValueOnce({
        authorLogin: "author",
        baseBranch: "main",
        baseSha: "base-sha",
        closedAt: null,
        githubId: "1128",
        headBranch: "FEA-1128-reinstall",
        headSha: "migrated-head",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/1128`,
        isDraft: false,
        mergedAt: null,
        number: 1128,
        state: ApiGitHubPRState.Open,
        title: "Reinstall branch view PR",
      });
      await expectSuccess<{ synced: boolean }>(
        await syncBranchView(
          new NextRequest(
            `https://api.example.test/branch-view/${seeded.artifactId}/sync`,
            { method: "POST" }
          ),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(mockCompareBranchFileChanges).toHaveBeenLastCalledWith(
        ctx.installationId,
        "owner",
        repoName,
        "main",
        "migrated-head"
      );
      expect(mockListPullRequestReviews).not.toHaveBeenCalled();

      await expectSuccess<{ synced: boolean }>(
        await syncBranchView(
          new NextRequest(
            `https://api.example.test/branch-view/${seeded.artifactId}/sync`,
            {
              body: JSON.stringify({ scope: BranchViewSyncScope.Comments }),
              method: "POST",
            }
          ),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(mockListPullRequestReviews).toHaveBeenCalledWith(
        ctx.installationId,
        "owner",
        repoName,
        1128
      );
    });
  });

  it("relinks stale branch artifacts when repositories are added after reinstall", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `added-old-${ctx.githubRepoId}`,
            accountId: `added-old-${ctx.githubRepoId}`,
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

  it("does not relink stored branch artifacts during OAuth activation before repository fetch", async () => {
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
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `activation-old-${ctx.githubRepoId}`,
            accountId: `activation-old-${ctx.githubRepoId}`,
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
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "user-token" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 1, login: "sender" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              installations: [
                {
                  id: Number(ctx.installationId),
                  account: { id: 1, login: "owner", type: "Organization" },
                  permissions: {},
                  events: [],
                  repository_selection: "all",
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: vi.fn().mockReturnValue(null) },
          json: () => Promise.resolve({ repositories: [] }),
        });
      vi.stubGlobal("fetch", fetchMock);

      try {
        const result = await githubService.completeOAuthCallback(
          "oauth-code",
          undefined,
          "https://app.example.test/api/integrations/github/callback",
          ctx.organizationId,
          ctx.userId
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

  it("preserves historical branch and PR rows while tombstoned repositories block active callers until reconnect", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "FEA-2605-tombstone-lifecycle";
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName,
        lastRefreshAttemptAt: null,
        lastVerifiedAt: null,
        prNumber: 2605,
        title: "Tombstone lifecycle PR",
      });
      const loop = await withDb((db) =>
        db.loop.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            artifactId: ctx.sourceArtifactId,
            status: LoopStatus.RUNNING,
            command: LoopCommand.EXECUTE,
            repo: { fullName: ctx.repositoryFullName, branch: "main" },
            additionalRepos: [],
            metadata: {
              branchMaterialization: {
                schemaVersion: 1,
                branches: [
                  {
                    role: LoopBranchMaterializationRole.Primary,
                    repositoryFullName: ctx.repositoryFullName,
                    baseBranch: "main",
                    branchName,
                  },
                ],
              },
            },
          },
          select: { id: true },
        })
      );

      await githubService.removeRepositories(ctx.installationRecordId, [
        String(ctx.githubRepoId),
      ]);

      const tombstoned = await withDb((db) =>
        db.gitHubInstallationRepository.findUnique({
          where: { id: ctx.repositoryId },
          select: { id: true, removedAt: true },
        })
      );
      expect(tombstoned).toMatchObject({ id: ctx.repositoryId });
      expect(tombstoned?.removedAt).toBeInstanceOf(Date);

      const historical = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { currentPullRequestDetail: true },
        })
      );
      expect(historical?.repositoryId).toBe(ctx.repositoryId);
      expect(historical?.currentPullRequestDetail?.repositoryId).toBe(
        ctx.repositoryId
      );

      const view = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(view.currentPullRequest).toMatchObject({
        number: 2605,
        title: "Tombstone lifecycle PR",
      });
      await flushWaitUntil();
      expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
      expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();

      const rejectedCallback = await createLoopBranchArtifact({
        loopId: loop.id,
        organizationId: ctx.organizationId,
        body: {
          repositoryFullName: ctx.repositoryFullName,
          branchName,
          defaultBranch: "main",
          baseBranch: "main",
          headSha: "abc123def456abc123def456abc123def456abcd",
        },
      });
      expect(rejectedCallback).toEqual(Result.err(Status.Forbidden));

      const reconnected = await githubService.syncRepositories(
        ctx.installationRecordId,
        [
          {
            githubRepoId: String(ctx.githubRepoId),
            fullName: ctx.repositoryFullName,
            name: ctx.repositoryFullName.split("/")[1] ?? "repo",
            owner: "owner",
            private: false,
          },
        ]
      );
      expect(reconnected).toHaveLength(1);
      expect(reconnected[0]?.id).toBe(ctx.repositoryId);

      const activeAgain = await withDb((db) =>
        db.gitHubInstallationRepository.findUnique({
          where: { id: ctx.repositoryId },
          select: { removedAt: true },
        })
      );
      expect(activeAgain?.removedAt).toBeNull();
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
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `collision-old-${ctx.githubRepoId}`,
            accountId: `collision-old-${ctx.githubRepoId}`,
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
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `cross-org-pr-collision-old-${ctx.githubRepoId}`,
            accountId: `cross-org-pr-collision-old-${ctx.githubRepoId}`,
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
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `bad-current-old-${ctx.githubRepoId}`,
            accountId: `bad-current-old-${ctx.githubRepoId}`,
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
      const oldInstallation = await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: null,
            installationId: `branch-collision-old-${ctx.githubRepoId}`,
            accountId: `branch-collision-old-${ctx.githubRepoId}`,
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

  it("materializes a branch from push, then attaches current PR detail from a pull_request webhook", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "FEA-1116-webhook-flow";

      mockCompareBranchFileChanges.mockResolvedValueOnce([
        {
          filename: "src/webhook.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: "@@ webhook",
        },
      ]);
      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "before-push",
          after: "push-head",
        })
      );
      await flushWaitUntil();

      const pushedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      await expectBranchViewUnavailable(
        await getBranchView(
          branchViewRequest(pushedBranch.artifactId),
          routeContext({ externalLinkId: pushedBranch.artifactId })
        )
      );

      await handlePullRequest(
        pullRequestEvent(ctx, {
          branchName,
          title: "Branch PR from webhook",
          htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/42`,
          headSha: "pr-head",
        })
      );
      const branchWithPr = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(branchWithPr.currentPullRequestDetail).toMatchObject({
        title: "Branch PR from webhook",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/42`,
      });

      await withDb((db) =>
        db.gitHubPRReview.create({
          data: {
            pullRequestId: branchWithPr.currentPullRequestDetail?.id ?? "",
            githubReviewId: "review-42",
            authorLogin: "reviewer",
            authorAvatarUrl: null,
            state: DbReviewDecision.APPROVED,
            body: "Looks good",
            htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/42#pullrequestreview-42`,
            submittedAt: new Date("2026-05-15T01:00:00Z"),
          },
        })
      );

      const prView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(branchWithPr.artifactId),
          routeContext({ externalLinkId: branchWithPr.artifactId })
        )
      );
      expect(prView.currentPullRequest).toMatchObject({
        number: 42,
        title: "Branch PR from webhook",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/42`,
        state: GitHubPRState.OPEN,
      });
      expect(prView).toMatchObject({
        prTitle: "Branch PR from webhook",
        prHtmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/42`,
        prState: GitHubPRState.OPEN,
      });
      expect(prView.reviews).toEqual([
        expect.objectContaining({
          id: "review-42",
          author: "reviewer",
          state: ReviewDecision.Approved,
        }),
      ]);
      await flushWaitUntil();
    });
  });

  it("shows an existing local branch only after a matching repository-scoped push webhook", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "FEA-2527-existing-local";
      const headSha = "same-head-sha";
      const sidecarFullName = `${ctx.repositoryFullName}-sidecar`;
      const sidecarRepository = await withDb((db) =>
        db.gitHubInstallationRepository.create({
          data: {
            installationId: ctx.installationRecordId,
            githubRepoId: `${ctx.githubRepoId}-sidecar`,
            fullName: sidecarFullName,
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

      expect(
        await branchReadService.getBranchDetail(
          ctx.organizationId,
          primaryResult.value.id
        )
      ).toBeNull();
      expect(
        await branchReadService.getBranchDetail(
          ctx.organizationId,
          sidecarResult.value.id
        )
      ).toBeNull();
      await expect(
        branchCommentsService.getBranchComments(
          ctx.organizationId,
          primaryResult.value.id
        )
      ).resolves.toBeNull();
      let list = await branchReadService.listBranches(ctx.organizationId, {
        limit: 50,
        offset: 0,
        repository: [ctx.repositoryFullName],
        search: branchName,
        status: [BranchStatus.Open],
      });
      expect(list.items).toEqual([]);

      mockCompareBranchFileChanges.mockResolvedValueOnce([]);
      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "parent-head-sha",
          after: headSha,
          pushedAt: "2026-05-15T01:00:00Z",
        })
      );
      await flushWaitUntil();

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
      list = await branchReadService.listBranches(ctx.organizationId, {
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
          dataState: BranchDataState.NoSessions,
          prNumber: null,
          sessionIds: [],
          status: BranchStatus.Open,
        }),
      ]);
      await expect(
        branchReadService.getBranchDetail(
          ctx.organizationId,
          primaryResult.value.id
        )
      ).resolves.toMatchObject({
        id: primaryResult.value.id,
        branchName,
        dataState: BranchDataState.NoSessions,
      });
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
      await expect(
        branchReadService.listBranches(ctx.organizationId, {
          limit: 50,
          offset: 0,
          repository: [sidecarFullName],
          search: branchName,
          status: [BranchStatus.Open],
        })
      ).resolves.toMatchObject({ items: [] });
      await expect(
        branchReadService.getBranchDetail(
          ctx.organizationId,
          sidecarResult.value.id
        )
      ).resolves.toBeNull();
      await expect(
        branchCommentsService.getBranchComments(
          ctx.organizationId,
          sidecarResult.value.id
        )
      ).resolves.toBeNull();
    });
  });

  it("ignores wrong-repository current PR rows when listing local branches", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
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
            githubId: "wrong-repo-current-pr-2527",
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

  it("re-lists a push-only branch when GitHub deletes and recreates the ref", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
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
          dataState: BranchDataState.NoSessions,
          prNumber: null,
          sessionIds: [],
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
          dataState: BranchDataState.NoSessions,
          prNumber: null,
          sessionIds: [],
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
          dataState: BranchDataState.NoSessions,
          prNumber: null,
          sessionIds: [],
          status: BranchStatus.Open,
        }),
      ]);
    });
  });

  it("re-lists a delete-first branch when a later GitHub create push arrives", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
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
          dataState: BranchDataState.NoSessions,
          prNumber: null,
          sessionIds: [],
          status: BranchStatus.Open,
        }),
      ]);
    });
  });

  it("smoke-tests migrated branch projections through branch view, document, loop, and deployment boundaries", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1116-migrated",
        prNumber: 87,
      });
      const loop = await withDb((db) =>
        db.loop.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            artifactId: ctx.sourceArtifactId,
            status: LoopStatus.COMPLETED,
            command: LoopCommand.EXECUTE,
            repo: { fullName: ctx.repositoryFullName, branch: "main" },
            branchName: "FEA-1116-migrated",
          },
          select: { id: true },
        })
      );
      const deployment = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: ctx.organizationId,
            projectId: ctx.projectId,
            type: ArtifactType.DEPLOYMENT,
            name: "Preview deployment",
            status: "success",
            externalUrl: "https://preview.example.test",
            deployment: {
              create: {
                environment: "preview",
                ref: "FEA-1116-migrated",
                sha: "migrated-head",
                branchArtifactId: seeded.artifactId,
              },
            },
          },
          select: { id: true },
        })
      );

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(branchView.branch).toMatchObject({
        branchName: "FEA-1116-migrated",
        headSha: "migrated-head",
      });
      expect(branchView.currentPullRequest).toMatchObject({
        number: 87,
        title: "Migrated PR title",
      });

      const pullRequests = await expectSuccess(
        await getDocumentPullRequests(
          new NextRequest(
            `https://api.example.test/documents/${ctx.sourceArtifactId}/pull-request`
          ),
          routeContext({ id: ctx.sourceArtifactId })
        )
      );
      expect(pullRequests).toEqual([
        expect.objectContaining({
          number: 87,
          headBranch: "FEA-1116-migrated",
          repoFullName: ctx.repositoryFullName,
        }),
      ]);

      const loopDetail = await expectSuccess<LoopDetail>(
        await getLoop(
          new NextRequest(`https://api.example.test/loops/${loop.id}`),
          routeContext({ id: loop.id })
        )
      );
      expect(loopDetail.primaryBranch).toMatchObject({
        branchName: "FEA-1116-migrated",
        repoFullName: ctx.repositoryFullName,
      });
      expect(loopDetail.primaryPullRequest).toMatchObject({
        number: 87,
      });

      const deploymentDetail = await deploymentService.findById(
        deployment.id,
        ctx.organizationId
      );
      expect(deploymentDetail?.deployment?.branchArtifactId).toBe(
        seeded.artifactId
      );
    });
  });

  it("projects current-head status checks through the real branch view GET boundary", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const current = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1375-current-checks",
        prNumber: 1375,
        title: "Current checks projection",
      });
      const legacy = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1375-legacy-checks",
        prNumber: 1376,
        title: "Legacy checks omission",
      });
      const stale = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1375-stale-checks",
        prNumber: 1377,
        title: "Stale checks omission",
      });
      const providerUnavailable = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1375-provider-unavailable",
        prNumber: 1378,
        title: "Provider unavailable checks",
      });
      const noChecks = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1375-no-checks",
        prNumber: 1379,
        title: "No checks configured",
      });

      await withDb(async (db) => {
        await db.branchDetail.update({
          where: { artifactId: current.artifactId },
          data: {
            checksStatus: ChecksStatus.FAILING,
            checksDetailHeadSha: "migrated-head",
            checksDetailTotalCount: 3,
            checksDetailTruncated: true,
            checksDetailProviderState: BranchViewChecksProviderState.Available,
            checksDetailUnavailableReason: null,
            checksDetailUpdatedAt: new Date("2026-05-28T08:00:00Z"),
          },
        });
        await db.branchStatusCheck.createMany({
          data: [
            {
              branchArtifactId: current.artifactId,
              headSha: "migrated-head",
              providerKey: "node:current-build",
              kind: BranchViewCheckKind.CheckRun,
              providerNodeId: "check-run-node-1",
              name: "Build and test",
              status: "COMPLETED",
              conclusion: "FAILURE",
              targetUrl: "https://github.com/example/repo/actions/runs/1375",
              position: 1,
            },
            {
              branchArtifactId: current.artifactId,
              headSha: "migrated-head",
              providerKey: "context:unsafe-link",
              kind: BranchViewCheckKind.StatusContext,
              providerNodeId: null,
              name: "Unsafe target",
              status: "FAILURE",
              conclusion: null,
              targetUrl: "javascript:alert(1)",
              position: 2,
            },
            {
              branchArtifactId: current.artifactId,
              headSha: "old-head",
              providerKey: "node:stale-hidden",
              kind: BranchViewCheckKind.CheckRun,
              providerNodeId: "stale-node",
              name: "Old head check",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              targetUrl: "https://github.com/example/repo/actions/runs/old",
              position: 0,
            },
          ],
        });
        await db.branchDetail.update({
          where: { artifactId: stale.artifactId },
          data: {
            checksDetailHeadSha: "old-head",
            checksDetailTotalCount: 1,
            checksDetailTruncated: false,
            checksDetailProviderState: BranchViewChecksProviderState.Available,
            checksDetailUnavailableReason: null,
            checksDetailUpdatedAt: new Date("2026-05-28T08:01:00Z"),
          },
        });
        await db.branchStatusCheck.create({
          data: {
            branchArtifactId: stale.artifactId,
            headSha: "old-head",
            providerKey: "node:stale-only",
            kind: BranchViewCheckKind.CheckRun,
            providerNodeId: "stale-only-node",
            name: "Stale only",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            targetUrl: "https://github.com/example/repo/actions/runs/stale",
            position: 0,
          },
        });
        await db.branchDetail.update({
          where: { artifactId: providerUnavailable.artifactId },
          data: {
            checksStatus: ChecksStatus.PASSING,
            checksDetailHeadSha: "migrated-head",
            checksDetailTotalCount: 1,
            checksDetailTruncated: false,
            checksDetailProviderState:
              BranchViewChecksProviderState.ProviderUnavailable,
            checksDetailUnavailableReason:
              StatusCheckRollupFailureReason.RateLimited,
            checksDetailUpdatedAt: new Date("2026-05-28T08:02:00Z"),
          },
        });
        await db.branchStatusCheck.create({
          data: {
            branchArtifactId: providerUnavailable.artifactId,
            headSha: "migrated-head",
            providerKey: "node:last-known",
            kind: BranchViewCheckKind.CheckRun,
            providerNodeId: "last-known-node",
            name: "Last known passing check",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            targetUrl: "https://github.com/example/repo/actions/runs/last",
            position: 0,
          },
        });
        await db.branchDetail.update({
          where: { artifactId: noChecks.artifactId },
          data: {
            checksStatus: ChecksStatus.UNKNOWN,
            checksDetailHeadSha: "migrated-head",
            checksDetailTotalCount: 0,
            checksDetailTruncated: false,
            checksDetailProviderState: BranchViewChecksProviderState.NoChecks,
            checksDetailUnavailableReason: null,
            checksDetailUpdatedAt: new Date("2026-05-28T08:03:00Z"),
          },
        });
      });

      const currentView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(current.artifactId),
          routeContext({ externalLinkId: current.artifactId })
        )
      );
      expect(currentView.checks).toEqual({
        headSha: "migrated-head",
        providerState: BranchViewChecksProviderState.Available,
        unavailableReason: null,
        totalCount: 3,
        truncated: true,
        items: [
          {
            id: "node:current-build",
            kind: BranchViewCheckKind.CheckRun,
            name: "Build and test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            targetUrl: "https://github.com/example/repo/actions/runs/1375",
          },
          {
            id: "context:unsafe-link",
            kind: BranchViewCheckKind.StatusContext,
            name: "Unsafe target",
            status: "FAILURE",
            conclusion: null,
            targetUrl: null,
          },
        ],
      });

      const legacyView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(legacy.artifactId),
          routeContext({ externalLinkId: legacy.artifactId })
        )
      );
      expect(legacyView.checks).toBeUndefined();

      const staleView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(stale.artifactId),
          routeContext({ externalLinkId: stale.artifactId })
        )
      );
      expect(staleView.checks).toBeUndefined();

      const unavailableView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(providerUnavailable.artifactId),
          routeContext({ externalLinkId: providerUnavailable.artifactId })
        )
      );
      expect(unavailableView.checks).toMatchObject({
        headSha: "migrated-head",
        providerState: BranchViewChecksProviderState.ProviderUnavailable,
        unavailableReason: StatusCheckRollupFailureReason.RateLimited,
        totalCount: 1,
        truncated: false,
        items: [],
      });

      const noChecksView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(noChecks.artifactId),
          routeContext({ externalLinkId: noChecks.artifactId })
        )
      );
      expect(noChecksView.checks).toEqual({
        headSha: "migrated-head",
        providerState: BranchViewChecksProviderState.NoChecks,
        unavailableReason: null,
        totalCount: 0,
        truncated: false,
        items: [],
      });

      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      await flushWaitUntil();
    });
  });

  it("projects a stale syncing branch as settled", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1375-stale-syncing",
        prNumber: 1180,
        title: "Stale syncing state",
      });
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: seeded.artifactId },
          data: {
            syncStatus: BranchSyncStatus.Syncing,
            lastSyncStartedAt: new Date("2026-05-28T00:00:00Z"),
            lastSyncCompletedAt: null,
            lastSyncErrorCode: null,
            lastSyncErrorMessage: null,
          },
        })
      );

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      const syncState = branchView.syncState;
      expect(syncState).toBeDefined();
      if (!syncState) {
        throw new Error("Expected Branch View sync state");
      }
      expect(syncState.inProgress).toBe(false);
      expect(syncState.presentation).toBe(
        BranchViewSyncPresentationState.Fresh
      );
      expect(syncState.backgroundRefreshAfterAt).not.toBeNull();
      await flushWaitUntil();
    });
  });

  it("syncs status-check data recovered from partial GraphQL into rows returned by Branch View GET", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "FEA-1375-partial-graphql";
      const recoveredHeadSha = "ba5d196f813e816006f6ef2515c5c99b240530c7";
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName,
        prNumber: 1178,
        title: "Partial GraphQL rollup recovery",
      });
      await withDb(async (db) => {
        await db.branchDetail.update({
          where: { artifactId: seeded.artifactId },
          data: {
            checksDetailHeadSha: recoveredHeadSha,
            checksDetailProviderState: BranchViewChecksProviderState.Available,
            checksDetailTotalCount: 2,
            checksDetailTruncated: false,
            checksDetailUpdatedAt: new Date("2026-05-28T19:40:00Z"),
            headSha: recoveredHeadSha,
          },
        });
        await db.branchStatusCheck.createMany({
          data: [
            {
              branchArtifactId: seeded.artifactId,
              headSha: recoveredHeadSha,
              providerKey: "node:historical-e2e",
              kind: BranchViewCheckKind.CheckRun,
              providerNodeId: "historical-e2e",
              name: "e2e",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              targetUrl: "https://github.com/owner/repo/actions/runs/old",
              position: 0,
            },
            {
              branchArtifactId: seeded.artifactId,
              headSha: recoveredHeadSha,
              providerKey: "node:historical-lint",
              kind: BranchViewCheckKind.CheckRun,
              providerNodeId: "historical-lint",
              name: "lint",
              status: "COMPLETED",
              conclusion: "FAILURE",
              targetUrl: "https://github.com/owner/repo/actions/runs/old-lint",
              position: 1,
            },
          ],
        });
      });
      mockGetSinglePullRequest.mockResolvedValueOnce(
        freshPullRequest(ctx, {
          branchName,
          headSha: recoveredHeadSha,
          number: 1178,
          title: "Partial GraphQL rollup recovery",
        })
      );
      mockQueryStatusCheckRollup.mockResolvedValueOnce({
        ok: true,
        state: "FAILURE",
        totalCount: 2,
        truncated: false,
        checks: [
          {
            id: "node:node-failing-e2e",
            kind: BranchViewCheckKind.CheckRun,
            providerNodeId: "node-failing-e2e",
            name: "e2e",
            status: "COMPLETED",
            conclusion: "FAILURE",
            targetUrl: "https://github.com/owner/repo/actions/runs/1178",
            position: 0,
          },
          {
            id: "context:Vercel - app-stage:1",
            kind: BranchViewCheckKind.StatusContext,
            providerNodeId: null,
            name: "Vercel - app-stage",
            status: "SUCCESS",
            conclusion: null,
            targetUrl: "https://vercel.com/owner/repo/1178",
            position: 1,
          },
        ],
      });

      await expectSuccess<{ synced: true }>(
        await syncBranchView(
          branchViewSyncRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );

      expect(mockQueryStatusCheckRollup).toHaveBeenCalledWith(
        ctx.installationId,
        "owner",
        ctx.repositoryFullName.split("/")[1],
        recoveredHeadSha
      );
      const persisted = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: seeded.artifactId },
          include: { statusChecks: { orderBy: { position: "asc" } } },
        })
      );
      expect(persisted).toMatchObject({
        checksStatus: ChecksStatus.FAILING,
        checksDetailHeadSha: recoveredHeadSha,
        checksDetailTotalCount: 2,
        checksDetailTruncated: false,
        checksDetailProviderState: BranchViewChecksProviderState.Available,
        checksDetailUnavailableReason: null,
      });
      expect(persisted?.statusChecks.map((check) => check.name)).toEqual([
        "e2e",
        "Vercel - app-stage",
      ]);
      expect(persisted?.statusChecks).toEqual([
        expect.objectContaining({
          providerKey: "node:node-failing-e2e",
          headSha: recoveredHeadSha,
          kind: BranchViewCheckKind.CheckRun,
          providerNodeId: "node-failing-e2e",
          name: "e2e",
          status: "COMPLETED",
          conclusion: "FAILURE",
          targetUrl: "https://github.com/owner/repo/actions/runs/1178",
          position: 0,
        }),
        expect.objectContaining({
          providerKey: "context:Vercel - app-stage:1",
          headSha: recoveredHeadSha,
          kind: BranchViewCheckKind.StatusContext,
          providerNodeId: null,
          name: "Vercel - app-stage",
          status: "SUCCESS",
          conclusion: null,
          targetUrl: "https://vercel.com/owner/repo/1178",
          position: 1,
        }),
      ]);

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(branchView.checks).toEqual({
        headSha: recoveredHeadSha,
        providerState: BranchViewChecksProviderState.Available,
        unavailableReason: null,
        totalCount: 2,
        truncated: false,
        items: [
          {
            id: "node:node-failing-e2e",
            kind: BranchViewCheckKind.CheckRun,
            name: "e2e",
            status: "COMPLETED",
            conclusion: "FAILURE",
            targetUrl: "https://github.com/owner/repo/actions/runs/1178",
          },
          {
            id: "context:Vercel - app-stage:1",
            kind: BranchViewCheckKind.StatusContext,
            name: "Vercel - app-stage",
            status: "SUCCESS",
            conclusion: null,
            targetUrl: "https://vercel.com/owner/repo/1178",
          },
        ],
      });
      const syncState = branchView.syncState;
      expect(syncState).toBeDefined();
      if (!syncState) {
        throw new Error("Expected Branch View sync state");
      }
      expect(syncState.inProgress).toBe(false);
      expect(syncState.presentation).toBe(
        BranchViewSyncPresentationState.Fresh
      );
      await flushWaitUntil();
    });
  });

  it("materializes a branch from the loop harness context", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "symphony/fea-1116";
      const loop = await withDb((db) =>
        db.loop.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            artifactId: ctx.sourceArtifactId,
            status: LoopStatus.RUNNING,
            command: LoopCommand.EXECUTE,
            repo: { fullName: ctx.repositoryFullName, branch: "main" },
            metadata: {
              branchMaterialization: {
                schemaVersion: 1,
                branches: [
                  {
                    role: LoopBranchMaterializationRole.Primary,
                    repositoryFullName: ctx.repositoryFullName,
                    baseBranch: "main",
                    branchName,
                  },
                ],
              },
            },
          },
          select: { id: true },
        })
      );

      const harnessHeadSha = "1234567890abcdef1234567890abcdef12345678";
      const result = await createLoopBranchArtifact({
        loopId: loop.id,
        organizationId: ctx.organizationId,
        body: {
          repositoryFullName: ctx.repositoryFullName,
          branchName,
          defaultBranch: "main",
          baseBranch: "main",
          headSha: harnessHeadSha,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected harness materialization to succeed");
      }

      const branch = await findBranchArtifact(ctx.repositoryId, branchName);
      expect(branch).toMatchObject({
        artifactId: result.value.id,
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
        headSha: harnessHeadSha,
        headShaSource: BranchHeadShaSource.HarnessInput,
      });
      const sourceLink = await withDb((db) =>
        db.artifactLink.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sourceId: ctx.sourceArtifactId,
            targetId: result.value.id,
            linkType: LinkType.Produces,
          },
        })
      );
      expect(sourceLink).not.toBeNull();

      await expectBranchViewUnavailable(
        await getBranchView(
          branchViewRequest(result.value.id),
          routeContext({ externalLinkId: result.value.id })
        )
      );
    });
  });

  it("materializes an additional-repo branch through the loop callback route when the source snapshot excludes that repo", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "symphony/fea-1476-sidecar";
      const sidecarFullName = `${ctx.repositoryFullName}-sidecar`;
      const sidecarRepository = await withDb((db) =>
        db.gitHubInstallationRepository.create({
          data: {
            installationId: ctx.installationRecordId,
            githubRepoId: `${ctx.githubRepoId}-sidecar`,
            fullName: sidecarFullName,
            name: sidecarFullName.split("/")[1] ?? "sidecar",
            owner: sidecarFullName.split("/")[0] ?? "owner",
            private: false,
          },
          select: { id: true, fullName: true },
        })
      );
      const loop = await withDb((db) =>
        db.loop.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            artifactId: ctx.sourceArtifactId,
            status: LoopStatus.RUNNING,
            command: LoopCommand.EXECUTE,
            repo: { fullName: ctx.repositoryFullName, branch: "main" },
            additionalRepos: [{ fullName: sidecarFullName, branch: "sidecar" }],
            metadata: {
              branchMaterialization: {
                schemaVersion: 1,
                branches: [
                  {
                    role: LoopBranchMaterializationRole.Additional,
                    repositoryFullName: sidecarFullName,
                    baseBranch: "sidecar",
                    branchName,
                  },
                ],
              },
            },
          },
          select: { id: true },
        })
      );
      mockAuthenticateLoopRunnerRequest.mockResolvedValue({
        loopId: loop.id,
        organizationId: ctx.organizationId,
        tokenId: "runner-token-id",
      });

      const requestBody = {
        repositoryFullName: sidecarFullName,
        branchName,
        defaultBranch: "main",
        baseBranch: "sidecar",
        headSha: "fedcba9876543210fedcba9876543210fedcba98",
      };
      const firstResult = await expectSuccess<{ id: string }>(
        await postLoopBranchArtifact(
          loopBranchArtifactRequest(loop.id, requestBody),
          routeContext({ id: loop.id })
        )
      );
      const retryResult = await expectSuccess<{ id: string }>(
        await postLoopBranchArtifact(
          loopBranchArtifactRequest(loop.id, requestBody),
          routeContext({ id: loop.id })
        )
      );

      expect(retryResult.id).toBe(firstResult.id);
      const branch = await findBranchArtifact(sidecarRepository.id, branchName);
      expect(branch).toMatchObject({
        artifactId: firstResult.id,
        repositoryId: sidecarRepository.id,
        baseBranch: "sidecar",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
        headSha: requestBody.headSha,
        headShaSource: BranchHeadShaSource.HarnessInput,
      });
      const sourceLink = await withDb((db) =>
        db.artifactLink.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sourceId: ctx.sourceArtifactId,
            targetId: firstResult.id,
            linkType: LinkType.Produces,
          },
        })
      );
      expect(sourceLink).not.toBeNull();
    });
  });

  it("verifies live GitHub state for the deprecated pull-request alias when payload includes headSha", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
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
      expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
        ctx.installationId,
        "owner",
        repoName,
        98
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

  it("fetches a missing headSha for the deprecated pull-request alias and supports explicit file-cache sync", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const [, repoName] = ctx.repositoryFullName.split("/");
      mockGetSinglePullRequest.mockResolvedValueOnce({
        githubId: "990099",
        number: 99,
        title: "Legacy alias PR",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/99`,
        headBranch: "FEA-1116-alias",
        baseBranch: "main",
        state: ApiGitHubPRState.Open,
        mergedAt: null,
        closedAt: null,
        authorLogin: "author",
        isDraft: false,
        headSha: "alias-head-sha",
        baseSha: "base-sha",
      });
      const response = await postPullRequestAlias(
        new NextRequest(
          "https://api.example.test/artifact-links/pull-requests",
          {
            method: "POST",
            body: JSON.stringify({
              projectId: ctx.projectId,
              title: "Legacy alias PR",
              externalUrl: `https://github.com/${ctx.repositoryFullName}/pull/99`,
              number: 99,
              githubId: "990099",
              headBranch: "FEA-1116-alias",
              baseBranch: "main",
              state: ApiGitHubPRState.Open,
            }),
          }
        ),
        routeContext({})
      );
      const result = await expectSuccess<{ id: string }>(response);
      expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
        ctx.installationId,
        "owner",
        repoName,
        99
      );

      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: result.id },
          include: {
            branch: { include: { currentPullRequestDetail: true } },
            pullRequest: true,
          },
        })
      );
      expect(artifact).toMatchObject({
        type: ArtifactType.BRANCH,
        name: "FEA-1116-alias",
      });
      expect(artifact?.pullRequest).toBeNull();
      expect(artifact?.branch).toMatchObject({
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        headSha: "alias-head-sha",
        headShaSource: BranchHeadShaSource.PullRequestWebhook,
      });
      expect(artifact?.branch?.currentPullRequestDetail).toMatchObject({
        title: "Legacy alias PR",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/99`,
      });

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(result.id),
          routeContext({ externalLinkId: result.id })
        )
      );
      expect(branchView.currentPullRequest).toMatchObject({
        number: 99,
        title: "Legacy alias PR",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/99`,
      });
      await flushWaitUntil();

      mockCompareBranchFileChanges.mockResolvedValueOnce([
        {
          filename: "src/alias.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ alias",
        },
      ]);
      mockGetSinglePullRequest.mockResolvedValueOnce({
        githubId: "990099",
        number: 99,
        title: "Legacy alias PR",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/99`,
        headBranch: "FEA-1116-alias",
        baseBranch: "main",
        state: ApiGitHubPRState.Open,
        mergedAt: null,
        closedAt: null,
        authorLogin: "author",
        isDraft: false,
        headSha: "alias-head-sha",
        baseSha: "base-sha",
      });
      await expectSuccess<{ synced: boolean }>(
        await syncBranchView(
          new NextRequest(
            `https://api.example.test/branch-view/${result.id}/sync`,
            { method: "POST" }
          ),
          routeContext({ externalLinkId: result.id })
        )
      );
      expect(mockCompareBranchFileChanges).toHaveBeenLastCalledWith(
        ctx.installationId,
        "owner",
        repoName,
        "main",
        "alias-head-sha"
      );
      const syncedBranch = await findBranchArtifact(
        ctx.repositoryId,
        "FEA-1116-alias"
      );
      expect(syncedBranch).toMatchObject({
        fileCacheStatus: BranchFileCacheStatus.Fresh,
        fileCacheHeadSha: "alias-head-sha",
        syncStatus: BranchSyncStatus.Fresh,
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
        ctx.installationId,
        "owner",
        repoName,
        101
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

  it("preserves stale cache rows on waitUntil failure and recovers through explicit sync", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const branchName = "FEA-1116-cache-flow";

      mockCompareBranchFileChanges.mockResolvedValueOnce([
        {
          filename: "src/old.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ old",
        },
      ]);
      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "before-1",
          after: "head-1",
        })
      );
      await flushWaitUntil();
      const initialBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      let cachedFiles = await withDb((db) =>
        db.branchFileChange.findMany({
          where: { branchArtifactId: initialBranch.artifactId },
          orderBy: { path: "asc" },
        })
      );
      expect(cachedFiles.map((file) => file.path)).toEqual(["src/old.ts"]);

      mockCompareBranchFileChanges.mockResolvedValueOnce(null);
      await handlePush(
        pushEvent(ctx, {
          branchName,
          before: "head-1",
          after: "head-2",
        })
      );
      await flushWaitUntil();
      const failedBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(failedBranch).toMatchObject({
        headSha: "head-2",
        fileCacheStatus: BranchFileCacheStatus.Failed,
        syncStatus: BranchSyncStatus.Failed,
        lastSyncErrorCode: BranchViewFileCacheSyncErrorCode.CompareFailed,
        fileCacheHeadSha: "head-1",
      });
      cachedFiles = await withDb((db) =>
        db.branchFileChange.findMany({
          where: { branchArtifactId: failedBranch.artifactId },
          orderBy: { path: "asc" },
        })
      );
      expect(cachedFiles.map((file) => file.path)).toEqual(["src/old.ts"]);
      const failedView = await expectBranchViewUnavailable(
        await getBranchView(
          branchViewRequest(failedBranch.artifactId),
          routeContext({ externalLinkId: failedBranch.artifactId })
        )
      );
      expect(JSON.stringify(failedView)).not.toContain(
        "GitHub compare failed while refreshing branch file cache"
      );

      mockCompareBranchFileChanges.mockResolvedValueOnce([
        {
          filename: "src/new.ts",
          status: "added",
          additions: 4,
          deletions: 0,
          changes: 4,
          patch: "@@ new",
        },
      ]);
      const throttledResponse = await syncBranchView(
        new NextRequest(
          `https://api.example.test/branch-view/${failedBranch.artifactId}/sync`,
          { method: "POST" }
        ),
        routeContext({ externalLinkId: failedBranch.artifactId })
      );
      expect(throttledResponse.status).toBe(429);
      expect(await throttledResponse.json()).toMatchObject({
        success: false,
        code: BranchViewSyncErrorCode.SyncThrottled,
      });
      expect(mockCompareBranchFileChanges).toHaveBeenCalledTimes(2);

      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: failedBranch.artifactId },
          data: {
            lastSyncStartedAt: new Date(
              failedBranch.lastSyncStartedAt!.getTime() - 61_000
            ),
          },
        })
      );
      await expectSuccess<{ synced: boolean }>(
        await syncBranchView(
          new NextRequest(
            `https://api.example.test/branch-view/${failedBranch.artifactId}/sync`,
            { method: "POST" }
          ),
          routeContext({ externalLinkId: failedBranch.artifactId })
        )
      );
      const recoveredBranch = await findBranchArtifact(
        ctx.repositoryId,
        branchName
      );
      expect(recoveredBranch).toMatchObject({
        fileCacheStatus: BranchFileCacheStatus.Fresh,
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncErrorCode: null,
        fileCacheHeadSha: "head-2",
      });
      cachedFiles = await withDb((db) =>
        db.branchFileChange.findMany({
          where: { branchArtifactId: recoveredBranch.artifactId },
          orderBy: { path: "asc" },
        })
      );
      expect(cachedFiles.map((file) => file.path)).toEqual(["src/new.ts"]);
    });
  });

  it("exposes PR-compatible and branch-native projections for the same PR-backed branch", async () => {
    await autoRollbackTransaction(async () => {
      const ctx = await setupContext();
      const seeded = await seedBranchWithCurrentPr(ctx, {
        branchName: "FEA-1116-flag-shapes",
        prNumber: 1116,
        title: "Flag shape PR",
      });

      const branchView = await expectSuccess<BranchViewData>(
        await getBranchView(
          branchViewRequest(seeded.artifactId),
          routeContext({ externalLinkId: seeded.artifactId })
        )
      );
      expect(branchView).toMatchObject({
        prTitle: "Flag shape PR",
        prNumber: 1116,
        prHtmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/1116`,
      });
      expect(branchView.branch).toMatchObject({
        artifactId: seeded.artifactId,
        branchName: "FEA-1116-flag-shapes",
      });
      expect(branchView.currentPullRequest).toMatchObject({
        title: "Flag shape PR",
        number: 1116,
      });

      const pullRequests =
        await documentPullRequestService.getDocumentPullRequests(
          ctx.sourceArtifactId,
          ctx.organizationId
        );
      const branches = await documentPullRequestService.getDocumentBranches(
        ctx.sourceArtifactId,
        ctx.organizationId
      );
      expect(pullRequests).toEqual([
        expect.objectContaining({
          title: "Flag shape PR",
          headBranch: "FEA-1116-flag-shapes",
        }),
      ]);
      expect(branches).toEqual([
        expect.objectContaining({
          branchName: "FEA-1116-flag-shapes",
          currentPullRequest: expect.objectContaining({
            title: "Flag shape PR",
          }),
        }),
      ]);
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
});
