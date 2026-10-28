import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { getRepositoryPullRequestsByNumberWithProviderResult } from "@repo/github/pull-request-point-read";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  branchId,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";

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

vi.mock("./pull-request-current-promotion", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./pull-request-current-promotion")>();
  return { ...actual, promoteBranchCurrentPullRequest: vi.fn() };
});

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
import { promoteBranchCurrentPullRequest } from "./pull-request-current-promotion";
import {
  refreshResponseFromTier2Outcome,
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
const _recordRateLimits = vi.mocked(recordSyncClientRateLimits);
const _recordRepoReached = vi.mocked(recordSyncClientRepoReached);
const _recordNoAccess = vi.mocked(recordSyncClientNoAccessIfRepoDenied);
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
  it("treats a session-linked target whose number does not match the request as non-refreshable", async () => {
    selectTargets.mockResolvedValueOnce([
      {
        pullRequestDetailId: "pr-detail-1",
        branchArtifactId: branchId,
        number: 999,
      },
    ]);

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
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
    expect(getSyncClient).not.toHaveBeenCalled();
  });

  it("omits credentialOwnerId from the provider read provenance for an unowned client", async () => {
    getSyncClient.mockResolvedValueOnce({
      ok: true,
      value: { ...client, credentialOwnerId: null },
    });

    await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    const options = pointRead.mock.calls[0]?.[5] as Record<string, unknown>;
    expect(options).not.toHaveProperty("credentialOwnerId");
  });

  it("reports stale when the reconciled write does not land", async () => {
    writePr.mockResolvedValueOnce(false);

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Stale,
      shouldReloadBranch: true,
    });
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("reports a guarded-write failure when promotion completes without promoting", async () => {
    promotePr.mockResolvedValueOnce(false);

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.GuardedWriteFailed,
      shouldReloadBranch: true,
    });
  });

  it("rethrows a promotion failure unrelated to a stale current-owner target", async () => {
    promotePr.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      refreshTier2TargetedBranchPullRequest({
        organizationId,
        target: repoLessBranch(),
        pullRequestDetailId: "pr-detail-1",
        pullRequestNumber: 7,
        now,
        trigger: GitHubFetchTrigger.UserAction,
      })
    ).rejects.toThrow("connection reset");
  });

  it("treats a stale current-owner promotion failure as a guarded-write failure rather than an error", async () => {
    promotePr.mockRejectedValueOnce(
      new Error("pull request current owner changed")
    );

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.GuardedWriteFailed,
      shouldReloadBranch: true,
    });
  });

  it("falls to the branch's repository full name when the PR detail names neither its own repository nor a full name", async () => {
    const currentPr = makeCurrentPullRequestDetail({
      repositoryId: null,
      repository: null,
      repositoryFullName: undefined,
    });
    // A repository name with no "/" cannot parse into an owner/repo pair, so
    // this also pins the invalid-full-name branch: resolution falls through
    // to the branch's own repositoryFullName and then fails to parse it.
    const target = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      repositoryFullName: "not-a-valid-repository-name",
      currentPullRequestDetail: currentPr,
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target,
      pullRequestDetail: currentPr,
      pullRequestDetailId: currentPr.id,
      pullRequestNumber: currentPr.number,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toEqual({
      status: BranchRefreshStatus.NotApplicable,
      reason: BranchRefreshReason.NoCurrentPullRequest,
      shouldReloadBranch: false,
    });
    expect(selectTargets).not.toHaveBeenCalled();
  });

  it("refuses to resolve a repository when the PR detail's own repository full name conflicts with the branch's", async () => {
    const currentPr = makeCurrentPullRequestDetail({
      repositoryId: null,
      repository: null,
      repositoryFullName: "someone-else/other-repo",
    });
    const target = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      currentPullRequestDetail: currentPr,
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target,
      pullRequestDetail: currentPr,
      pullRequestDetailId: currentPr.id,
      pullRequestNumber: currentPr.number,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome.status).toBe(BranchRefreshStatus.NotApplicable);
    expect(selectTargets).not.toHaveBeenCalled();
  });

  it("refuses to resolve a repository when the PR detail's joined repository relation conflicts with the branch's", async () => {
    const currentPr = makeCurrentPullRequestDetail({
      repositoryId: null,
      repository: {
        fullName: "someone-else/other-repo",
        githubRepoId: "gh-repo-2",
      },
      repositoryFullName: undefined,
    });
    const target = makeBranchRow({
      repositoryId: null,
      firstPushedAt: now,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      currentPullRequestDetail: currentPr,
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target,
      pullRequestDetail: currentPr,
      pullRequestDetailId: currentPr.id,
      pullRequestNumber: currentPr.number,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome.status).toBe(BranchRefreshStatus.NotApplicable);
    expect(selectTargets).not.toHaveBeenCalled();
  });

  it("refuses tier-2 targeting when the explicit pull request detail is null", async () => {
    const target = repoLessBranch();

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target,
      pullRequestDetail: null,
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
  });

  const accessDenialCases: [
    GitHubAccessDenialReason,
    ReturnType<typeof accessDenialExpectation>,
  ][] = [
    [
      GitHubAccessDenialReason.RateLimited,
      accessDenialExpectation(BranchRefreshReason.ProviderRateLimited),
    ],
    [
      GitHubAccessDenialReason.InsufficientScope,
      accessDenialExpectation(
        BranchRefreshReason.GitHubIdentityInsufficientScope,
        BranchRefreshStatus.Failed
      ),
    ],
    [
      GitHubAccessDenialReason.Revoked,
      accessDenialExpectation(
        BranchRefreshReason.GitHubIdentityExpired,
        BranchRefreshStatus.Failed
      ),
    ],
    [
      GitHubAccessDenialReason.NoInstallation,
      accessDenialExpectation(
        BranchRefreshReason.GitHubIdentityRequired,
        BranchRefreshStatus.Failed
      ),
    ],
    [
      GitHubAccessDenialReason.NotConnected,
      accessDenialExpectation(
        BranchRefreshReason.GitHubIdentityRequired,
        BranchRefreshStatus.Failed
      ),
    ],
    [
      // OrgRestricted has no explicit case in accessDenialOutcome's switch, so
      // this pins the default branch's fallback mapping.
      GitHubAccessDenialReason.OrgRestricted,
      accessDenialExpectation(BranchRefreshReason.ProviderUnavailable),
    ],
  ];

  it.each(accessDenialCases)(
    "maps a %s access denial to %o",
    async (reason, expected) => {
      getSyncClient.mockResolvedValueOnce({ ok: false, error: { reason } });

      const outcome = await refreshTier2TargetedBranchPullRequest({
        organizationId,
        target: repoLessBranch(),
        pullRequestDetailId: "pr-detail-1",
        pullRequestNumber: 7,
        now,
        trigger: GitHubFetchTrigger.UserAction,
      });

      expect(outcome).toEqual(expected);
    }
  );

  it("carries a budget-deferred retryAfterSeconds through the outcome when the resolver supplies one", async () => {
    getSyncClient.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.BudgetDeferred,
        retryAfterSeconds: 12,
      },
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
      retryAfterSeconds: 12,
      shouldReloadBranch: false,
    });
  });

  it("omits retryAfterSeconds from a rate-limited access denial when the resolver supplies none", async () => {
    getSyncClient.mockResolvedValueOnce({
      ok: false,
      error: { reason: GitHubAccessDenialReason.RateLimited },
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).not.toHaveProperty("retryAfterSeconds");
  });

  it("carries a rate-limited retryAfterSeconds through the outcome when the resolver supplies one", async () => {
    getSyncClient.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 9,
      },
    });

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).toMatchObject({ retryAfterSeconds: 9 });
  });

  it("maps a provider rate-limit read failure to a retryable outcome with the provider's retryAfterSeconds", async () => {
    pointRead.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 21,
    } as never);

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
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 21,
      shouldReloadBranch: true,
    });
  });

  it("omits retryAfterSeconds from a provider rate-limit read failure when the provider supplies none", async () => {
    pointRead.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderRateLimit,
    } as never);

    const outcome = await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: repoLessBranch(),
      pullRequestDetailId: "pr-detail-1",
      pullRequestNumber: 7,
      now,
      trigger: GitHubFetchTrigger.UserAction,
    });

    expect(outcome).not.toHaveProperty("retryAfterSeconds");
    expect(outcome.reason).toBe(BranchRefreshReason.ProviderRateLimited);
  });
});

