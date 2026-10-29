import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectionWriteMocks = vi.hoisted(() => ({
  useActualWriter: false,
  write: vi.fn(),
  persistHeadAuthority: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));
vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
  queryPullRequestsByNumberWithProviderResult: vi.fn(),
}));
vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));
vi.mock("../reconcile-projection-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../reconcile-projection-write")>();
  return {
    ...actual,
    writeReconciledPullRequest: vi.fn(
      (...args: Parameters<typeof actual.writeReconciledPullRequest>) =>
        projectionWriteMocks.useActualWriter
          ? actual.writeReconciledPullRequest(...args)
          : projectionWriteMocks.write(...args)
    ),
    writeReconciledPullRequestFailures: vi.fn().mockResolvedValue(0),
  };
});
vi.mock(
  "@/app/branches/pull-request-head-authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/branches/pull-request-head-authority")
    >()),
    persistPullRequestHeadRepositoryAuthority:
      projectionWriteMocks.persistHeadAuthority,
  })
);
vi.mock("../targeted-reconciler", () => ({
  TargetedReconcileStatus: {
    Success: "success",
    FetchFailed: "fetch_failed",
  },
  reconcileTargetedSessionLinkedPullRequests: vi.fn(),
}));
vi.mock("@/lib/github/github-repo-sync-state", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/github-repo-sync-state")
  >()),
  classifyRepoSyncTier: vi.fn(),
}));
vi.mock("@repo/api/src/types/branch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/api/src/types/branch")>()),
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("../delivery-coverage-metrics", () => ({
  reportGitHubDeliveryCoverageTick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findInstallationRepositoryId: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "@repo/github";
import {
  dbState,
  INPUT as FIXTURE_INPUT,
  NOW as FIXTURE_NOW,
  makeClient,
  makeDb,
  readModelPr,
  resetReconcileDbState,
} from "@/__tests__/support/cron/reconcile-pull-requests/repo-reconciler.test-fixtures";
import {
  classifyRepoSyncTier,
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import { computeNextRetryAt } from "@/lib/github/github-retry-backoff";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import { reportGitHubDeliveryCoverageTick } from "../delivery-coverage-metrics";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "../reconcile-projection-write";
import { ReconcileRepoStatus } from "../repo-reconcile-status";
import {
  persistFailureSettlement,
  RECONCILE_UNEXPECTED_FAILURE_REASON,
  reconcileRepo,
} from "../repo-reconciler";
import {
  reconcileTargetedSessionLinkedPullRequests,
  TargetedReconcileStatus,
} from "../targeted-reconciler";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockGetClient = getGitHubSyncClient as unknown as ReturnType<
  typeof vi.fn
>;
const mockQuery =
  queryBundledPullRequestsWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockWrite = writeReconciledPullRequest as unknown as ReturnType<
  typeof vi.fn
>;
const mockWriteFailures =
  writeReconciledPullRequestFailures as unknown as ReturnType<typeof vi.fn>;
const mockClassify = classifyRepoSyncTier as unknown as ReturnType<
  typeof vi.fn
>;
const mockFindInstallationRepositoryId =
  findInstallationRepositoryId as unknown as ReturnType<typeof vi.fn>;
const mockReportDeliveryCoverageTick =
  reportGitHubDeliveryCoverageTick as unknown as ReturnType<typeof vi.fn>;

const NOW = FIXTURE_NOW;
const INPUT = FIXTURE_INPUT;
let fetchOpts: Record<string, unknown> | null = null;
let installationRepoId: string | null = null;
const mockTargeted =
  reconcileTargetedSessionLinkedPullRequests as unknown as ReturnType<
    typeof vi.fn
  >;

beforeEach(() => {
  vi.clearAllMocks();

  resetReconcileDbState();
  projectionWriteMocks.useActualWriter = false;
  projectionWriteMocks.write.mockResolvedValue(true);
  projectionWriteMocks.persistHeadAuthority.mockResolvedValue(false);
  fetchOpts = null;
  installationRepoId = null;
  mockFindInstallationRepositoryId.mockImplementation(() =>
    Promise.resolve(installationRepoId)
  );
  const db = makeDb();
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
    fn(db)
  );
  mockTargeted.mockResolvedValue({
    status: TargetedReconcileStatus.Success,
    observations: [],
    providerRead: true,
    writtenCount: 0,
    newestUpdatedAt: null,
    targetNumbers: [],
    missingNumbers: [],
  });
});

function lastSyncData(): Record<string, unknown> {
  return dbState.syncStateUpdates.at(-1)?.data ?? {};
}

describe("reconcileRepo — identity", () => {
  it.each(["acme/widgets/extra", "acme", "/widgets", "acme/"])(
    "reclassifies %s to unsyncable instead of sweeping the repo its segments happen to name (ISS-7548)",
    async (repositoryFullName) => {
      const result = await reconcileRepo(
        { ...INPUT, repositoryFullName },
        { now: NOW }
      );

      expect(result.status).toBe(ReconcileRepoStatus.Reclassified);
      expect(result.tier).toBe(GitHubRepoSyncTier.Unsyncable);
      expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.Unsyncable);
      expect(mockGetClient).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryFullName,
          repositoryId: null,
          status: ReconcileRepoStatus.Reclassified,
          tier: GitHubRepoSyncTier.Unsyncable,
          writtenCount: 0,
          fetchFailureCount: 0,
          budgetDeferralCount: 0,
        })
      );
    }
  );
});

