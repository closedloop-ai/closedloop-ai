/**
 * Branch coverage for `githubServerSyncService.refreshTombstonedBranchPullRequest`
 * (ISS-11280). `sync-service.test.ts` drives the Clerk-backed happy path and
 * the provider-rejection statuses; this file pins the arms it never reaches:
 * a missing target or non-App branch, an unparseable repository name, a
 * revoked credential, a lost refresh claim, provider rate limiting and its
 * retry window, the three settle-transaction failure shapes, a renamed
 * repository, and the default clock.
 *
 * The credential resolver is mocked at its module seam so each denial reason
 * can be chosen directly instead of being reverse-engineered through Clerk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

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

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/github/github-user-credential", () => ({
  resolveGitHubUserCredential: vi.fn(),
}));

const persistLifecycleActivityMock = vi.hoisted(() => vi.fn());
const persistProviderFailureMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/branches/pull-request-lifecycle-activity", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/pull-request-lifecycle-activity")
  >("@/app/branches/pull-request-lifecycle-activity");
  return {
    ...actual,
    persistPullRequestLifecycleActivityInTransaction:
      persistLifecycleActivityMock,
  };
});

vi.mock("@/app/branches/pull-request-authority-producer", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/pull-request-authority-producer")
  >("@/app/branches/pull-request-authority-producer");
  return {
    ...actual,
    persistPullRequestProviderFailure: persistProviderFailureMock,
  };
});

import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { ArtifactType } from "@repo/database";
import {
  GitHubProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import {
  actorUserId,
  branchArtifactId,
  createMockDb,
  makeBranchTarget,
  makeProviderPullRequest,
  makePullRequestDetailRow,
  makeSessionPrLink,
  now,
  organizationId,
} from "@/__tests__/support/integrations/github/sync-service.test-fixtures";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { PullRequestLifecycleActivityPersistenceError } from "@/app/branches/pull-request-lifecycle-activity";
import { resolveGitHubUserCredential } from "@/lib/github/github-user-credential";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "./sync-service";

const TOMBSTONED_AT = new Date("2026-07-06T08:30:00.000Z");
// The wall clock during every case, deliberately NOT the fixture's `now`, so a
// write that reads the real clock instead of the caller's `now` is visible.
const WALL_CLOCK = new Date("2026-07-06T09:05:00.000Z");
const REFRESH_WINDOW_MS = 30_000;
const PR_DETAIL_ID = "pr-detail-1";
const userTokenOctokit = { kind: "user-token-octokit" };
const mockGetUserTokenOctokit = getUserTokenOctokit as ReturnType<typeof vi.fn>;

const REPOSITORY_WHERE = {
  removedAt: { not: null },
  githubRepoId: "gh-repo-1",
} as const;

/** The failure-stamp provenance columns, as `gitHubFetchProvenanceData` spells them. */
function failureProvenance(reason: GitHubSyncResultReason) {
  return {
    fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
    fetchCredentialOwnerId: actorUserId,
    fetchMechanism: GitHubFetchMechanism.Rest,
    fetchTrigger: GitHubFetchTrigger.UserAction,
    // pins current behavior; looks odd because the failure stamp builds its
    // provenance without passing the caller's `now`, so `fetchObservedAt` is
    // the wall clock while `lastRefreshAttemptAt` on the same row is `now`.
    fetchObservedAt: WALL_CLOCK,
    fetchResultReason: reason,
  };
}

function pullRequestStampCall(
  reason: GitHubSyncResultReason,
  repositoryWhere: typeof REPOSITORY_WHERE,
  options: { recordRefreshAttempt: boolean }
) {
  return {
    where: {
      id: PR_DETAIL_ID,
      branchArtifactId,
      branchArtifact: { organizationId },
      repository: repositoryWhere,
    },
    data: {
      ...(options.recordRefreshAttempt ? { lastRefreshAttemptAt: now } : {}),
      ...failureProvenance(reason),
    },
  };
}

function branchStampCall(
  reason: GitHubSyncResultReason,
  repositoryWhere: typeof REPOSITORY_WHERE
) {
  return {
    where: {
      artifactId: branchArtifactId,
      artifact: { organizationId },
      repository: repositoryWhere,
    },
    data: failureProvenance(reason),
  };
}

function claimCall(claimedAt: Date) {
  return {
    where: {
      id: PR_DETAIL_ID,
      branchArtifactId,
      branchArtifact: {
        organizationId,
        branch: { is: { repository: REPOSITORY_WHERE } },
      },
      repository: REPOSITORY_WHERE,
      OR: [
        { lastRefreshAttemptAt: null },
        {
          lastRefreshAttemptAt: {
            lt: new Date(claimedAt.getTime() - REFRESH_WINDOW_MS),
          },
        },
      ],
    },
    data: { lastRefreshAttemptAt: claimedAt },
  };
}

