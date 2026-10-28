import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import type { GitHubPullRequestsByNumberResult } from "@repo/github/pull-request-point-read";
import { getRepositoryPullRequestsByNumberWithProviderResult } from "@repo/github/pull-request-point-read";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  branchId,
  type MockPrDetail,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { promoteBranchCurrentPullRequest } from "./pull-request-current-promotion";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mockedWithDb = vi.fn();
  Object.assign(mockedWithDb, { tx: vi.fn() });
  return { ...actual, withDb: mockedWithDb };
});

vi.mock("@repo/github/pull-request-point-read", () => ({
  getRepositoryPullRequestsByNumberWithProviderResult: vi.fn(),
}));

vi.mock("@/app/cron/reconcile-pull-requests/session-linked-targets", () => ({
  selectSessionLinkedPullRequestTargets: vi.fn(),
}));

vi.mock(
  "@/app/cron/reconcile-pull-requests/reconcile-projection-write",
  () => ({
    writeReconciledPullRequest: vi.fn(),
    writeReconciledPullRequestFailures: vi.fn(),
  })
);

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));

vi.mock("@/lib/github/github-sync-client-feedback", () => ({
  recordSyncClientNoAccessIfRepoDenied: vi.fn(),
  recordSyncClientRateLimits: vi.fn(),
  recordSyncClientRepoReached: vi.fn(),
}));

vi.mock("./pull-request-current-promotion", () => ({
  isPullRequestCurrentOwnerChangedError: (error: unknown) =>
    error instanceof Error &&
    error.message === "pull request current owner changed",
  promoteBranchCurrentPullRequest: vi.fn(),
}));

import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "@/app/cron/reconcile-pull-requests/constants";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { selectSessionLinkedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import {
  recordSyncClientNoAccessIfRepoDenied,
  recordSyncClientRateLimits,
  recordSyncClientRepoReached,
} from "@/lib/github/github-sync-client-feedback";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { BRANCH_REFRESH_RETRY_AFTER_SECONDS } from "./branch-refresh-support";
import {
  isTier2BranchPullRequestRefreshInFlight,
  refreshTier2BranchPullRequestOnRead,
  refreshTier2TargetedBranchPullRequest,
  shouldRefreshTier2BranchPullRequestOnRead,
} from "./tier2-targeted-branch-refresh";

const pointRead = vi.mocked(
  getRepositoryPullRequestsByNumberWithProviderResult
);
const selectTargets = vi.mocked(selectSessionLinkedPullRequestTargets);
const getSyncClient = vi.mocked(getGitHubSyncClient);
const writePr = vi.mocked(writeReconciledPullRequest);
const writePrFailures = vi.mocked(writeReconciledPullRequestFailures);
const promotePr = vi.mocked(promoteBranchCurrentPullRequest);
const recordRateLimits = vi.mocked(recordSyncClientRateLimits);
const recordRepoReached = vi.mocked(recordSyncClientRepoReached);
const recordNoAccess = vi.mocked(recordSyncClientNoAccessIfRepoDenied);
const txDb = {
  oAuthRateLimit: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
};
const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};

