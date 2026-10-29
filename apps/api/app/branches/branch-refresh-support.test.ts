import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  branchId,
  makeBranchRow,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import type { BranchArtifactRow } from "./branch-read-service/persisted-row-read";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mockedWithDb = vi.fn();
  Object.assign(mockedWithDb, { tx: vi.fn() });
  return { ...actual, withDb: mockedWithDb };
});

vi.mock("@/app/integrations/github/sync-service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/integrations/github/sync-service")
    >();
  return {
    ...actual,
    githubServerSyncService: {
      refreshTombstonedBranchPullRequest: vi.fn(),
    },
  };
});

vi.mock("./branch-read-service/canonical-projection", () => ({
  projectCloudBranchRefreshDetail: vi.fn(),
}));

import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { projectCloudBranchRefreshDetail } from "./branch-read-service/canonical-projection";
import {
  claimPullRequestRefresh,
  consumeRefreshBudget,
  refreshTombstonedBranchPullRequest,
} from "./branch-refresh-support";

const syncRefresh = vi.mocked(
  githubServerSyncService.refreshTombstonedBranchPullRequest
);
const projectRefreshDetail = vi.mocked(projectCloudBranchRefreshDetail);
const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};

const projectedBranchMarker = { marker: "projected-branch" } as never;
const actor = { userId: "user-1", authMethod: "session" };
const target = makeBranchRow({ repositoryId: null });

const oAuthRateLimit = {
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  projectRefreshDetail.mockReturnValue(projectedBranchMarker);
  mockWithDb.tx.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ oAuthRateLimit })
  );
  oAuthRateLimit.create.mockResolvedValue({ id: "rate-created" });
  oAuthRateLimit.updateMany.mockResolvedValue({ count: 1 });
});

describe("refreshTombstonedBranchPullRequest", () => {
  it("loads the fresh branch detail through the caller-supplied loader when sync refreshes", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Refreshed,
      reason: "success",
    } as never);
    const getBranchDetail = vi.fn().mockResolvedValue({ marker: "fresh" });

    const result = await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      actor,
      target,
      getBranchDetail
    );

    expect(result).toEqual({
      branch: { marker: "fresh" },
      status: BranchRefreshStatus.Refreshed,
    });
    expect(getBranchDetail).toHaveBeenCalledWith(
      organizationId,
      branchId,
      undefined
    );
    expect(projectRefreshDetail).not.toHaveBeenCalled();
  });

  it("omits retryAfterSeconds from a retryable response when sync does not supply one", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.ProviderUnavailable,
    } as never);

    const result = await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      actor,
      target,
      vi.fn()
    );

    expect(result).toEqual({
      branch: projectedBranchMarker,
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
    });
    expect(result).not.toHaveProperty("retryAfterSeconds");
  });

  it("carries retryAfterSeconds through a retryable response when sync supplies one", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.ProviderRateLimited,
      retryAfterSeconds: 42,
    } as never);

    const result = await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      actor,
      target,
      vi.fn()
    );

    expect(result).toEqual({
      branch: projectedBranchMarker,
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 42,
    });
  });

  it("maps a not-applicable sync result to a not-applicable response", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.NotApplicable,
      reason: GitHubServerSyncReason.NoCurrentPullRequest,
    } as never);

    const result = await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      actor,
      target,
      vi.fn()
    );

    expect(result).toEqual({
      branch: projectedBranchMarker,
      status: BranchRefreshStatus.NotApplicable,
      reason: BranchRefreshReason.NoCurrentPullRequest,
    });
  });

  it("maps a failed sync result to a failed response", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.GuardedWriteFailed,
    } as never);

    const result = await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      actor,
      target,
      vi.fn()
    );

    expect(result).toEqual({
      branch: projectedBranchMarker,
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.GuardedWriteFailed,
    });
  });

  it("selects the session-auth GitHub fetch trigger for a session actor", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.Unknown,
    } as never);

    await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" },
      target,
      vi.fn()
    );

    expect(syncRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: GitHubFetchTrigger.UserAction })
    );
  });

  it("falls back to the unknown GitHub fetch trigger for a non-session actor", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.Unknown,
    } as never);

    await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "api_key" },
      target,
      vi.fn()
    );

    expect(syncRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: GitHubFetchTrigger.Unknown })
    );
  });

  const reasonMappings: [GitHubServerSyncReason, BranchRefreshReason][] = [
    [
      GitHubServerSyncReason.AlreadyRefreshing,
      BranchRefreshReason.AlreadyRefreshing,
    ],
    [
      GitHubServerSyncReason.GuardedWriteFailed,
      BranchRefreshReason.GuardedWriteFailed,
    ],
    [
      GitHubServerSyncReason.NoCurrentPullRequest,
      BranchRefreshReason.NoCurrentPullRequest,
    ],
    [
      GitHubServerSyncReason.NoCredential,
      BranchRefreshReason.GitHubIdentityRequired,
    ],
    [
      GitHubServerSyncReason.CredentialExpired,
      BranchRefreshReason.GitHubIdentityExpired,
    ],
    [
      GitHubServerSyncReason.CredentialRevoked,
      BranchRefreshReason.GitHubIdentityExpired,
    ],
    [
      GitHubServerSyncReason.CredentialDecryptionFailed,
      BranchRefreshReason.GitHubIdentityExpired,
    ],
    [
      GitHubServerSyncReason.CredentialInsufficientScope,
      BranchRefreshReason.GitHubIdentityInsufficientScope,
    ],
    [
      GitHubServerSyncReason.ProviderRateLimited,
      BranchRefreshReason.ProviderRateLimited,
    ],
    [
      GitHubServerSyncReason.ProviderUnavailable,
      BranchRefreshReason.ProviderUnavailable,
    ],
    [GitHubServerSyncReason.CrossUserDenied, BranchRefreshReason.NotFound],
    [
      GitHubServerSyncReason.InvalidRepositoryFullName,
      BranchRefreshReason.NotFound,
    ],
    [GitHubServerSyncReason.NoActiveRepository, BranchRefreshReason.NotFound],
    [
      GitHubServerSyncReason.NoEligibleSessionReference,
      BranchRefreshReason.NotFound,
    ],
    [
      GitHubServerSyncReason.NoTombstonedRepository,
      BranchRefreshReason.NotFound,
    ],
    [GitHubServerSyncReason.Unsupported, BranchRefreshReason.NotFound],
    [GitHubServerSyncReason.Unknown, BranchRefreshReason.NotFound],
    // pins current behavior; looks odd because GitHubServerSyncReason.Success
    // should never reach this Failed/NotApplicable mapping path in practice,
    // yet the switch has no case for it and falls through to the default,
    // mapping a "success" reason to ProviderUnavailable.
    [GitHubServerSyncReason.Success, BranchRefreshReason.ProviderUnavailable],
  ];

  it.each(reasonMappings)(
    "maps sync reason %s to branch refresh reason %s",
    async (syncReason, expectedReason) => {
      syncRefresh.mockResolvedValue({
        status: GitHubServerSyncStatus.Failed,
        reason: syncReason,
      } as never);

      const result = await refreshTombstonedBranchPullRequest(
        organizationId,
        branchId,
        actor,
        target,
        vi.fn()
      );

      expect(result).toMatchObject({ reason: expectedReason });
    }
  );

  it("falls back to provider-unavailable for a sync reason outside the known set", async () => {
    syncRefresh.mockResolvedValue({
      status: GitHubServerSyncStatus.Failed,
      reason: "some-future-sync-reason",
    } as never);

    const result = await refreshTombstonedBranchPullRequest(
      organizationId,
      branchId,
      actor,
      target,
      vi.fn()
    );

    expect(result).toMatchObject({
      reason: BranchRefreshReason.ProviderUnavailable,
    });
  });
});