describe("githubServerSyncService.refreshTombstonedBranchPullRequest branch arms", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL_CLOCK);
    mockDb = createMockDb();
    mockWithDbAll(mockDb);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchTarget());
    mockDb.artifactLink.findFirst.mockResolvedValue(makeSessionPrLink());
    mockDb.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    mockDb.branchDetail.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(resolveGitHubUserCredential).mockResolvedValue({
      ok: true,
      credential: {
        connectionId: "connection-1",
        organizationId,
        userId: actorUserId,
        githubUserId: "9001",
        login: "octocat",
        scopes: ["repo"],
        rateLimitTier: null,
        token: "user-token",
        capabilities: [],
      },
    });
    mockGetUserTokenOctokit.mockReturnValue(userTokenOctokit);
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest(),
    });
    persistLifecycleActivityMock.mockResolvedValue(undefined);
    persistProviderFailureMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function refresh(input: { now?: Date } = { now }) {
    return githubServerSyncService.refreshTombstonedBranchPullRequest({
      actorUserId,
      branchArtifactId,
      organizationId,
      ...input,
    });
  }

  function sideEffectCallCounts() {
    return {
      credential: vi.mocked(resolveGitHubUserCredential).mock.calls.length,
      provider: vi.mocked(getSinglePullRequestWithProviderResult).mock.calls
        .length,
      pullRequestWrites: mockDb.pullRequestDetail.updateMany.mock.calls.length,
      branchWrites: mockDb.branchDetail.updateMany.mock.calls.length,
    };
  }
  const noSideEffects = {
    credential: 0,
    provider: 0,
    pullRequestWrites: 0,
    branchWrites: 0,
  };

  it.each([
    { name: "the branch artifact is not visible in this org", target: null },
    {
      name: "the artifact has no branch detail",
      target: { ...makeBranchTarget(), branch: null },
    },
  ])("fails no_active_repository when $name", async ({ target }) => {
    mockDb.artifact.findFirst.mockResolvedValue(target);

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoActiveRepository,
    });
    expect(mockDb.artifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: branchArtifactId,
          organizationId,
          type: ArtifactType.BRANCH,
        },
      })
    );
    expect(sideEffectCallCounts()).toEqual(noSideEffects);
  });

  it("fails no_active_repository for a non-App branch with no installation repository", async () => {
    const base = makeBranchTarget();
    mockDb.artifact.findFirst.mockResolvedValue({
      ...base,
      branch: { ...base.branch, repository: null },
    });

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoActiveRepository,
    });
    expect(sideEffectCallCounts()).toEqual(noSideEffects);
  });

  it("refreshes through a tombstoned repository rename with the same provider id", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        pullRequestDetails: [
          makePullRequestDetailRow({
            repositoryFullName: "closedloop-ai/closedloop-ai-v2",
            repository: {
              fullName: "closedloop-ai/closedloop-ai-v2",
              githubRepoId: "gh-repo-1",
              removedAt: TOMBSTONED_AT,
            },
          }),
        ],
      })
    );

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      userTokenOctokit,
      "closedloop-ai",
      "closedloop-ai",
      2294,
      expect.anything()
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      claimCall(now)
    );
  });

  it("stamps unsupported and fails invalid_repository_full_name for a name that is not owner/repo", async () => {
    const badName = "closedloop-ai/closedloop-ai/extra";
    const base = makeBranchTarget({
      pullRequestDetails: [
        makePullRequestDetailRow({
          repositoryFullName: badName,
          repository: {
            fullName: badName,
            githubRepoId: "gh-repo-1",
            removedAt: TOMBSTONED_AT,
          },
        }),
      ],
    });
    mockDb.artifact.findFirst.mockResolvedValue({
      ...base,
      branch: {
        ...base.branch,
        repositoryFullName: badName,
        repository: { ...base.branch.repository, fullName: badName },
      },
    });

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.InvalidRepositoryFullName,
    });
    expect(mockDb.pullRequestDetail.updateMany.mock.calls).toEqual([
      [
        pullRequestStampCall(
          GitHubSyncResultReason.Unsupported,
          REPOSITORY_WHERE,
          { recordRefreshAttempt: true }
        ),
      ],
    ]);
    expect(mockDb.branchDetail.updateMany.mock.calls).toEqual([
      [branchStampCall(GitHubSyncResultReason.Unsupported, REPOSITORY_WHERE)],
    ]);
    expect(mockDb.artifactLink.findFirst).not.toHaveBeenCalled();
    expect(resolveGitHubUserCredential).not.toHaveBeenCalled();
  });

  it("maps a revoked credential to credential_revoked without recording a refresh attempt", async () => {
    vi.mocked(resolveGitHubUserCredential).mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.Revoked,
    });

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.CredentialRevoked,
    });
    expect(resolveGitHubUserCredential).toHaveBeenCalledWith({
      organizationId,
      userId: actorUserId,
      now,
    });
    expect(mockDb.pullRequestDetail.updateMany.mock.calls).toEqual([
      [
        pullRequestStampCall(
          GitHubSyncResultReason.CredentialRevoked,
          REPOSITORY_WHERE,
          { recordRefreshAttempt: false }
        ),
      ],
    ]);
    expect(mockDb.branchDetail.updateMany.mock.calls).toEqual([
      [
        branchStampCall(
          GitHubSyncResultReason.CredentialRevoked,
          REPOSITORY_WHERE
        ),
      ],
    ]);
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("answers already_refreshing when another refresh holds the claim window", async () => {
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.AlreadyRefreshing,
    });
    expect(mockDb.pullRequestDetail.updateMany.mock.calls).toEqual([
      [claimCall(now)],
    ]);
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("uses the current clock when the caller passes no now", async () => {
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await refresh({});

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.AlreadyRefreshing,
    });
    expect(resolveGitHubUserCredential).toHaveBeenCalledWith({
      organizationId,
      userId: actorUserId,
      now: WALL_CLOCK,
    });
    expect(mockDb.pullRequestDetail.updateMany.mock.calls).toEqual([
      [claimCall(WALL_CLOCK)],
    ]);
  });

  it("persists a rate-limit failure and returns the provider's retry window", async () => {
    const rateLimited = {
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 90,
    } as const;
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue(
      rateLimited
    );

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.ProviderRateLimited,
      retryAfterSeconds: 90,
    });
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      userTokenOctokit,
      "closedloop-ai",
      "closedloop-ai",
      2294,
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: actorUserId,
        observedAt: now.toISOString(),
      })
    );
    expect(persistProviderFailureMock).toHaveBeenCalledWith(
      mockDb,
      { organizationId, pullRequestDetailId: PR_DETAIL_ID },
      rateLimited,
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: actorUserId,
        observedAt: now.toISOString(),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany.mock.calls).toEqual([
      [claimCall(now)],
      [
        pullRequestStampCall(
          GitHubSyncResultReason.ProviderUnavailable,
          REPOSITORY_WHERE,
          { recordRefreshAttempt: true }
        ),
      ],
    ]);
    expect(mockDb.branchDetail.updateMany.mock.calls).toEqual([
      [
        branchStampCall(
          GitHubSyncResultReason.ProviderUnavailable,
          REPOSITORY_WHERE
        ),
      ],
    ]);
  });

  // pins current behavior; looks odd because a provider-reported
  // `retryAfterSeconds: 0` is falsy and is dropped exactly like a missing
  // value, so the caller cannot tell "retry now" from "no window given".
  it.each([{ retryAfterSeconds: null }, { retryAfterSeconds: 0 }])(
    "omits retryAfterSeconds when the rate limit reports $retryAfterSeconds",
    async ({ retryAfterSeconds }) => {
      vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
        status: GitHubProviderResultStatus.ProviderRateLimit,
        retryAfterSeconds,
      });

      const result = await refresh();

      expect(result).toEqual({
        status: GitHubServerSyncStatus.Retryable,
        reason: GitHubServerSyncReason.ProviderRateLimited,
      });
    }
  );

  it("fails guarded_write_failed when the settle detail write loses its claim", async () => {
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.GuardedWriteFailed,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(2);
    expect(
      mockDb.pullRequestDetail.updateMany.mock.calls[1]?.[0]?.where
    ).toEqual({
      id: PR_DETAIL_ID,
      branchArtifactId,
      lastRefreshAttemptAt: now,
      branchArtifact: {
        organizationId,
        branch: {
          is: {
            repository: REPOSITORY_WHERE,
            currentPullRequestDetailId: PR_DETAIL_ID,
          },
        },
      },
      repository: REPOSITORY_WHERE,
    });
    expect(persistLifecycleActivityMock).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "[github/sync] Tombstoned PR refresh failed",
      {
        reason: GitHubServerSyncReason.GuardedWriteFailed,
        branchArtifactId,
        organizationId,
      }
    );
  });

  it("fails guarded_write_failed when lifecycle activity rejects its observations", async () => {
    persistLifecycleActivityMock.mockRejectedValue(
      new PullRequestLifecycleActivityPersistenceError([
        BranchActivityPersistStatus.Conflict,
      ])
    );

    const result = await refresh();

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.GuardedWriteFailed,
    });
    expect(persistLifecycleActivityMock).toHaveBeenCalledWith(mockDb, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId: PR_DETAIL_ID,
      openedAt: new Date("2026-07-06T09:00:00.000Z"),
      mergedAt: new Date("2026-07-06T10:00:00.000Z"),
      closedAt: new Date("2026-07-06T10:00:00.000Z"),
    });
    // The branch base/head write comes after lifecycle and never lands.
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected settle-transaction error instead of reporting a guard failure", async () => {
    const failure = new Error("connection reset");
    persistLifecycleActivityMock.mockRejectedValue(failure);

    await expect(refresh()).rejects.toBe(failure);
    expect(log.warn).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });
});