describe("shouldRefreshTier2BranchPullRequestOnRead", () => {
  it("debounces a verified PR's on-read attempt for the short verified window, not the reconciler's long unverified one", () => {
    // The attempt age has to sit strictly between the two debounces or neither
    // assertion can tell them apart, so pin that premise before using it.
    expect(VERIFIED_ATTEMPT_DEBOUNCE_MS).toBeLessThan(
      BETWEEN_DEBOUNCES_ATTEMPT_AGE_MS
    );
    expect(BETWEEN_DEBOUNCES_ATTEMPT_AGE_MS).toBeLessThan(
      RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
    );

    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        staleVerifiedBranch(VERIFIED_ATTEMPT_DEBOUNCE_MS / 2),
        now
      )
    ).toBe(false);
    expect(
      shouldRefreshTier2BranchPullRequestOnRead(
        staleVerifiedBranch(BETWEEN_DEBOUNCES_ATTEMPT_AGE_MS),
        now
      )
    ).toBe(true);
  });
});

describe("refreshTier2BranchPullRequestOnRead", () => {
  it("skips provider work entirely when the shared eligibility check says no refresh is due", async () => {
    const target = makeBranchRow({ firstPushedAt: now });

    await refreshTier2BranchPullRequestOnRead(
      organizationId,
      branchId,
      target,
      { actor: { authMethod: "session", userId: "user-1" } }
    );

    expect(txDb.oAuthRateLimit.create).not.toHaveBeenCalled();
    expect(getSyncClient).not.toHaveBeenCalled();
  });

  it("skips provider work when the on-read refresh budget is exhausted", async () => {
    txDb.oAuthRateLimit.findUnique.mockResolvedValue({
      id: "actor-bucket",
      windowExpiresAt: new Date(now.getTime() + 60_000),
    });
    txDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 0 });
    const target = repoLessBranch();

    await refreshTier2BranchPullRequestOnRead(
      organizationId,
      branchId,
      target,
      { actor: { authMethod: "session", userId: "user-1" } }
    );

    expect(getSyncClient).not.toHaveBeenCalled();
  });
});