const updateMany = vi.fn();
const octokit = { marker: "tier-2-octokit" } as never;
const client = {
  kind: GitHubCredentialKind.OauthUser,
  credentialOwnerId: "user-1",
  actingAs: { githubUserId: "gh-user-1", login: "octocat" },
  rateLimitTier: null,
  octokit,
  recordRateLimit: vi.fn(),
  recordRepoAccess: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ pullRequestDetail: { updateMany } })
  );
  mockWithDb.tx.mockImplementation((fn: (db: unknown) => unknown) => fn(txDb));
  txDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
  txDb.oAuthRateLimit.create.mockResolvedValue({});
  txDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 1 });
  selectTargets.mockResolvedValue([
    {
      pullRequestDetailId: "pr-detail-1",
      branchArtifactId: branchId,
      number: 7,
    },
  ]);
  getSyncClient.mockResolvedValue({ ok: true, value: client });
  pointRead.mockResolvedValue(successPointRead([pullRequest(7)]));
  writePr.mockResolvedValue(true);
  writePrFailures.mockResolvedValue(1);
  promotePr.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshTier2TargetedBranchPullRequest", () => {
  it("refreshes one repo-less session-linked current PR by number and promotes it", async () => {
    const target = repoLessBranch();

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target,
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Refreshed,
      shouldReloadBranch: true,
    });
    expect(selectTargets).toHaveBeenCalledWith({
      organizationId,
      repositoryId: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchArtifactId: branchId,
      pullRequestDetailId: "pr-detail-1",
      ignoreAttemptDebounce: true,
      limit: 1,
      now,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "pr-detail-1",
        branchArtifactId: branchId,
        organizationId,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        OR: [
          { lastRefreshAttemptAt: null },
          { lastRefreshAttemptAt: { lt: new Date(now.getTime() - 30_000) } },
        ],
      }),
      data: { lastRefreshAttemptAt: now },
    });
    expect(getSyncClient.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0]
    );
    expect(getSyncClient).toHaveBeenCalledWith(
      {
        organizationId,
        target: { owner: "closedloop-ai", repo: "closedloop-ai" },
      },
      { now }
    );
    expect(pointRead).toHaveBeenCalledWith(
      octokit,
      "closedloop-ai",
      "closedloop-ai",
      [7],
      expect.any(Function),
      expect.objectContaining({
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: "user-1",
        observedAt: now.toISOString(),
      })
    );
    expect(writePr).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7 }),
      expect.objectContaining({
        organizationId,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        credentialKind: GitHubCredentialKind.OauthUser,
        credentialOwnerId: "user-1",
        fetchTrigger: GitHubFetchTrigger.UserAction,
        now,
      })
    );
    expect(promotePr).toHaveBeenCalledWith(
      txDb,
      {
        organizationId,
        branchArtifactId: branchId,
        pullRequestDetailId: "pr-detail-1",
      },
      { onlyWhenCurrentMissingOrStub: true }
    );
    expect(recordRateLimits).toHaveBeenCalledWith(
      client,
      [],
      expect.objectContaining({
        organizationId,
        repositoryFullName: "closedloop-ai/closedloop-ai",
      })
    );
    expect(recordRepoReached).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        organizationId,
        repositoryFullName: "closedloop-ai/closedloop-ai",
      })
    );
  });

  it("denies interactive refresh at the sync-pool reserve floor without provider freshness", async () => {
    getSyncClient.mockResolvedValueOnce({
      ok: false,
      error: { reason: GitHubAccessDenialReason.BudgetDeferred },
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.BudgetExhausted,
      shouldReloadBranch: false,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(pointRead).not.toHaveBeenCalled();
    expect(writePr).not.toHaveBeenCalled();
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("keeps an interactive refresh retryable when a peer draw holds the pool (ISS-8270)", async () => {
    getSyncClient.mockResolvedValueOnce({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Contention },
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    // Contention says a concurrent sweep has the credential, not that the user
    // has to reconnect one — remapping this to an identity outcome would tell a
    // signed-in user with a healthy connection to go fix it.
    expect(outcome).toEqual({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
      shouldReloadBranch: false,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(pointRead).not.toHaveBeenCalled();
    expect(writePr).not.toHaveBeenCalled();
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("debounces repo-less on-demand refresh attempts after provider access and before provider reads", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.SurfaceOpen,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.AlreadyRefreshing,
      retryAfterSeconds: 30,
      shouldReloadBranch: false,
    });
    expect(getSyncClient).toHaveBeenCalled();
    expect(pointRead).not.toHaveBeenCalled();
    expect(writePr).not.toHaveBeenCalled();
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("refreshes an explicitly selected historical PR without promoting it current", async () => {
    const currentPr = makeCurrentPullRequestDetail({
      repositoryId: null,
      repository: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
    });
    const historicalPr = makeCurrentPullRequestDetail({
      id: "pr-detail-17",
      isCurrent: false,
      number: 17,
      repositoryId: null,
      repository: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
    });
    selectTargets.mockResolvedValueOnce([
      {
        pullRequestDetailId: "pr-detail-17",
        branchArtifactId: branchId,
        number: 17,
      },
    ]);
    pointRead.mockResolvedValueOnce(successPointRead([pullRequest(17)]));

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: makeBranchRow({
        repositoryId: null,
        firstPushedAt: now,
        currentPullRequestDetail: currentPr,
        pullRequestDetails: [currentPr, historicalPr],
      }),
      pullRequestDetail: historicalPr,
      pullRequestDetailId: "pr-detail-17",
      pullRequestNumber: 17,
      now,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      promoteCurrent: false,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Refreshed,
      shouldReloadBranch: true,
    });
    expect(selectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        branchArtifactId: branchId,
        pullRequestDetailId: "pr-detail-17",
        repositoryFullName: "closedloop-ai/closedloop-ai",
      })
    );
    expect(pointRead).toHaveBeenCalledWith(
      octokit,
      "closedloop-ai",
      "closedloop-ai",
      [17],
      expect.any(Function),
      expect.any(Object)
    );
    expect(writePr).toHaveBeenCalledWith(
      expect.objectContaining({ number: 17 }),
      expect.objectContaining({
        repositoryFullName: "closedloop-ai/closedloop-ai",
      })
    );
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("uses the long reconciler debounce when on-read refresh settles a missing unverified PR", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const target = repoLessBranch();
    pointRead.mockResolvedValueOnce(successPointRead([], [7]));

    await refreshTier2BranchPullRequestOnRead(
      organizationId,
      branchId,
      target,
      {
        actor: { authMethod: "session", userId: "user-1" },
        pullRequestDetail: target.pullRequestDetails[0],
      }
    );

    expect(txDb.oAuthRateLimit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bucket: "branch_refresh:actor",
          subject: `${organizationId}:session:user-1`,
        }),
      })
    );
    expect(txDb.oAuthRateLimit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bucket: "branch_refresh:org",
          subject: organizationId,
        }),
      })
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "pr-detail-1",
        OR: [
          { lastRefreshAttemptAt: null },
          {
            lastRefreshAttemptAt: {
              lt: new Date(
                now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
              ),
            },
          },
        ],
      }),
      data: { lastRefreshAttemptAt: now },
    });
    expect(pointRead).toHaveBeenCalled();
    expect(writePr).not.toHaveBeenCalled();
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("does not perform on-read provider work without an actor budget context", async () => {
    const target = repoLessBranch({
      lastVerifiedAt: new Date(now.getTime() - 16 * 60 * 1000),
    });

    await refreshTier2BranchPullRequestOnRead(organizationId, branchId, target);

    expect(txDb.oAuthRateLimit.create).not.toHaveBeenCalled();
    expect(getSyncClient).not.toHaveBeenCalled();
    expect(pointRead).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("settles provider failures onto the exact PR target without promoting stale data", async () => {
    pointRead.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.SurfaceOpen,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
      shouldReloadBranch: true,
    });
    expect(writePrFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumbers: [7],
        result: { status: GitHubProviderResultStatus.ProviderUnavailable },
        provenance: expect.objectContaining({
          trigger: GitHubFetchTrigger.SurfaceOpen,
        }),
      })
    );
    expect(recordNoAccess).toHaveBeenCalledWith(
      client,
      GitHubProviderResultStatus.ProviderUnavailable,
      expect.any(Object)
    );
    expect(writePr).not.toHaveBeenCalled();
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("does not use the tier-2 path for active installation branches", async () => {
    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: makeBranchRow({ firstPushedAt: now }),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.NotApplicable,
      reason: BranchRefreshReason.NoCurrentPullRequest,
      shouldReloadBranch: false,
    });
    expect(selectTargets).not.toHaveBeenCalled();
    expect(getSyncClient).not.toHaveBeenCalled();
  });
});

