import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

const installationAuthMocks = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: installationAuthMocks.getInstallationOctokit,
}));

// Marker client returned by the mocked resolver: provider-read mocks must
// receive this exact object as their first argument (PLN-1525).
const INSTALLATION_OCTOKIT = { marker: "installation-octokit" };

const syncServiceMocks = vi.hoisted(() => ({
  refreshTombstonedBranchPullRequest: vi.fn(),
}));

const tier2RefreshMocks = vi.hoisted(() => ({
  refreshResponseFromTier2Outcome: vi.fn(
    (
      outcome: {
        reason?: string;
        retryAfterSeconds?: number;
        status: string;
      },
      branch: unknown
    ) => ({
      branch,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.retryAfterSeconds
        ? { retryAfterSeconds: outcome.retryAfterSeconds }
        : {}),
    })
  ),
  isTier2BranchPullRequestRefreshInFlight: vi.fn(),
  refreshTier2BranchPullRequestOnRead: vi.fn(),
  refreshTier2TargetedBranchPullRequest: vi.fn(),
  shouldRefreshTier2BranchPullRequestOnRead: vi.fn(),
}));

vi.mock("@/app/integrations/github/sync-service", () => ({
  GitHubServerSyncReason: {
    AlreadyRefreshing: "already_refreshing",
    CredentialDecryptionFailed: "credential_decryption_failed",
    CredentialExpired: "credential_expired",
    CredentialInsufficientScope: "credential_insufficient_scope",
    CredentialRevoked: "credential_revoked",
    CrossUserDenied: "cross_user_denied",
    GuardedWriteFailed: "guarded_write_failed",
    InvalidRepositoryFullName: "invalid_repository_full_name",
    NoActiveRepository: "no_active_repository",
    NoCredential: "no_credential",
    NoCurrentPullRequest: "no_current_pull_request",
    NoEligibleSessionReference: "no_eligible_session_reference",
    NoTombstonedRepository: "no_tombstoned_repository",
    ProviderRateLimited: "provider_rate_limited",
    ProviderUnavailable: "provider_unavailable",
    Success: "success",
    Unsupported: "unsupported",
    Unknown: "unknown",
  },
  GitHubServerSyncStatus: {
    Failed: "failed",
    NotApplicable: "not_applicable",
    Refreshed: "refreshed",
    Retryable: "retryable",
  },
  githubServerSyncService: {
    refreshTombstonedBranchPullRequest:
      syncServiceMocks.refreshTombstonedBranchPullRequest,
  },
}));

vi.mock("./tier2-targeted-branch-refresh", () => ({
  isTier2BranchPullRequestRefreshInFlight:
    tier2RefreshMocks.isTier2BranchPullRequestRefreshInFlight,
  refreshResponseFromTier2Outcome:
    tier2RefreshMocks.refreshResponseFromTier2Outcome,
  refreshTier2BranchPullRequestOnRead:
    tier2RefreshMocks.refreshTier2BranchPullRequestOnRead,
  refreshTier2TargetedBranchPullRequest:
    tier2RefreshMocks.refreshTier2TargetedBranchPullRequest,
  shouldRefreshTier2BranchPullRequestOnRead:
    tier2RefreshMocks.shouldRefreshTier2BranchPullRequestOnRead,
}));