describe("refreshResponseFromTier2Outcome", () => {
  it("omits reason and retryAfterSeconds when the outcome carries neither", () => {
    const response = refreshResponseFromTier2Outcome(
      { status: BranchRefreshStatus.Refreshed, shouldReloadBranch: true },
      null
    );

    expect(response).toEqual({
      branch: null,
      status: BranchRefreshStatus.Refreshed,
    });
  });

  it("carries reason and retryAfterSeconds through when the outcome supplies both", () => {
    const response = refreshResponseFromTier2Outcome(
      {
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderRateLimited,
        retryAfterSeconds: 15,
        shouldReloadBranch: false,
      },
      null
    );

    expect(response).toEqual({
      branch: null,
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 15,
    });
  });
});

function repoLessBranch(
  prOverrides: Partial<ReturnType<typeof makeCurrentPullRequestDetail>> = {}
) {
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

/** A PR verified well past the on-read staleness window, last attempted `attemptAgeMs` ago. */
function staleVerifiedBranch(attemptAgeMs: number) {
  return repoLessBranch({
    lastVerifiedAt: new Date(now.getTime() - 20 * 60 * 1000),
    lastRefreshAttemptAt: new Date(now.getTime() - attemptAgeMs),
  });
}

function accessDenialExpectation(
  reason: BranchRefreshReason,
  status: BranchRefreshStatus = BranchRefreshStatus.Retryable
) {
  return { status, reason, shouldReloadBranch: false };
}

function successPointRead(
  pullRequests: GitHubReadModelPullRequest[],
  missingNumbers: number[] = []
) {
  const targetNumbers = [
    ...pullRequests.map((pr) => pr.number),
    ...missingNumbers,
  ];
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests,
      rateLimit: {
        cost: 1,
        remaining: 4999,
        resetAt: "2026-08-26T13:00:00.000Z",
        state: "available",
      },
      pageInfo: { hasNextPage: false, endCursor: null },
      hasMore: false,
      truncated: false,
      nextCursor: null,
      fetchedPages: 1,
      stopReason: "complete",
      targetNumbers,
      missingTargetNumbers: missingNumbers,
      missingNumbers,
      attemptedNumbers: targetNumbers,
      unattemptedNumbers: [],
    },
  } as never;
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
    state: "open",
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
  } as never;
}

/** The debounce a VERIFIED PR gets on read; the unverified one is the reconciler's. */
const VERIFIED_ATTEMPT_DEBOUNCE_MS = BRANCH_REFRESH_RETRY_AFTER_SECONDS * 1000;
const BETWEEN_DEBOUNCES_ATTEMPT_AGE_MS = 5 * 60 * 1000;