describe("reconcileRepo — denials", () => {
  it("marks deferred: budget without touching tier/watermark/failures", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.BudgetDeferred },
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Deferred);
    expect(result.deferredReason).toBe(GitHubRepoSyncDeferralReason.Budget);
    const data = lastSyncData();
    expect(data.deferredReason).toBe(GitHubRepoSyncDeferralReason.Budget);
    expect(data.tier).toBeUndefined();
    expect(data.watermark).toBeUndefined();
    expect(data.consecutiveFailureCount).toBeUndefined();
    expect(data.nextRetryAt).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ReconcileRepoStatus.Deferred,
        tier: GitHubRepoSyncTier.UserToken,
        deferredReason: GitHubRepoSyncDeferralReason.Budget,
        resultReason: GitHubAccessDenialReason.BudgetDeferred,
        budgetDeferralCount: 1,
      })
    );
  });

  it("defers on pool contention instead of reclassifying the repo (ISS-8270)", async () => {
    installationRepoId = "repo-row-1";
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Contention },
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Deferred);
    expect(result.deferredReason).toBe(GitHubRepoSyncDeferralReason.Contention);
    // A peer sweep holds the credential: nothing about this repo's tier, its
    // backlog, or its failure history changed, so none of them may be written.
    expect(mockClassify).not.toHaveBeenCalled();
    const data = lastSyncData();
    expect(data.deferredReason).toBe(GitHubRepoSyncDeferralReason.Contention);
    expect(data.tier).toBeUndefined();
    expect(data.watermark).toBeUndefined();
    expect(data.cursor).toBeUndefined();
    expect(data.consecutiveFailureCount).toBeUndefined();
    expect(data.nextRetryAt).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ReconcileRepoStatus.Deferred,
        tier: GitHubRepoSyncTier.UserToken,
        deferredReason: GitHubRepoSyncDeferralReason.Contention,
        resultReason: GitHubAccessDenialReason.Contention,
        // Contention is not a budget floor — it must not inflate the deferral
        // counter the budget monitor reads.
        budgetDeferralCount: 0,
      })
    );
  });

  it("reclassifies the tier when no credential can reach the repo", async () => {
    installationRepoId = "repo-row-1";
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Revoked },
    });
    mockClassify.mockResolvedValue(GitHubRepoSyncTier.Unsyncable);

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Reclassified);
    expect(mockClassify).toHaveBeenCalledWith({
      now: NOW,
      organizationId: "org-1",
      owner: "acme",
      repo: "widgets",
    });
    expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.Unsyncable);
    expect(lastSyncData().consecutiveFailureCount).toBe(0);
    expect(lastSyncData().nextRetryAt).toBeNull();
    expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo-row-1",
        repositoryFullName: "acme/widgets",
        status: ReconcileRepoStatus.Reclassified,
        resultReason: GitHubAccessDenialReason.Revoked,
        writtenCount: 0,
        fetchFailureCount: 0,
        budgetDeferralCount: 0,
      })
    );
  });

  it("backs off (increments failures) on a transient provider outage", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });

    const result = await reconcileRepo(
      { ...INPUT, consecutiveFailureCount: 2 },
      { now: NOW }
    );

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(3);
    expect(lastSyncData().nextRetryAt).toEqual(computeNextRetryAt(3, NOW));
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("persistFailure guards on consecutiveFailureCount so a late failure cannot overwrite a concurrent success", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 2 }, { now: NOW });

    const failureUpdate = dbState.syncStateUpdates.find(
      (u) => (u.data as Record<string, unknown>).consecutiveFailureCount === 3
    );
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate?.where).toEqual(
      expect.objectContaining({ consecutiveFailureCount: 2 })
    );
  });
});

