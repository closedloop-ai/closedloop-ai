import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/db-fanout", () => ({
  mapWithDbConcurrency: (
    items: readonly unknown[],
    fn: (item: unknown, index: number) => Promise<unknown>
  ) => Promise.all(items.map((item, index) => fn(item, index))),
}));

vi.mock("../repo-reconciler", () => ({
  reconcileRepo: vi.fn(),
  ReconcileRepoStatus: {
    Swept: "swept",
    Deferred: "deferred",
    Reclassified: "reclassified",
    Failed: "failed",
  },
}));

import { withDb } from "@repo/database";
import { GITHUB_SYNC_REPO_VERDICT_TTL_MS } from "@/lib/github/github-access";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { GitHubRepoSyncTier } from "@/lib/github/github-repo-sync-state";
import { ReconcileRepoStatus, reconcileRepo } from "../repo-reconciler";
import {
  githubPullRequestReconcilerService,
  RECONCILE_REPO_BATCH,
  RECONCILE_WAKEUP_BATCH,
} from "../service";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
const mockReconcile = reconcileRepo as unknown as ReturnType<typeof vi.fn>;

type SyncStateQuery = {
  where: { tier?: unknown };
  orderBy: unknown;
  take: number;
};
type SyncStateRow = {
  organizationId: string;
  repositoryFullName: string;
  watermark: Date | null;
  cursor: string | null;
  consecutiveFailureCount: number;
};