import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { GitHubInstallationStatus } from "@repo/database";
import {
  GitHubProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `branchReadService.refreshBranch` — the PROVIDER half of the read service:
 * branch-id validation, the refresh budget, tombstoned-repository handling, and
 * the claim/settle transaction around a live GitHub read.
 *
 * Split out of `branch-read-service.test.ts` (shrink-only grandfathered) into
 * this focused sibling, following `branch-read-service.cost.test.ts`, so editing
 * the oversized file does not grow it further. The seam is a real responsibility
 * boundary rather than a line-count cut: these are the only cases in that file
 * that reach a provider at all, and they owned every provider mock in it —
 * `@repo/github`, `@repo/github/installation-auth` and the GitHub sync-service —
 * so all four move here with them and the parent no longer mocks a network it
 * never touches.
 */
describe("branchReadService.refreshBranch", () => {
  const mockWithDb = getMockWithDb();
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    installationAuthMocks.getInstallationOctokit.mockResolvedValue(
      INSTALLATION_OCTOKIT
    );
    syncServiceMocks.refreshTombstonedBranchPullRequest.mockResolvedValue({
      status: "failed",
      reason: "no_eligible_session_reference",
    });
    tier2RefreshMocks.refreshTier2TargetedBranchPullRequest.mockResolvedValue({
      status: BranchRefreshStatus.Refreshed,
      shouldReloadBranch: true,
    });
    tier2RefreshMocks.refreshTier2BranchPullRequestOnRead.mockResolvedValue(
      undefined
    );
    tier2RefreshMocks.shouldRefreshTier2BranchPullRequestOnRead.mockReturnValue(
      false
    );
    tier2RefreshMocks.isTier2BranchPullRequestRefreshInFlight.mockReturnValue(
      false
    );
  });

  it("rejects encoded branch ids before database or provider work", async () => {
    const response = await branchReadService.refreshBranch(
      organizationId,
      "closedloop-ai%2Fclosedloop-ai::feature",
      { userId: "user-1", authMethod: "api_key" }
    );

    expect(response.reason).toBe(BranchRefreshReason.InvalidBranchId);
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("returns not applicable without budget or provider work when no current PR exists", async () => {
    // Visible via push state (firstPushedAt) but carrying no current PR — the
    // exact branch a refresh should short-circuit as NotApplicable.
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ currentPullRequestDetail: null, firstPushedAt: now })
    );

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.reason).toBe(BranchRefreshReason.NoCurrentPullRequest);
    expect(mockDb.oAuthRateLimit.findUnique).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("ISS-12278: answers the detail read from the database without the tier-2 refresh", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        repositoryId: null,
        firstPushedAt: now,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          repositoryId: null,
          repository: null,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          title: "Stale PR title",
        }),
      })
    );

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.prTitle).toBe("Stale PR title");
    expect(
      tier2RefreshMocks.refreshTier2BranchPullRequestOnRead
    ).not.toHaveBeenCalled();
    expect(detail).not.toHaveProperty("pullRequestRefreshPending");
  });

  it("ISS-12278: flags a stale selected PR so the route and client follow up", async () => {
    const row = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      currentPullRequestDetail: makeCurrentPullRequestDetail({
        repositoryId: null,
        repository: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        title: "Stale PR title",
      }),
    });
    mockDb.artifact.findFirst.mockResolvedValue(row);
    tier2RefreshMocks.shouldRefreshTier2BranchPullRequestOnRead.mockReturnValue(
      true
    );

    const onPullRequestRefreshDue = vi.fn();

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      undefined,
      undefined,
      { onPullRequestRefreshDue }
    );

    expect(detail?.pullRequestRefreshPending).toBe(true);
    expect(onPullRequestRefreshDue).toHaveBeenCalledTimes(1);
    expect(
      tier2RefreshMocks.shouldRefreshTier2BranchPullRequestOnRead
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id }),
      expect.any(Date),
      expect.objectContaining({ title: "Stale PR title" })
    );
    expect(
      tier2RefreshMocks.refreshTier2BranchPullRequestOnRead
    ).not.toHaveBeenCalled();
  });

  it("ISS-12278: keeps the flag up while a claimed refresh has not landed, without scheduling another", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        repositoryId: null,
        firstPushedAt: now,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          repositoryId: null,
          repository: null,
          repositoryFullName: "closedloop-ai/closedloop-ai",
        }),
      })
    );
    tier2RefreshMocks.isTier2BranchPullRequestRefreshInFlight.mockReturnValue(
      true
    );
    const onPullRequestRefreshDue = vi.fn();

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      undefined,
      undefined,
      { onPullRequestRefreshDue }
    );

    expect(detail?.pullRequestRefreshPending).toBe(true);
    expect(onPullRequestRefreshDue).not.toHaveBeenCalled();
  });

  it("refreshes stale repo-less current PRs after the detail read", async () => {
    const refreshActor = {
      authMethod: "session",
      userId: "user-1",
    };
    const staleTarget = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      currentPullRequestDetail: makeCurrentPullRequestDetail({
        repositoryId: null,
        repository: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        title: "Stale PR title",
      }),
    });
    mockDb.artifact.findFirst.mockResolvedValue(staleTarget);

    await branchReadService.refreshBranchDetailPullRequest({
      actor: refreshActor,
      branchId,
      organizationId,
    });

    expect(
      tier2RefreshMocks.refreshTier2BranchPullRequestOnRead
    ).toHaveBeenCalledWith(organizationId, branchId, staleTarget, {
      actor: refreshActor,
      promoteCurrent: true,
      pullRequestDetail: staleTarget.pullRequestDetails[0],
    });
  });

  it("refreshes the explicitly selected historical PR without promoting it", async () => {
    const refreshActor = {
      authMethod: "session",
      userId: "user-1",
    };
    const staleCurrentPr = makeCurrentPullRequestDetail({
      repositoryId: null,
      repository: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      title: "Current PR title",
    });
    const staleHistoricalPr = makeCurrentPullRequestDetail({
      id: "pr-detail-17",
      isCurrent: false,
      number: 17,
      repositoryId: null,
      repository: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      title: "Stale historical PR title",
    });
    const staleTarget = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      currentPullRequestDetail: staleCurrentPr,
      pullRequestDetails: [staleCurrentPr, staleHistoricalPr],
    });
    mockDb.artifact.findFirst.mockResolvedValue(staleTarget);

    await branchReadService.refreshBranchDetailPullRequest({
      actor: refreshActor,
      branchId,
      organizationId,
      requestedPullRequest: {
        pullRequestNumber: 17,
        repositoryFullName: "closedloop-ai/closedloop-ai",
      },
    });

    expect(
      tier2RefreshMocks.refreshTier2BranchPullRequestOnRead
    ).toHaveBeenCalledWith(organizationId, branchId, staleTarget, {
      actor: refreshActor,
      promoteCurrent: false,
      pullRequestDetail: staleHistoricalPr,
    });
  });

  it("fails open when the after-response refresh cannot run", async () => {
    mockDb.artifact.findFirst.mockRejectedValueOnce(new Error("db down"));

    await expect(
      branchReadService.refreshBranchDetailPullRequest({
        actor: { authMethod: "session", userId: "user-1" },
        branchId,
        organizationId,
      })
    ).resolves.toBeUndefined();
    expect(
      tier2RefreshMocks.refreshTier2BranchPullRequestOnRead
    ).not.toHaveBeenCalled();
  });

  it("returns not applicable when the only current PR belongs to another repository", async () => {
    // ISS-6656: the case above supplies no PR at all, so it passes whether or
    // not `getOwnedCurrentPullRequestDetail` filters by ownership. This one
    // supplies a PR that is present and refreshable-looking (isCurrent, number
    // 7) but foreign, and is the only case that notices the filter being
    // dropped.
    //
    // What that costs is NOT a cross-repository settle (whitlockk review):
    // `claimPullRequestRefresh` scopes its `updateMany` to the branch's own
    // `repositoryId`, so a `repo-2` detail matches zero rows and no GitHub read
    // or settle is ever reached. The defect is upstream of that — the branch
    // sails past this `NotApplicable` short-circuit, spends refresh budget, and
    // then reports `Retryable`/`AlreadyRefreshing`, telling the caller to retry
    // a claim that can never succeed and re-spending budget every time.
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          repositoryId: "repo-2",
        }),
        firstPushedAt: now,
      })
    );
    // Unused on the passing path, which never reaches a claim. It is seeded so
    // that WHEN the guard is dropped the case fails on its own assertions —
    // `Retryable` where `NotApplicable` was expected — rather than on a null
    // deref inside `claimPullRequestRefresh`. `count: 0` is what a real
    // `updateMany` returns here: the claim is scoped to the branch's own
    // `repositoryId`, so the foreign detail matches no row.
    mockDb.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.status).toBe(BranchRefreshStatus.NotApplicable);
    expect(response.reason).toBe(BranchRefreshReason.NoCurrentPullRequest);
    expect(mockDb.oAuthRateLimit.findUnique).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("does not refresh tombstoned branch repositories", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.NotFound,
      branch: { id: branchId, prState: GitHubPRState.Open },
    });
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(mockDb.pullRequestDetail.updateMany).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).toHaveBeenCalledWith({
      actorUserId: "user-1",
      branchArtifactId: branchId,
      organizationId,
      trigger: GitHubFetchTrigger.UserAction,
    });
  });

  it("does not invoke tombstoned sync when refresh budget is exhausted", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue({
      id: "actor-bucket",
      windowExpiresAt: new Date(now.getTime() + 30_000),
      requestCount: 5,
    });
    mockDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.BudgetExhausted,
      retryAfterSeconds: 30,
    });
    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("does not stamp API-key tombstoned refreshes as user actions", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});

    await branchReadService.refreshBranch(organizationId, branchId, {
      userId: "user-1",
      authMethod: "api_key",
    });

    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).toHaveBeenCalledWith({
      actorUserId: "user-1",
      branchArtifactId: branchId,
      organizationId,
      trigger: GitHubFetchTrigger.Unknown,
    });
  });

  it("refreshes repo-less tier-2 branches through the targeted point-read path", async () => {
    const target = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      currentPullRequestDetail: makeCurrentPullRequestDetail({
        repositoryId: null,
        repository: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
      }),
    });
    mockDb.artifact.findFirst.mockResolvedValue(target);
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.status).toBe(BranchRefreshStatus.Refreshed);
    expect(
      tier2RefreshMocks.refreshTier2TargetedBranchPullRequest
    ).toHaveBeenCalledWith({
      organizationId,
      target,
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });
    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("maps tombstoned owner-token rate limits to retryable refresh", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    syncServiceMocks.refreshTombstonedBranchPullRequest.mockResolvedValueOnce({
      status: "retryable",
      reason: "provider_rate_limited",
      retryAfterSeconds: 45,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 45,
    });
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("claims the current PR before provider work and settles only allowed fields", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        githubId: "pr-gh-1",
        number: 7,
        title: "Refresh me",
        htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: GitHubPRState.Merged,
        createdAt: "2026-07-03T04:00:00.000Z",
        mergedAt: "2026-07-03T05:01:00.000Z",
        closedAt: "2026-07-03T05:01:00.000Z",
        authorLogin: "octocat",
        isDraft: false,
        headSha: "def",
        baseSha: "abc",
        mergeCommitSha: "merge-sha",
        additions: 33,
        deletions: 7,
        changedFiles: 4,
      },
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.status).toBe("refreshed");
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pr-detail-1",
          branchArtifactId: branchId,
          repository: {
            removedAt: null,
            installation: {
              organizationId,
              status: GitHubInstallationStatus.ACTIVE,
            },
          },
          OR: [
            { lastRefreshAttemptAt: null },
            { lastRefreshAttemptAt: { lt: new Date(now.getTime() - 30_000) } },
          ],
        }),
        data: { lastRefreshAttemptAt: now },
      })
    );
    // The refresh mints ONE installation client for the branch's installation
    // and threads it into the provider read (PLN-1525).
    expect(installationAuthMocks.getInstallationOctokit).toHaveBeenCalledWith(
      "installation-1"
    );
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "closedloop-ai",
      "closedloop-ai",
      7,
      expect.any(Object)
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          prState: GitHubPRState.Merged,
          // FEA-3552: settle persists the GitHub PR createdAt for the opened dot.
          githubCreatedAt: new Date("2026-07-03T04:00:00.000Z"),
          mergedAt: new Date("2026-07-03T05:01:00.000Z"),
          closedAt: new Date("2026-07-03T05:01:00.000Z"),
          isDraft: false,
          additions: 33,
          deletions: 7,
          changedFiles: 4,
          lastVerifiedAt: now,
        },
      })
    );
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
    // ISS-11767 added the PR-comment lane-proof read and ISS-9404 the
    // direct-participation read to the identity pass this refresh reprojects
    // through — each one raw statement for the whole page, not one per branch.
    // ISS-12463 removed the earliest-commit-author read: Owner is the assignee.
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(8);
  });

  it("folds an installation client mint rejection into retryable provider unavailable instead of rejecting (PLN-1525)", async () => {
    // The token exchange behind getInstallationOctokit is a network call; a
    // rejection must stay inside refreshBranch's errors-as-values contract and
    // resolve to the same retryable stale DTO a failed provider read produces.
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    installationAuthMocks.getInstallationOctokit.mockRejectedValue(
      new Error("installation token exchange failed")
    );

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
      branch: { id: branchId, prState: GitHubPRState.Open },
    });
    // The mint failed before the provider read could receive a client, and no
    // settlement writes fired.
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("folds a rate-limited installation client mint rejection into retryable provider rate limit with its retry signal (PLN-1525)", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    installationAuthMocks.getInstallationOctokit.mockRejectedValue(
      Object.assign(new Error("API rate limit exceeded"), {
        status: 429,
        headers: { "retry-after": "45" },
      })
    );

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 45,
      branch: { id: branchId, prState: GitHubPRState.Open },
    });
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("returns guarded write failure when provider settlement loses its scoped write", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        githubId: "pr-gh-1",
        number: 7,
        title: "Refresh me",
        htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: GitHubPRState.Merged,
        createdAt: "2026-07-03T04:00:00.000Z",
        mergedAt: "2026-07-03T05:01:00.000Z",
        closedAt: "2026-07-03T05:01:00.000Z",
        authorLogin: "octocat",
        isDraft: false,
        headSha: "def",
        baseSha: "abc",
        mergeCommitSha: "merge-sha",
      },
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.GuardedWriteFailed,
      branch: { id: branchId },
    });
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("claims null and stale refresh windows but rejects fresh claims before provider work", async () => {
    mockDb.artifact.findFirst.mockResolvedValueOnce(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          lastRefreshAttemptAt: null,
        }),
      })
    );
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await branchReadService.refreshBranch(organizationId, branchId, {
      userId: "user-1",
      authMethod: "session",
    });

    mockDb.artifact.findFirst.mockResolvedValueOnce(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          lastRefreshAttemptAt: new Date(now.getTime() - 30_001),
        }),
      })
    );
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await branchReadService.refreshBranch(organizationId, branchId, {
      userId: "user-1",
      authMethod: "session",
    });

    mockDb.artifact.findFirst.mockResolvedValueOnce(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          lastRefreshAttemptAt: new Date(now.getTime() - 29_999),
        }),
      })
    );
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const freshResponse = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(freshResponse).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.AlreadyRefreshing,
      retryAfterSeconds: 30,
    });
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledTimes(2);
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { lastRefreshAttemptAt: null },
            { lastRefreshAttemptAt: { lt: new Date(now.getTime() - 30_000) } },
          ],
        }),
      })
    );
  });

  it("does not consume org budget when actor budget is exhausted", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue({
      id: "actor-bucket",
      windowExpiresAt: new Date(now.getTime() + 30_000),
      requestCount: 5,
    });
    mockDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.BudgetExhausted,
      retryAfterSeconds: 30,
    });
    expect(mockDb.oAuthRateLimit.findUnique).toHaveBeenCalledTimes(1);
    expect(mockDb.oAuthRateLimit.findUnique).toHaveBeenCalledWith({
      where: {
        bucket_subject: {
          bucket: "branch_refresh:actor",
          subject: "org-1:session:user-1",
        },
      },
      // ISS-9190 narrowed this read. Kept exact rather than relaxed to
      // `objectContaining`: this assertion's job is that the actor bucket is
      // the ONLY thing the exhausted path asks for, and a matcher that ignores
      // extra keys would stop saying that.
      select: { id: true, windowExpiresAt: true },
    });
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("recovers refresh budget creation races in a fresh transaction", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "actor-bucket",
        windowExpiresAt: new Date(now.getTime() + 30_000),
        requestCount: 1,
      })
      .mockResolvedValueOnce(null);
    mockDb.oAuthRateLimit.create
      .mockRejectedValueOnce(
        Object.assign(new Error("race"), { code: "P2002" })
      )
      .mockResolvedValueOnce({});
    mockDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 1 });
    mockDb.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.AlreadyRefreshing,
    });
    expect(mockWithDb.tx).toHaveBeenCalledTimes(3);
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });
});
