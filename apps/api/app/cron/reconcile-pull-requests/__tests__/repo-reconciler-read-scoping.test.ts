import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../reconcile-projection-write", () => ({
  resolveReconcileTargets: vi.fn().mockResolvedValue(new Map()),
  writeReconciledPullRequest: vi.fn(),
  writeReconciledPullRequestFailures: vi.fn().mockResolvedValue(0),
}));

// ISS-12034: this has to keep the real exports now. `repo-reconciler` imports
// `session-linked-targets` DIRECTLY for the installed tier's coverage-gap arm,
// so that module -> `session-artifact-link` is on the import path of every test
// here and its `BranchLifecycleBoundaryKind` schema needs the real const. The
// `normalizeRepoFullName` override stays because the read-scoping assertions
// below are written against this exact normalization.
vi.mock("@repo/api/src/types/branch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/api/src/types/branch")>()),
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

// These tests exercise the installation-tier window and by-number reads only,
// so the tier-2 lane is stubbed to keep the assertions on this file's subject.
vi.mock("../targeted-reconciler", () => ({
  TargetedReconcileStatus: {
    Success: "success",
    FetchFailed: "fetch_failed",
  },
  reconcileTargetedSessionLinkedPullRequests: vi.fn().mockResolvedValue({
    status: "success",
    observations: [],
    providerRead: true,
    writtenCount: 0,
    newestUpdatedAt: null,
    targetNumbers: [],
    missingNumbers: [],
  }),
}));

// Same stub the sibling reconciler suite installs. Without it the real module
// loads and pulls `BranchLifecycleBoundaryKind` through the branch-types mock
// above, which deliberately returns only the one helper these tests need.
vi.mock("../delivery-coverage-metrics", () => ({
  reportGitHubDeliveryCoverageTick: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findInstallationRepositoryId: vi.fn(),
}));

import { GitHubBundledPullRequestsStopReason } from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
  queryPullRequestsByNumberWithProviderResult,
} from "@repo/github";
import {
  dbState,
  INPUT,
  makeClient,
  makeDb,
  NOW,
  readModelPr,
  resetReconcileDbState,
  WATERMARK,
} from "@/__tests__/support/cron/reconcile-pull-requests/repo-reconciler.test-fixtures";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "../reconcile-projection-write";
import { ReconcileRepoStatus } from "../repo-reconcile-status";
import { reconcileRepo } from "../repo-reconciler";

/**
 * ISS-7892. The sweep used to spend its whole page budget every tick and hunt
 * the self-heal batch by scanning the same window, so what it read was decided
 * by the window's size rather than by what had changed. These cover the two
 * reads that replaced it.
 */

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
const mockByNumberQuery =
  queryPullRequestsByNumberWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockWrite = writeReconciledPullRequest as unknown as ReturnType<
  typeof vi.fn
>;
const mockWriteFailures =
  writeReconciledPullRequestFailures as unknown as ReturnType<typeof vi.fn>;

let fetchOpts: Record<string, unknown> | null = null;
let byNumberRequests: number[][] = [];

beforeEach(() => {
  vi.clearAllMocks();
  resetReconcileDbState();
  fetchOpts = null;
  byNumberRequests = [];
  (
    findInstallationRepositoryId as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue(null);
  const db = makeDb();
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
    fn(db)
  );
  mockWrite.mockResolvedValue(true);
  wireSelfHealFetch([]);
});

function lastSyncData(): Record<string, unknown> {
  return dbState.syncStateUpdates.at(-1)?.data ?? {};
}

function wireSuccess(
  prs: ReturnType<typeof readModelPr>[],
  page: {
    truncated?: boolean;
    nextCursor?: string | null;
    stopReason?: GitHubBundledPullRequestsStopReason;
  } = {}
) {
  const client = makeClient(GitHubCredentialKind.Installation);
  mockGetClient.mockResolvedValue({ ok: true, value: client });
  mockQuery.mockImplementation(
    (
      _octokit: unknown,
      _owner: string,
      _repo: string,
      _numbers: number[],
      opts: Record<string, unknown>
    ) => {
      fetchOpts = opts;
      return Promise.resolve({
        status: GitHubProviderResultStatus.Success,
        value: {
          pullRequests: prs,
          truncated: page.truncated ?? false,
          nextCursor: page.nextCursor ?? null,
          ...(page.stopReason ? { stopReason: page.stopReason } : {}),
        },
      });
    }
  );
  return client;
}