describe("shouldRefreshTier2BranchPullRequestOnRead", () => {
  it("refreshes repo-less current PRs only when unverified or stale", () => {
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(repoLessBranch(), now)
    ).toBe(true);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        repoLessBranch({
          lastVerifiedAt: new Date(now.getTime() - 14 * 60 * 1000),
        }),
        now
      )
    ).toBe(false);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        repoLessBranch({
          lastVerifiedAt: new Date(now.getTime() - 16 * 60 * 1000),
        }),
        now
      )
    ).toBe(true);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        makeBranchRow({ firstPushedAt: now }),
        now
      )
    ).toBe(false);
  });

  // ISS-8423 pins the other direction of the producer change here. Once a
  // factless desktop write stops stamping, its row reaches this path with BOTH
  // clocks null, so the on-read lane takes it immediately instead of waiting on
  // the 15-minute cron. A `state`-only stub is different and deliberately so: it
  // DID observe something, so it carries a fresh verification stamp and waits
  // out the ordinary staleness window like any other verified row — the
  // reconciler's stub arm is what rescues that one.
  it("still refreshes the ISS-8423 desktop stub shapes on read", () => {
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        repoLessBranch({
          lastVerifiedAt: null,
          lastRefreshAttemptAt: null,
        }),
        now
      )
    ).toBe(true);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        repoLessBranch({
          lastVerifiedAt: now,
          lastRefreshAttemptAt: null,
        }),
        now
      )
    ).toBe(false);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        // The same state-only stub 16 minutes on, past the staleness window.
        repoLessBranch({
          lastVerifiedAt: new Date(now.getTime() - 16 * 60 * 1000),
          lastRefreshAttemptAt: null,
        }),
        now
      )
    ).toBe(true);
  });

  it("uses the reconciler debounce for unverified on-read attempts", () => {
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        repoLessBranch({
          lastRefreshAttemptAt: new Date(
            now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS + 1
          ),
          lastVerifiedAt: null,
        }),
        now
      )
    ).toBe(false);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        repoLessBranch({
          lastRefreshAttemptAt: new Date(
            now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS - 1
          ),
          lastVerifiedAt: null,
        }),
        now
      )
    ).toBe(true);
  });
});

