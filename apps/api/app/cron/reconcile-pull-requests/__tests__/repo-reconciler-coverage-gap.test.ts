/**
 * ISS-12034 — the installed tier's delivery-coverage GAP arm, at the WIRING
 * level: that `reconcileRepo` selects those rows at all, folds them into the one
 * by-number provider read, stamps their attempt clock, and reports their writes
 * to the monitored tick.
 *
 * Split out of `repo-reconciler.test.ts` rather than added to it — that file sits
 * at the 1,000-line ceiling, and this arm is its own responsibility.
 *
 * WHICH rows the SQL selects is a different question and NOT answered here:
 * `$queryRaw` is a double returning `dbState.coverageGapRows`, so a predicate
 * that selected the wrong rows would still pass this file. That half is pinned
 * against real Postgres in
 * `__tests__/integration/iss12034-delivery-coverage-gap-selector.integration.test.ts`.
 */
import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectionWriteMocks = vi.hoisted(() => ({
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
vi.mock("../reconcile-projection-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reconcile-projection-write")>()),
  writeReconciledPullRequest: projectionWriteMocks.write,
  writeReconciledPullRequestFailures: vi.fn().mockResolvedValue(0),
}));
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
  TargetedReconcileStatus: { Success: "success", FetchFailed: "fetch_failed" },
  reconcileTargetedSessionLinkedPullRequests: vi.fn(),
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
} from "@/__tests__/support/cron/reconcile-pull-requests/repo-reconciler.test-fixtures";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import { reportGitHubDeliveryCoverageTick } from "../delivery-coverage-metrics";
import { writeReconciledPullRequest } from "../reconcile-projection-write";
import { ReconcileRepoStatus } from "../repo-reconcile-status";
import { reconcileRepo } from "../repo-reconciler";
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
const mockByNumber =
  queryPullRequestsByNumberWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockWrite = writeReconciledPullRequest as unknown as ReturnType<
  typeof vi.fn
>;
const mockReportDeliveryCoverageTick =
  reportGitHubDeliveryCoverageTick as unknown as ReturnType<typeof vi.fn>;
const mockTargeted =
  reconcileTargetedSessionLinkedPullRequests as unknown as ReturnType<
    typeof vi.fn
  >;

beforeEach(() => {
  vi.clearAllMocks();
  resetReconcileDbState();
  projectionWriteMocks.write.mockResolvedValue(true);
  projectionWriteMocks.persistHeadAuthority.mockResolvedValue(false);
  (
    findInstallationRepositoryId as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue("repo-row-1");
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

describe("reconcileRepo — ISS-12034 installed-tier delivery-coverage gap arm", () => {
  function wireWindow(prs: ReturnType<typeof readModelPr>[]) {
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.Installation),
    });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: { pullRequests: prs, truncated: false, nextCursor: null },
    });
  }

  it("point-reads a session-linked gap row the window never returns", async () => {
    // The defect in one fixture: PR 41 is session-linked, uncovered, and
    // WATERMARK-OLD, so the window read does not return it. Before this arm the
    // only other path (`selectSelfHealTargets`) could not select it either —
    // it requires `isCurrent`, which the coverage numerator already counts as
    // covered — so nothing on the installed tier could ever reach it.
    dbState.coverageGapRows = [
      { id: "detail-41", branchArtifactId: "branch-41", number: 41 },
    ];
    wireWindow([readModelPr({ number: 9, updatedAt: "2026-08-03T00:00:00Z" })]);
    mockByNumber.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [
          readModelPr({ number: 41, updatedAt: "2026-07-01T00:00:00Z" }),
        ],
      },
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(mockByNumber).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "widgets",
      [41],
      expect.anything(),
      expect.anything()
    );
    // Positive control: the gap row was actually written, not merely requested.
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ number: 41 }),
      expect.anything()
    );
    expect(result.status).toBe(ReconcileRepoStatus.Swept);
  });

  it("does not point-read when the repo has no coverage gap", async () => {
    // The counterfactual for the case above: a healthy repo must not buy a
    // provider round trip per tick for this arm. `coverageGapRows` is empty by
    // default, which is what every other suite in this file describes.
    wireWindow([readModelPr({ number: 9, updatedAt: "2026-08-03T00:00:00Z" })]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockByNumber).not.toHaveBeenCalled();
  });

  it("stamps the gap row's attempt clock so it cannot refill the batch every tick", async () => {
    dbState.coverageGapRows = [
      { id: "detail-41", branchArtifactId: "branch-41", number: 41 },
    ];
    wireWindow([]);
    mockByNumber.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: { pullRequests: [] },
    });

    await reconcileRepo(INPUT, { now: NOW });

    // Stamped even though the provider returned nothing for it — an honest
    // record of an attempt, and the only thing standing between a permanently
    // unresolvable gap row and a point read on every tick forever.
    expect(dbState.debounceCalls).toContainEqual(
      expect.objectContaining({ number: { in: [41] } })
    );
  });

  it("asks for a gap row and a self-heal row in ONE by-number read, deduped", async () => {
    // Both arms can name the same PR. Two reads would cost two round trips and
    // write the row twice; the monotonic write guard admits an equal
    // `githubUpdatedAt`, so the duplicate would be silent.
    dbState.selfHealRows = [{ number: 41 }, { number: 42 }];
    dbState.coverageGapRows = [
      { id: "detail-41", branchArtifactId: "branch-41", number: 41 },
      { id: "detail-43", branchArtifactId: "branch-43", number: 43 },
    ];
    wireWindow([]);
    mockByNumber.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: { pullRequests: [] },
    });

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockByNumber).toHaveBeenCalledTimes(1);
    expect(mockByNumber.mock.calls[0]?.[3]).toEqual([41, 42, 43]);
  });

  it("reports by-number writes in the coverage tick's writtenCount", async () => {
    // The tick used to be handed the WINDOW's writes alone while the outcome
    // returned both, so a tick that wrote only by number told the monitor
    // `writtenCount: 0`. Here the window writes nothing and the gap row writes,
    // which is exactly the shape that misreported.
    dbState.coverageGapRows = [
      { id: "detail-41", branchArtifactId: "branch-41", number: 41 },
    ];
    wireWindow([]);
    mockByNumber.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [
          readModelPr({ number: 41, updatedAt: "2026-07-01T00:00:00Z" }),
        ],
      },
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.writtenCount).toBe(1);
    expect(mockReportDeliveryCoverageTick).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ReconcileRepoStatus.Swept,
        writtenCount: 1,
      })
    );
  });

  it("does not run the gap arm on the tier-2 targeted path", async () => {
    // Tier 2 already enumerates session-linked targets through
    // `reconcileTargetedSessionLinkedPullRequests`. Running this arm there too
    // would double-read the same rows.
    dbState.coverageGapRows = [
      { id: "detail-41", branchArtifactId: "branch-41", number: 41 },
    ];
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.OauthUser),
    });

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockTargeted).toHaveBeenCalled();
    expect(dbState.coverageGapQueries).toEqual([]);
  });
});