describe("claimPullRequestRefresh", () => {
  it("refuses to claim a refresh for a branch with no active repository", async () => {
    const repoLessTarget = makeBranchRow({
      repositoryId: null,
    }) as unknown as BranchArtifactRow;

    const result = await claimPullRequestRefresh(
      organizationId,
      repoLessTarget,
      "pr-detail-1",
      now
    );

    expect(result).toBe(false);
    expect(mockWithDb).not.toHaveBeenCalled();
  });
});

describe("consumeRefreshBudget", () => {
  it("rethrows a bucket-write failure that is not a unique-constraint race", async () => {
    oAuthRateLimit.findUnique.mockResolvedValue(null);
    oAuthRateLimit.create.mockRejectedValue(new Error("connection reset"));

    await expect(
      consumeRefreshBudget(organizationId, actor, now)
    ).rejects.toThrow("connection reset");
  });

  it("resets an expired org bucket window in one write and grants budget", async () => {
    oAuthRateLimit.findUnique
      .mockResolvedValueOnce(null) // actor bucket: no existing row, creates fresh
      .mockResolvedValueOnce({
        id: "org-bucket-1",
        windowExpiresAt: new Date(now.getTime() - 1),
      }); // org bucket: window already expired
    oAuthRateLimit.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await consumeRefreshBudget(organizationId, actor, now);

    expect(result).toEqual({ ok: true });
    expect(oAuthRateLimit.updateMany).toHaveBeenCalledTimes(1);
    expect(oAuthRateLimit.updateMany).toHaveBeenCalledWith({
      where: { id: "org-bucket-1", windowExpiresAt: { lte: now } },
      data: expect.objectContaining({ requestCount: 1 }),
    });
  });

  it("falls through to the increment write when the expired-window reset loses a race", async () => {
    oAuthRateLimit.findUnique
      .mockResolvedValueOnce(null) // actor bucket: no existing row, creates fresh
      .mockResolvedValueOnce({
        id: "org-bucket-1",
        windowExpiresAt: new Date(now.getTime() - 1),
      }); // org bucket: window already expired
    oAuthRateLimit.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reset write lost the race
      .mockResolvedValueOnce({ count: 1 }); // increment write then succeeds

    const result = await consumeRefreshBudget(organizationId, actor, now);

    expect(result).toEqual({ ok: true });
    expect(oAuthRateLimit.updateMany).toHaveBeenCalledTimes(2);
    expect(oAuthRateLimit.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "org-bucket-1",
        requestCount: { lt: expect.any(Number) },
        windowExpiresAt: { gt: now },
      },
      data: { requestCount: { increment: 1 } },
    });
  });
});