describe("reconcileRepo — sweep", () => {
  function wireSuccess(
    prs: ReturnType<typeof readModelPr>[],
    kind: GitHubCredentialKind = GitHubCredentialKind.Installation,
    page: {
      truncated?: boolean;
      nextCursor?: string | null;
      rateLimit?: { cost?: number | null; remaining?: number | null };
    } = {}
  ) {
    const client = makeClient(kind);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockQuery.mockImplementation(
      (
        _octokit: unknown,
        _owner: string,
        _repo: string,
        _numbers: number[],
        opts: Record<string, unknown>,
        observer?: (o: unknown) => void
      ) => {
        fetchOpts = opts;
        observer?.({
          page: 0,
          itemCount: prs.length,
          rateLimit: {
            cost: page.rateLimit?.cost === undefined ? 4 : page.rateLimit.cost,
            remaining:
              page.rateLimit?.remaining === undefined
                ? 4991
                : page.rateLimit.remaining,
            resetAt: "2026-08-03T13:00:00Z",
            state: "available",
          },
        });
        return Promise.resolve({
          status: GitHubProviderResultStatus.Success,
          value: {
            pullRequests: prs,
            truncated: page.truncated ?? false,
            nextCursor: page.nextCursor ?? null,
          },
        });
      }
    );
    return client;
  }

  it("feeds each page's budget back to the pool and records positive access", async () => {
    const client = wireSuccess([
      readModelPr({ number: 5, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(client.recordRateLimit).toHaveBeenCalledWith({
      cost: 4,
      remaining: 4991,
      resetAt: "2026-08-03T13:00:00Z",
    });
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.Ok
    );
  });

  it.each([
    { field: "cost", cost: null, remaining: 4991 },
    { field: "remaining", cost: 4, remaining: null },
  ])(
    "ignores a rate-limit observation with null $field and still completes the sweep",
    async ({ cost, remaining }) => {
      const client = wireSuccess(
        [readModelPr({ number: 5, updatedAt: "2026-08-02T00:00:00Z" })],
        GitHubCredentialKind.Installation,
        { rateLimit: { cost, remaining } }
      );

      const result = await reconcileRepo(INPUT, { now: NOW });

      expect(result.status).toBe(ReconcileRepoStatus.Swept);
      expect(client.recordRateLimit).not.toHaveBeenCalled();
    }
  );

  it("contains a real first-row authority failure so the tail, debounce, and state commit still run", async () => {
    projectionWriteMocks.useActualWriter = true;
    installationRepoId = "repo-row-1";
    dbState.selfHealRows = [{ number: 5 }];
    projectionWriteMocks.persistHeadAuthority
      .mockRejectedValueOnce(new Error("authority write timed out"))
      .mockResolvedValueOnce(false);
    const projectionIds: string[] = [];
    const db = makeDb();
    // ISS-8919: asserts the retired per-PR identity read stays retired.
    const findUnique = vi.fn();
    Object.assign(db.pullRequestDetail, {
      findUnique,
      updateManyAndReturn: vi.fn((args: { where: { id: string } }) => {
        projectionIds.push(args.where.id);
        return Promise.resolve([{ branchArtifactId: null }]);
      }),
      updateMany: vi.fn((args: { where: Record<string, unknown> }) => {
        dbState.debounceCalls.push(args.where);
        return Promise.resolve({ count: 1 });
      }),
    });
    mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
    mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
      fn(db)
    );
    wireSuccess([
      readModelPr({ number: 5, updatedAt: "2026-08-03T00:00:00Z" }),
      readModelPr({ number: 6, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result).toMatchObject({
      status: ReconcileRepoStatus.Swept,
      writtenCount: 2,
    });
    expect(projectionIds).toEqual(["detail-5", "detail-6"]);
    expect(findUnique).not.toHaveBeenCalled();
    expect(projectionWriteMocks.persistHeadAuthority).toHaveBeenCalledTimes(2);
    expect(dbState.debounceCalls).toContainEqual(
      expect.objectContaining({ number: { in: [5] } })
    );
    expect(dbState.syncStateUpdates).toHaveLength(1);
    expect(lastSyncData()).toMatchObject({
      watermark: new Date("2026-08-03T00:00:00Z"),
      cursor: null,
      consecutiveFailureCount: 0,
      nextRetryAt: null,
    });
  });

  it("writes only PRs changed since the watermark and advances it to the newest", async () => {
    installationRepoId = "repo-row-1";
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }), // fresh
      readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }), // stale
    ]);

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Swept);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ number: 9 });
    // Watermark advances to the newest updatedAt observed this sweep.
    expect(lastSyncData().watermark).toEqual(new Date("2026-08-02T10:00:00Z"));
    expect(lastSyncData().deferredReason).toBeNull();
    expect(lastSyncData().consecutiveFailureCount).toBe(0);
    expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.Installed);
    expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ReconcileRepoStatus.Swept,
        repositoryId: "repo-row-1",
        repositoryFullName: "acme/widgets",
        tier: GitHubRepoSyncTier.Installed,
        writtenCount: 1,
        fetchFailureCount: 0,
        budgetDeferralCount: 0,
      })
    );
  });

  it("scopes self-heal selection by the resolved installation repository id", async () => {
    installationRepoId = "repo-row-1";
    wireSuccess([]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(findInstallationRepositoryId).toHaveBeenCalledWith(
      "org-1",
      "acme/widgets"
    );
    expect(dbState.selfHealWhere).toMatchObject({ repositoryId: "repo-row-1" });
    expect(dbState.selfHealWhere).not.toHaveProperty("repositoryFullName");
  });

  it("falls back to the normalized repository name when no installation row resolves", async () => {
    wireSuccess([]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(dbState.selfHealWhere).toMatchObject({
      repositoryId: null,
      repositoryFullName: "acme/widgets",
    });
  });

  it("debounces self-heal selection by lastRefreshAttemptAt so a never-fillable PR cannot re-occupy the batch", async () => {
    wireSuccess([]);

    await reconcileRepo(INPUT, { now: NOW });

    const andClauses = (dbState.selfHealWhere?.AND ?? []) as {
      OR?: Record<string, unknown>[];
    }[];
    const debounce = andClauses.find((clause) =>
      clause.OR?.some((predicate) => "lastRefreshAttemptAt" in predicate)
    );
    expect(debounce?.OR).toContainEqual({ lastRefreshAttemptAt: null });
  });

  it("routes tier-2 user-token sync through targeted session-linked reconciliation", async () => {
    const client = wireSuccess(
      [readModelPr({ number: 7, updatedAt: "2026-08-02T00:00:00Z" })],
      GitHubCredentialKind.OauthUser
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockTargeted).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        provenance: expect.objectContaining({
          credentialOwnerId: "user-uuid-1",
        }),
      })
    );
  });

  it("records a null credential owner on an installation write", async () => {
    wireSuccess([
      readModelPr({ number: 7, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credentialOwnerId: null })
    );
  });

  it("derives tier user_token when the pool draws a user credential", async () => {
    wireSuccess(
      [readModelPr({ number: 7, updatedAt: "2026-08-02T00:00:00Z" })],
      GitHubCredentialKind.OauthUser
    );
    mockTargeted.mockResolvedValueOnce({
      status: TargetedReconcileStatus.Success,
      observations: [],
      providerRead: true,
      writtenCount: 2,
      newestUpdatedAt: new Date("2026-08-02T00:00:00Z"),
      targetNumbers: [7],
      missingNumbers: [],
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.tier).toBe(GitHubRepoSyncTier.UserToken);
    expect(result.writtenCount).toBe(2);
    expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.UserToken);
    expect(lastSyncData().watermark).toBeUndefined();
    expect(lastSyncData().cursor).toBeNull();
  });

  it("backs off and records no-access when the targeted tier-2 fetch fails", async () => {
    const client = makeClient(GitHubCredentialKind.OauthUser);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockTargeted.mockResolvedValueOnce({
      status: TargetedReconcileStatus.FetchFailed,
      observations: [
        {
          page: 0,
          itemCount: 0,
          rateLimit: {
            cost: 1,
            remaining: 4999,
            resetAt: "2026-08-03T13:00:00Z",
            state: "available",
          },
        },
      ],
      targetNumbers: [7],
      result: { status: GitHubProviderResultStatus.ProviderRepoNotFound },
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRateLimit).toHaveBeenCalledWith({
      cost: 1,
      remaining: 4999,
      resetAt: "2026-08-03T13:00:00Z",
    });
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(mockWriteFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestNumbers: [7],
        result: { status: GitHubProviderResultStatus.ProviderRepoNotFound },
      })
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("backs off when the fetch itself fails after a successful draw", async () => {
    dbState.selfHealRows = [{ number: 3 }, { number: 4 }];
    mockWriteFailures.mockResolvedValueOnce(2);
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.Installation),
    });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const result = await reconcileRepo(
      { ...INPUT, consecutiveFailureCount: 0 },
      { now: NOW }
    );

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockWriteFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: INPUT.organizationId,
        result: {
          status: GitHubProviderResultStatus.ProviderUnavailable,
        },
        provenance: expect.objectContaining({
          observationKey: expect.any(String),
        }),
      })
    );
    expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ReconcileRepoStatus.Failed,
        tier: GitHubRepoSyncTier.Installed,
        resultReason: GitHubProviderResultStatus.ProviderUnavailable,
        fetchFailureCount: 1,
        targetFetchFailureWriteCount: 2,
      })
    );
  });

  it("persists a continuation cursor when a bounded read truncates a backlog", async () => {
    wireSuccess(
      [readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" })],
      GitHubCredentialKind.Installation,
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().cursor).toBe("cursor-page-2");
  });

  it("does NOT re-drain in steady state: a truncated top page that reaches watermark-old PRs clears the cursor", async () => {
    wireSuccess(
      [
        readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }), // fresh
        readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }), // <= watermark
      ],
      GitHubCredentialKind.Installation,
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().cursor).toBeNull();
  });

  it("DOES start a drain in steady state when every fetched PR is newer than the watermark (a real >window burst)", async () => {
    wireSuccess(
      [
        readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
        readModelPr({ number: 8, updatedAt: "2026-08-02T09:00:00Z" }),
      ],
      GitHubCredentialKind.Installation,
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().cursor).toBe("cursor-page-2");
  });

  it("resumes from the stored cursor and refreshes every fetched row while draining", async () => {
    wireSuccess(
      [readModelPr({ number: 3, updatedAt: "2026-07-10T00:00:00Z" })],
      GitHubCredentialKind.Installation,
      { truncated: false }
    );

    await reconcileRepo({ ...INPUT, cursor: "cursor-page-2" }, { now: NOW });

    expect(fetchOpts?.after).toBe("cursor-page-2");
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ number: 3 });
    expect(lastSyncData().cursor).toBeNull();
  });
});