// Captured PER CALL: the tick now issues two independent selects (the main
// batch and the ISS-5093 tier-3 wake-up), so a single overwritten slot would
// silently assert against whichever ran last.
let findManyCalls: SyncStateQuery[];
let dueRepos: SyncStateRow[];
let wakeupRepos: SyncStateRow[];
let sweptStamps: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  findManyCalls = [];
  dueRepos = [];
  wakeupRepos = [];
  sweptStamps = [];
  const db = {
    gitHubRepoSyncState: {
      findMany: vi.fn((args: SyncStateQuery) => {
        findManyCalls.push(args);
        const isWakeup = args.where.tier === GitHubRepoSyncTier.Unsyncable;
        return Promise.resolve(isWakeup ? wakeupRepos : dueRepos);
      }),
      updateMany: vi.fn((args: unknown) => {
        sweptStamps.push(args);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
});

function outcome(status: string, writtenCount = 0) {
  return {
    repositoryFullName: "acme/widgets",
    status,
    tier: GitHubRepoSyncTier.Installed,
    writtenCount,
    deferredReason: null,
  };
}

describe("githubPullRequestReconcilerService.run", () => {
  it("selects the most-overdue syncable repos, never tier-3, bounded", async () => {
    await githubPullRequestReconcilerService.run();

    expect(findManyCalls[0]?.where).toEqual({
      tier: { not: GitHubRepoSyncTier.Unsyncable },
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: expect.any(Date) } },
        { consecutiveFailureCount: 0 },
      ],
    });
    expect(findManyCalls[0]?.orderBy).toEqual([
      { lastSweptAt: { sort: "asc", nulls: "first" } },
    ]);
    expect(findManyCalls[0]?.take).toBe(RECONCILE_REPO_BATCH);
  });

  it("passes the injected now through to selectDueRepos", async () => {
    const now = new Date("2026-08-14T10:00:00Z");
    await githubPullRequestReconcilerService.run({ now });

    expect(findManyCalls[0]?.where).toEqual({
      tier: { not: GitHubRepoSyncTier.Unsyncable },
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
        { consecutiveFailureCount: 0 },
      ],
    });
  });

  it("reconciles each due repo and aggregates the outcome counts", async () => {
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "a/1",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
      {
        organizationId: "o",
        repositoryFullName: "a/2",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
      {
        organizationId: "o",
        repositoryFullName: "a/3",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
      {
        organizationId: "o",
        repositoryFullName: "a/4",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile
      .mockResolvedValueOnce(outcome(ReconcileRepoStatus.Swept, 3))
      .mockResolvedValueOnce(outcome(ReconcileRepoStatus.Deferred))
      .mockResolvedValueOnce(outcome(ReconcileRepoStatus.Reclassified))
      .mockResolvedValueOnce(outcome(ReconcileRepoStatus.Failed, 0));

    const summary = await githubPullRequestReconcilerService.run();

    expect(summary).toEqual({
      reposSelected: 4,
      reposSwept: 1,
      reposDeferredBudget: 1,
      reposReclassified: 1,
      reposFailed: 1,
      pullRequestsWritten: 3,
    });
    expect(mockReconcile).toHaveBeenCalledTimes(4);
  });

  it("isolates a thrown repo reconcile as a failure without aborting the batch", async () => {
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "a/1",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
      {
        organizationId: "o",
        repositoryFullName: "a/2",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(outcome(ReconcileRepoStatus.Swept, 2));

    const summary = await githubPullRequestReconcilerService.run();

    expect(summary.reposFailed).toBe(1);
    expect(summary.reposSwept).toBe(1);
    expect(summary.pullRequestsWritten).toBe(2);
  });

  it("wake-up query shape: tier-3, stale lastSweptAt, org-scoped, bounded by RECONCILE_WAKEUP_BATCH", async () => {
    // Pass an explicit now so the staleBefore threshold is deterministic.
    const testNow = new Date("2026-08-03T12:00:00.000Z");
    const staleBefore = new Date(
      testNow.getTime() - GITHUB_SYNC_REPO_VERDICT_TTL_MS
    );

    await githubPullRequestReconcilerService.run({ now: testNow });

    expect(findManyCalls[1]).toMatchObject({
      take: RECONCILE_WAKEUP_BATCH,
      orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }],
      where: {
        tier: GitHubRepoSyncTier.Unsyncable,
        organization: {
          githubUserConnections: {
            some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
          },
        },
        OR: [{ lastSweptAt: null }, { lastSweptAt: { lt: staleBefore } }],
      },
    });
  });

  it("selectDueRepos where clause includes nextRetryAt backoff; ISS-5093 wake-up is a separate second query", async () => {
    await githubPullRequestReconcilerService.run();

    expect(findManyCalls[0]?.where).toEqual({
      tier: { not: GitHubRepoSyncTier.Unsyncable },
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: expect.any(Date) } },
        { consecutiveFailureCount: 0 },
      ],
    });
    // Two findMany calls confirms the wake-up ran as a SEPARATE query, not
    // merged into the main batch. Merging them would let an unbounded tier-3
    // population crowd real work out of the 25-row global batch.
    expect(findManyCalls).toHaveLength(2);
  });

  it("wake-up repos are appended to the batch and reconciled alongside due repos", async () => {
    wakeupRepos = [
      {
        organizationId: "o",
        repositoryFullName: "wakeup/repo",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile.mockResolvedValueOnce(outcome(ReconcileRepoStatus.Swept, 1));

    const summary = await githubPullRequestReconcilerService.run();

    expect(mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: "wakeup/repo" }),
      expect.any(Object)
    );
    // 0 dueRepos + 1 wakeupRepo = 1 selected total.
    expect(summary.reposSelected).toBe(1);
    expect(summary.reposSwept).toBe(1);
  });

  it("transient wake-up query failure does not abort the main batch", async () => {
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "acme/widgets",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile.mockResolvedValueOnce(outcome(ReconcileRepoStatus.Swept, 3));
    const db = {
      gitHubRepoSyncState: {
        findMany: vi.fn((args: SyncStateQuery) => {
          findManyCalls.push(args);
          const isWakeup = args.where.tier === GitHubRepoSyncTier.Unsyncable;
          if (isWakeup) {
            return Promise.reject(new Error("transient DB error"));
          }
          return Promise.resolve(dueRepos);
        }),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
    };
    mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));

    const summary = await githubPullRequestReconcilerService.run();

    expect(summary.reposSelected).toBe(1);
    expect(summary.reposSwept).toBe(1);
  });

  it("stampSweptBestEffort writes lastSweptAt for a wake-up row that throws, preventing re-selection next tick", async () => {
    // Eligibility IS 'lastSweptAt is stale', so leaving it unstamped would
    // re-select the same broken repo every tick and exhaust the wake-up budget.
    wakeupRepos = [
      {
        organizationId: "o",
        repositoryFullName: "broken/wakeup",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile.mockRejectedValueOnce(new Error("unexpected failure"));

    await githubPullRequestReconcilerService.run();

    expect(sweptStamps).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "o",
          repositoryFullName: "broken/wakeup",
        }),
        data: expect.objectContaining({ lastSweptAt: expect.any(Date) }),
      })
    );
  });
});