/**
 * The self-heal batch is a BY-NUMBER read now, not a stop condition on the
 * window read, so a test that wants a target refreshed supplies it here rather
 * than hiding it in the paged window.
 */
function wireSelfHealFetch(prs: ReturnType<typeof readModelPr>[]) {
  mockByNumberQuery.mockImplementation(
    (
      _octokit: unknown,
      _owner: string,
      _repo: string,
      numbers: number[],
      observer?: (o: unknown) => void
    ) => {
      byNumberRequests.push([...numbers]);
      observer?.({
        page: 0,
        itemCount: prs.length,
        rateLimit: {
          cost: 1,
          remaining: 4990,
          resetAt: "2026-08-03T13:00:00Z",
          state: "available",
        },
      });
      return Promise.resolve({
        status: GitHubProviderResultStatus.Success,
        value: { pullRequests: prs, truncated: false, nextCursor: null },
      });
    }
  );
}

describe("reconcileRepo — read scoping (ISS-7892)", () => {
  it("carries the stored watermark into the window read as a paging stop", async () => {
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(fetchOpts?.stopAtUpdatedAt).toBe(WATERMARK.toISOString());
  });

  it("omits the paging stop while draining, whose pages are older on purpose", async () => {
    wireSuccess([
      readModelPr({ number: 3, updatedAt: "2026-07-10T00:00:00Z" }),
    ]);

    await reconcileRepo({ ...INPUT, cursor: "cursor-page-2" }, { now: NOW });

    expect(fetchOpts?.stopAtUpdatedAt).toBeUndefined();
  });

  it("persists no continuation after a watermark-stopped read, so the next tick rescans from the newest PR", async () => {
    // The read stopped early, so it reports truncated with a cursor. Storing it
    // would resume BELOW the watermark forever; discarding it is also what
    // bounds the keyset race — a PR whose updatedAt moved mid-pagination sorts
    // above the watermark on the next tick's fresh page 1.
    wireSuccess(
      [
        readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
        readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }),
      ],
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().cursor).toBeNull();
  });

  it("asks for no status-check rollup and no target numbers in the window read", async () => {
    dbState.selfHealRows = [{ number: 3 }];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    // The sweep never persists check state, and the self-heal batch is its own
    // read now, so neither may ride the window query.
    expect(fetchOpts?.includeStatusCheckRollup).toBe(false);
    expect(fetchOpts?.targetNumbers).toBeUndefined();
    expect(mockQuery.mock.calls[0][3]).toEqual([]);
  });

  it("self-heals a terminal watermark-old PR that is missing LOC", async () => {
    dbState.selfHealRows = [{ number: 3 }]; // terminal-missing-LOC target
    wireSuccess([]); // the window read no longer carries the target
    wireSelfHealFetch([
      readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    // Written despite being below the watermark because it is a self-heal target.
    expect(byNumberRequests).toEqual([[3]]);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    // The LOC fields are what the self-heal exists to fill, so pin them here
    // rather than only the identity the test is named for.
    expect(mockWrite.mock.calls[0][0]).toMatchObject({
      number: 3,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    });
  });

  it("debounces a self-heal target the by-number read returned nothing for", async () => {
    // ISS-7892 reversed the old expectation deliberately. While the batch rode
    // the window read, an unreturned target had genuinely not been ATTEMPTED, so
    // stamping it would have delayed a real refresh — and leaving it unstamped
    // let it refill the fixed batch every tick forever. A by-number read reaches
    // a target wherever it sits, so an empty answer is a completed attempt.
    //
    // This pins only the reconciler half: given a successful read that did not
    // return the target, stamp it anyway. That a GONE pull request produces such
    // a result — GitHub answers 200 with the other aliases plus an `errors[]`,
    // and octokit throws on it — is pinned at the provider seam, in
    // packages/github/__tests__/pull-requests-by-number.test.ts.
    dbState.selfHealRows = [{ number: 3 }];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);
    wireSelfHealFetch([]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(byNumberRequests).toEqual([[3]]);
    expect(dbState.debounceCalls).toContainEqual(
      expect.objectContaining({ number: { in: [3] } })
    );
  });

  it("does not touch the provider by number when nothing needs self-healing", async () => {
    dbState.selfHealRows = [];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockByNumberQuery).not.toHaveBeenCalled();
    expect(dbState.debounceCalls).toHaveLength(0);
  });

  it("keeps the repo swept and records the failure when only the self-heal read fails", async () => {
    dbState.selfHealRows = [{ number: 3 }];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);
    mockByNumberQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    // The recency read — the sweep's actual job — succeeded, so the repo must
    // not be backed off for a best-effort backfill. Asserted against EVERY
    // sync-state write, not the last one: the swept path's own reset would
    // otherwise hide a backoff bump written moments earlier.
    expect(result.status).toBe(ReconcileRepoStatus.Swept);
    expect(
      dbState.syncStateUpdates.map(
        (update) => update.data.consecutiveFailureCount
      )
    ).not.toContain(1);
    expect(lastSyncData().watermark).toEqual(new Date("2026-08-02T10:00:00Z"));
    expect(mockWriteFailures).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestNumbers: [3] })
    );
    // An unattempted target is NOT stamped: the read never reached it.
    expect(dbState.debounceCalls).toHaveLength(0);
  });

  it("advances the watermark from the window read only, never from a self-heal row", async () => {
    // A self-heal row can sit anywhere in history. Letting it move the recency
    // boundary would claim coverage of every PR between it and the window.
    dbState.selfHealRows = [{ number: 3 }];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);
    wireSelfHealFetch([
      readModelPr({ number: 3, updatedAt: "2026-08-02T23:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().watermark).toEqual(new Date("2026-08-02T10:00:00Z"));
  });

  // whitlockk review. The window and the self-heal both write, and the monotonic
  // guard admits an equal `githubUpdatedAt`, so a target present in BOTH reads
  // was written twice and counted twice with nothing to show for it.
  it("settles a self-heal target the window already returned without reading it again", async () => {
    dbState.selfHealRows = [{ number: 9 }, { number: 41 }];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);
    wireSelfHealFetch([
      readModelPr({ number: 41, updatedAt: "2026-07-01T00:00:00Z" }),
    ]);

    const result = await reconcileRepo(INPUT, { now: NOW });

    // 9 came back on the window page, so the by-number read asks for 41 alone.
    expect(byNumberRequests).toEqual([[41]]);
    // One write each, not two for 9.
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(result.writtenCount).toBe(2);
  });

  it("writes a window-returned self-heal target even when it is older than the watermark", async () => {
    // The whole point of a self-heal is that it is watermark-independent. Now
    // that the window settles these, the window's write has to be too, or
    // excluding it from the by-number read would silently drop it.
    dbState.selfHealRows = [{ number: 7 }];
    wireSuccess([
      readModelPr({ number: 7, updatedAt: "2026-07-01T00:00:00Z" }),
    ]);

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(byNumberRequests).toEqual([]);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(result.writtenCount).toBe(1);
    // Stamped by the window's own settle, so the debounce still reflects every
    // target attempted this tick and not just the by-number half.
    expect(dbState.debounceCalls).toContainEqual(
      expect.objectContaining({ number: { in: [7] } })
    );
  });

  // whitlockk review. A Success can still carry a stop reason meaning the window
  // gave up on purpose. Starting the by-number read on the same Octokit then
  // spends a credential the budget just protected, or retries the request the
  // provider just rate-limited.
  it.each([
    GitHubBundledPullRequestsStopReason.BudgetLow,
    GitHubBundledPullRequestsStopReason.ProviderRateLimit,
  ])(
    "skips the self-heal read when the window stopped on %s",
    async (stopReason) => {
      dbState.selfHealRows = [{ number: 41 }];
      wireSuccess([], { stopReason });

      const result = await reconcileRepo(INPUT, { now: NOW });

      expect(byNumberRequests).toEqual([]);
      // Unstamped: nothing was attempted, so the next tick must retry rather than
      // wait out a debounce window it never earned.
      expect(dbState.debounceCalls).toEqual([]);
      expect(result.writtenCount).toBe(0);
    }
  );

  it("still runs the self-heal read when the window stopped for an ordinary reason", async () => {
    // The counterfactual for the two cases above: without it they would pass on
    // a self-heal that never runs at all.
    dbState.selfHealRows = [{ number: 41 }];
    wireSuccess([], {
      stopReason: GitHubBundledPullRequestsStopReason.WatermarkReached,
    });
    wireSelfHealFetch([
      readModelPr({ number: 41, updatedAt: "2026-07-01T00:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(byNumberRequests).toEqual([[41]]);
  });
});