describe("reconcileRepo — repo denial verdicts (ISS-5093)", () => {
  function wireFailureResult(
    status: GitHubProviderResultStatus,
    kind: GitHubCredentialKind = GitHubCredentialKind.Installation
  ) {
    const client = makeClient(kind);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockQuery.mockResolvedValue({ status });
    return client;
  }

  it("ProviderRepoNotFound records NoAccess verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderRepoForbidden records NoAccess verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoForbidden
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderPermissionFiltered does NOT record a repo access verdict", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderPermissionFiltered
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).not.toHaveBeenCalled();
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderUnavailable does not record a repo access verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderUnavailable
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).not.toHaveBeenCalled();
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderRateLimit does not record a repo access verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRateLimit
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).not.toHaveBeenCalled();
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("installation lane: ProviderRepoNotFound persists failure; no capability verdict is stored because recordRepoAccess is a production no-op for installation clients", async () => {
    // In production, github-sync-client-pool.ts (resolveCoveringInstallation)
    // wires recordRepoAccess as a hard no-op for installation clients.
    // Installation reach is governed by the installation's repository list, not
    // per-credential verdicts. A future implementer must NOT 'fix' this by
    // wiring real installation verdicts — doing so would conflate two orthogonal
    // access models and mis-demote repos whose installation simply hasn't listed
    // them yet.
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound,
      GitHubCredentialKind.Installation
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
    // recordNoAccessIfRepoDenied has no client-kind guard — it calls
    // recordRepoAccess for all clients — but the production installation-lane
    // implementation is a hard no-op (see resolveCoveringInstallation in
    // github-sync-client-pool.ts). The mock here resolves silently, matching
    // that real behavior: the function is called, nothing is stored.
    expect(client.recordRepoAccess).toHaveBeenCalled();
  });

  it("writeReconciledPullRequestFailures rejection does not block verdict or failure persist", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound
    );
    mockWriteFailures.mockRejectedValueOnce(
      new Error("transactional writer threw")
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("recordRepoAccess rejection is swallowed and failure is still persisted (best-effort guard)", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound
    );
    client.recordRepoAccess.mockRejectedValue(
      new Error("capability store outage")
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });
});

