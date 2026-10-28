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

vi.mock("../repo-reconciler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repo-reconciler")>()),
  reconcileRepo: vi.fn(),
  // The settlement WRITE is owned by repo-reconciler and covered there; the
  // service's job is to call it, for the right row, with the right stampSwept
  // and the reason its own lane knows.
  persistFailureSettlement: vi.fn(),
}));

const deliveryCoverageMocks = vi.hoisted(() => ({
  reportGitHubDeliveryCoverageTick: vi.fn(),
}));

vi.mock("../delivery-coverage-metrics", () => ({
  reportGitHubDeliveryCoverageTick:
    deliveryCoverageMocks.reportGitHubDeliveryCoverageTick,
}));

import { withDb } from "@repo/database";
import { GITHUB_SYNC_REPO_VERDICT_TTL_MS } from "@/lib/github/github-access";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import {
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import { ReconcileRepoStatus } from "../repo-reconcile-status";
import {
  persistFailureSettlement,
  RECONCILE_UNEXPECTED_FAILURE_REASON,
  reconcileRepo,
} from "../repo-reconciler";
import {
  githubPullRequestReconcilerService,
  RECONCILE_REPO_BATCH,
  RECONCILE_WAKEUP_BATCH,
} from "../service";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
const mockReconcile = reconcileRepo as unknown as ReturnType<typeof vi.fn>;
const mockSettleFailure = persistFailureSettlement as unknown as ReturnType<
  typeof vi.fn
>;
const mockReportCoverage =
  deliveryCoverageMocks.reportGitHubDeliveryCoverageTick;

type SyncStateQuery = {
  where: { tier?: unknown };
  orderBy: unknown;
  take: number;
};
type SyncStateRow = {
  organizationId: string;
  repositoryFullName: string;
  tier?: string | null;
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
type CountQuery = {
  where: { repositoryFullName?: { notIn: string[] } };
};
let countCalls: CountQuery[];
// The org's due population by name, as the database would see it AFTER the
// sweep — so a repo this pass failed is already absent from it, exactly as its
// settlement leaves it. The count mock applies the query's own exclusion to
// this, so a case states a population rather than a pre-computed answer.
let stillDueRepoNames: string[];
let countRejection: Error | null;
let sweptStampRejection: Error | null;

beforeEach(() => {
  vi.clearAllMocks();
  findManyCalls = [];
  dueRepos = [];
  wakeupRepos = [];
  sweptStamps = [];
  countCalls = [];
  stillDueRepoNames = [];
  countRejection = null;
  sweptStampRejection = null;
  mockReportCoverage.mockResolvedValue(undefined);
  const db = {
    gitHubRepoSyncState: {
      findMany: vi.fn((args: SyncStateQuery) => {
        findManyCalls.push(args);
        const isWakeup = args.where.tier === GitHubRepoSyncTier.Unsyncable;
        return Promise.resolve(isWakeup ? wakeupRepos : dueRepos);
      }),
      count: vi.fn((args: CountQuery) => {
        countCalls.push(args);
        if (countRejection) {
          return Promise.reject(countRejection);
        }
        const handled = args.where.repositoryFullName?.notIn ?? [];
        return Promise.resolve(
          stillDueRepoNames.filter((name) => !handled.includes(name)).length
        );
      }),
      updateMany: vi.fn((args: unknown) => {
        sweptStamps.push(args);
        if (sweptStampRejection) {
          return Promise.reject(sweptStampRejection);
        }
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
});

function outcome(
  status: string,
  writtenCount = 0,
  deferredReason: GitHubRepoSyncDeferralReason | null = null
) {
  return {
    repositoryFullName: "acme/widgets",
    status,
    tier: GitHubRepoSyncTier.Installed,
    writtenCount,
    deferredReason,
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
      reposDeferredContention: 0,
      reposReclassified: 1,
      reposFailed: 1,
      pullRequestsWritten: 3,
    });
    expect(mockReconcile).toHaveBeenCalledTimes(4);
  });

  it("counts a contention deferral apart from the budget floor (ISS-8270)", async () => {
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
      .mockResolvedValueOnce(
        outcome(
          ReconcileRepoStatus.Deferred,
          0,
          GitHubRepoSyncDeferralReason.Budget
        )
      )
      .mockResolvedValueOnce(
        outcome(
          ReconcileRepoStatus.Deferred,
          0,
          GitHubRepoSyncDeferralReason.Contention
        )
      );

    const summary = await githubPullRequestReconcilerService.run();

    // A busy pool and a throttled one are different operator signals; one
    // deferral tally for both reports the first as the second.
    expect(summary.reposDeferredBudget).toBe(1);
    expect(summary.reposDeferredContention).toBe(1);
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

  it("emits a failed delivery coverage repo tick for an isolated thrown repo reconcile", async () => {
    const now = new Date("2026-08-26T19:20:00.000Z");
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "broken/main",
        tier: GitHubRepoSyncTier.UserToken,
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 1,
      },
    ];
    mockReconcile.mockRejectedValueOnce(new Error("unexpected failure"));

    await githubPullRequestReconcilerService.run({ now });

    expect(mockReportCoverage).toHaveBeenCalledWith({
      organizationId: "o",
      repositoryId: null,
      repositoryFullName: "broken/main",
      status: ReconcileRepoStatus.Failed,
      tier: GitHubRepoSyncTier.UserToken,
      writtenCount: 0,
      deferredReason: null,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 0,
      now,
    });
  });

  it("a thrown main-batch repo gets the failure backoff, so it stops heading every batch", async () => {
    // No settlement at all would leave its stale lastSweptAt at the head of the
    // oldest-swept-first selector forever; 25 such repos zero the sweep out.
    const now = new Date("2026-08-14T10:00:00Z");
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "broken/main",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 2,
      },
    ];
    mockReconcile.mockRejectedValueOnce(new Error("unexpected failure"));

    await githubPullRequestReconcilerService.run({ now });

    expect(mockSettleFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "o",
        repositoryFullName: "broken/main",
        consecutiveFailureCount: 2,
      }),
      now,
      // Not stamped: moving lastSweptAt would silently reorder the queue.
      // ISS-7875: the throw lane names itself, so a settlement written here is
      // distinguishable in the log from a classified provider failure.
      { stampSwept: false, reason: RECONCILE_UNEXPECTED_FAILURE_REASON }
    );
  });

  it("a thrown main-batch repo does not take the wake-up lastSweptAt stamp path", async () => {
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "broken/main",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile.mockRejectedValueOnce(new Error("unexpected failure"));

    await githubPullRequestReconcilerService.run();

    // Whether the settlement itself omits lastSweptAt is asserted where that
    // write lives (repo-reconciler, plus the DB integration case); here the
    // claim is only that the main lane never reaches stampSweptBestEffort.
    expect(sweptStamps).toEqual([]);
  });

  it("a failed backoff write stays inside the isolation and does not fail the batch", async () => {
    dueRepos = [
      {
        organizationId: "o",
        repositoryFullName: "broken/main",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    mockReconcile.mockRejectedValueOnce(new Error("unexpected failure"));
    mockSettleFailure.mockRejectedValueOnce(new Error("write failed"));

    const summary = await githubPullRequestReconcilerService.run();

    expect(summary.reposFailed).toBe(1);
  });

  it("a thrown wake-up row is settled by its lastSweptAt stamp, not the backoff", async () => {
    // The wake-up selector never reads nextRetryAt, so only the stamp bounds it.
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

    expect(mockSettleFailure).not.toHaveBeenCalled();
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

  it("keeps a wake-up reconciliation failure isolated when its best-effort stamp also rejects", async () => {
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
    sweptStampRejection = new Error("stamp write failed");

    const summary = await githubPullRequestReconcilerService.run();

    expect(summary.reposFailed).toBe(1);
    expect(summary.reposSelected).toBe(1);
    expect(mockSettleFailure).not.toHaveBeenCalled();
  });
});

describe("githubPullRequestReconcilerService.runForOrganization", () => {
  const now = new Date("2026-08-25T10:00:00Z");

  it("selects only the caller's org, on the same due predicate as the cron batch", async () => {
    await githubPullRequestReconcilerService.runForOrganization("org-1", {
      limit: 5,
      now,
    });

    expect(findManyCalls[0]?.where).toEqual({
      organizationId: "org-1",
      tier: { not: GitHubRepoSyncTier.Unsyncable },
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
        { consecutiveFailureCount: 0 },
      ],
    });
    expect(findManyCalls[0]?.take).toBe(5);
    // The remaining count has to ask the same question as the selection, or the
    // number reported as left-for-the-cron describes a different population.
    expect(countCalls[0]?.where).toEqual(findManyCalls[0]?.where);
  });

  it("reconciles the selected repos and reports what the bound left behind", async () => {
    dueRepos = [
      {
        organizationId: "org-1",
        repositoryFullName: "acme/one",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
      {
        organizationId: "org-1",
        repositoryFullName: "acme/two",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    // Both selected repos swept cleanly, so both are still due afterwards; the
    // remainder is the seven the limit never reached.
    stillDueRepoNames = [
      "acme/one",
      "acme/two",
      ...Array.from({ length: 7 }, (_, index) => `acme/spare-${index}`),
    ];
    mockReconcile.mockResolvedValue(outcome(ReconcileRepoStatus.Swept, 3));

    const summary = await githubPullRequestReconcilerService.runForOrganization(
      "org-1",
      { limit: 2, now }
    );

    expect(mockReconcile).toHaveBeenCalledTimes(2);
    expect(summary.reposSelected).toBe(2);
    expect(summary.reposSwept).toBe(2);
    expect(summary.pullRequestsWritten).toBe(6);
    expect(summary.reposRemaining).toBe(7);
  });

  it("still sweeps, and reports no remainder, when the count fails", async () => {
    dueRepos = [
      {
        organizationId: "org-1",
        repositoryFullName: "acme/one",
        watermark: null,
        cursor: null,
        consecutiveFailureCount: 0,
      },
    ];
    countRejection = new Error("count timed out");
    mockReconcile.mockResolvedValue(outcome(ReconcileRepoStatus.Swept, 4));

    const summary = await githubPullRequestReconcilerService.runForOrganization(
      "org-1",
      { limit: 5, now }
    );

    // The remainder is a footnote to the sweep, so losing it must not cost the
    // just-connected org the reconciliation it is a footnote to — and it must
    // not report 0, the one value that reads as full coverage.
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(summary.reposSwept).toBe(1);
    expect(summary.pullRequestsWritten).toBe(4);
    expect(summary.reposRemaining).toBeNull();
  });

  it("floors the limit at one repo", async () => {
    await githubPullRequestReconcilerService.runForOrganization("org-1", {
      limit: 0,
      now,
    });

    expect(findManyCalls[0]?.take).toBe(1);
  });

  it("does not deduct a repo this pass already failed out of the due population", async () => {
    dueRepos = [
      orgRepo("acme/one"),
      orgRepo("acme/two"),
      orgRepo("acme/three"),
    ];
    // Post-sweep truth for an org of ten due repos whose selected three all
    // failed: each settlement wrote nextRetryAt, so the three are already gone
    // from the due population and only the seven the limit never reached remain.
    stillDueRepoNames = Array.from(
      { length: 7 },
      (_, index) => `acme/spare-${index}`
    );
    mockReconcile.mockResolvedValue(outcome(ReconcileRepoStatus.Failed));

    const summary = await githubPullRequestReconcilerService.runForOrganization(
      "org-1",
      { limit: 3, now }
    );

    expect(summary.reposFailed).toBe(3);
    // Deducting the handled page from a wider count reported 4, subtracting the
    // three failures a second time and drifting the number toward the 0 that
    // reads as full coverage exactly when the pass went worst.
    expect(summary.reposRemaining).toBe(7);
    // The exclusion belongs inside the count, on the selection's own predicate:
    // a second statement to subtract could disagree with the first.
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0]?.where).toEqual({
      organizationId: "org-1",
      tier: { not: GitHubRepoSyncTier.Unsyncable },
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
        { consecutiveFailureCount: 0 },
      ],
      repositoryFullName: { notIn: ["acme/one", "acme/two", "acme/three"] },
    });
  });

  it("isolates a thrown reconcile with the main-batch backoff, never the wake-up stamp", async () => {
    dueRepos = [orgRepo("acme/one")];
    mockReconcile.mockRejectedValueOnce(new Error("unexpected failure"));

    const summary = await githubPullRequestReconcilerService.runForOrganization(
      "org-1",
      { limit: 5, now }
    );

    // Resolving at all is half the contract: mapWithDbConcurrency is fail-fast,
    // so an unisolated throw rejects the whole post-connect chain.
    expect(summary.reposFailed).toBe(1);
    expect(mockSettleFailure).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: "acme/one" }),
      now,
      { stampSwept: false, reason: RECONCILE_UNEXPECTED_FAILURE_REASON }
    );
    // The org lane always passes isWakeup: false, so it must never take the
    // wake-up path that moves lastSweptAt.
    expect(sweptStamps).toEqual([]);
  });
});

function orgRepo(repositoryFullName: string): SyncStateRow {
  return {
    organizationId: "org-1",
    repositoryFullName,
    watermark: null,
    cursor: null,
    consecutiveFailureCount: 0,
  };
}