describe("isTier2BranchPullRequestRefreshInFlight (ISS-12278)", () => {
  const verifiedAt = new Date(now.getTime() - 20 * 60 * 1000);

  it("reports a claimed attempt that has not landed inside the refresh window", () => {
    expect(
      isTier2BranchPullRequestRefreshInFlight(
        repoLessBranch({
          lastVerifiedAt: verifiedAt,
          lastRefreshAttemptAt: new Date(now.getTime() - 6000),
        }),
        now
      )
    ).toBe(true);
    expect(
      isTier2BranchPullRequestRefreshInFlight(
        repoLessBranch({
          lastVerifiedAt: null,
          lastRefreshAttemptAt: new Date(now.getTime() - 6000),
        }),
        now
      )
    ).toBe(true);
  });

  it("stops once the attempt landed, aged out, or never ran", () => {
    const attemptAt = new Date(now.getTime() - 6000);
    expect(
      isTier2BranchPullRequestRefreshInFlight(
        repoLessBranch({
          lastVerifiedAt: attemptAt,
          lastRefreshAttemptAt: attemptAt,
        }),
        now
      )
    ).toBe(false);
    expect(
      isTier2BranchPullRequestRefreshInFlight(
        repoLessBranch({
          lastVerifiedAt: verifiedAt,
          lastRefreshAttemptAt: new Date(
            now.getTime() - BRANCH_REFRESH_RETRY_AFTER_SECONDS * 1000
          ),
        }),
        now
      )
    ).toBe(false);
    expect(
      isTier2BranchPullRequestRefreshInFlight(
        repoLessBranch({
          lastVerifiedAt: verifiedAt,
          lastRefreshAttemptAt: null,
        }),
        now
      )
    ).toBe(false);
    expect(
      isTier2BranchPullRequestRefreshInFlight(
        makeBranchRow({ firstPushedAt: now }),
        now
      )
    ).toBe(false);
  });
});

function repoLessBranch(prOverrides: Partial<MockPrDetail> = {}) {
  return makeBranchRow({
    repositoryId: null,
    firstPushedAt: now,
    currentPullRequestDetail: makeCurrentPullRequestDetail({
      repositoryId: null,
      repository: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      ...prOverrides,
    }),
  });
}

function successPointRead(
  pullRequests: GitHubReadModelPullRequest[],
  missingNumbers: number[] = []
) {
  const targetNumbers = [
    ...pullRequests.map((pullRequest) => pullRequest.number),
    ...missingNumbers,
  ];
  const value: GitHubPullRequestsByNumberResult = {
    pullRequests,
    rateLimit: {
      cost: 1,
      remaining: 4999,
      resetAt: "2026-08-26T13:00:00.000Z",
      state: GitHubProviderBudgetState.Available,
    },
    pageInfo: { hasNextPage: false, endCursor: null },
    hasMore: false,
    truncated: false,
    nextCursor: null,
    fetchedPages: 1,
    stopReason: GitHubBundledPullRequestsStopReason.Complete,
    targetNumbers,
    missingTargetNumbers: missingNumbers,
    missingNumbers,
    attemptedNumbers: targetNumbers,
    unattemptedNumbers: [],
  };
  return {
    status: GitHubProviderResultStatus.Success,
    value,
  };
}

function pullRequest(number: number): GitHubReadModelPullRequest {
  return {
    githubId: `PR_node_${number}`,
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/closedloop-ai/closedloop-ai/pull/${number}`,
    headBranch: `feature-${number}`,
    baseBranch: "main",
    headSha: "abc123",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 2,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-08-26T11:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-08-26T12:05:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}