describe("reconcileRepo — nextRetryAt lifecycle", () => {
  function wireSuccess(
    prs: ReturnType<typeof readModelPr>[],
    kind: GitHubCredentialKind = GitHubCredentialKind.Installation
  ) {
    const client = makeClient(kind);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: prs,
        truncated: false,
        nextCursor: null,
      },
    });
    return client;
  }

  it("clears nextRetryAt on a successful sweep", async () => {
    wireSuccess([
      readModelPr({ number: 1, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 3 }, { now: NOW });

    expect(lastSyncData().consecutiveFailureCount).toBe(0);
    expect(lastSyncData().nextRetryAt).toBeNull();
  });

  it("sets nextRetryAt on a fetch failure", async () => {
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.Installation),
    });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
      value: null,
    });

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 4 }, { now: NOW });

    expect(lastSyncData().consecutiveFailureCount).toBe(5);
    expect(lastSyncData().nextRetryAt).toEqual(computeNextRetryAt(5, NOW));
  });

  it("ISS-7875: a failed read names the provider status that caused it", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {
      // silence
    });
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.Installation),
    });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRepoForbidden,
      value: null,
    });

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 4 }, { now: NOW });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("repo sweep failed"),
      expect.objectContaining({
        repositoryFullName: "acme/widgets",
        reason: GitHubProviderResultStatus.ProviderRepoForbidden,
        consecutiveFailureCount: 5,
      })
    );
    warn.mockRestore();
  });

  it("ISS-7875: a rate-limited denial names the denial reason, not the read status", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {
      // silence
    });
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.RateLimited },
    });

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 0 }, { now: NOW });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("repo sweep failed"),
      expect.objectContaining({
        reason: GitHubAccessDenialReason.RateLimited,
        consecutiveFailureCount: 1,
      })
    );
    warn.mockRestore();
  });
});

describe("persistFailureSettlement", () => {
  const TARGET = {
    organizationId: "org-1",
    repositoryFullName: "acme/widgets",
    consecutiveFailureCount: 2,
  };

  it("bumps the failure count and backoff under a compare-and-set on the read count", async () => {
    await persistFailureSettlement(TARGET, NOW, {
      stampSwept: true,
      reason: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const update = dbState.syncStateUpdates.at(-1);
    expect(update?.where).toEqual({
      organizationId: "org-1",
      repositoryFullName: "acme/widgets",
      consecutiveFailureCount: 2,
    });
    expect(update?.data.consecutiveFailureCount).toBe(3);
    expect(update?.data.nextRetryAt).toEqual(computeNextRetryAt(3, NOW));
    expect(update?.data.lastSweptAt).toEqual(NOW);
  });

  it("leaves lastSweptAt untouched when stampSwept is false (ISS-6589 throw path)", async () => {
    await persistFailureSettlement(TARGET, NOW, {
      stampSwept: false,
      reason: RECONCILE_UNEXPECTED_FAILURE_REASON,
    });

    const update = dbState.syncStateUpdates.at(-1);
    expect(update?.data.lastSweptAt).toBeUndefined();
    expect(update?.data.consecutiveFailureCount).toBe(3);
    expect(update?.data.nextRetryAt).toEqual(computeNextRetryAt(3, NOW));
  });
});
