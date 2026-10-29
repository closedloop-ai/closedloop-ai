/**
 * ISS-12272 — the installed tier's unverified arm, at the WIRING level: that
 * `reconcileRepo` asks for those rows at all, bounds the ask, folds the rows
 * into the one by-number read, and leaves the tier-2 path alone.
 *
 * WHICH rows the selector returns, and what the write leaves on them, is
 * pinned against real Postgres in
 * `__tests__/integration/iss12272-unverified-pr-placeholder-reconcile.integration.test.ts`.
 */
import { GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES } from "@repo/api/src/github-pull-requests-by-number";
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
vi.mock("../reconcile-projection-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reconcile-projection-write")>()),
  writeReconciledPullRequest: vi.fn().mockResolvedValue(true),
  writeReconciledPullRequestFailures: vi.fn().mockResolvedValue(0),
}));
vi.mock("../targeted-reconciler", () => ({
  TargetedReconcileStatus: { Success: "success", FetchFailed: "fetch_failed" },
  reconcileTargetedSessionLinkedPullRequests: vi.fn(),
}));
vi.mock("../delivery-coverage-metrics", () => ({
  reportGitHubDeliveryCoverageTick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findInstallationRepositoryId: vi.fn(),
}));
vi.mock(
  "@/lib/pull-request-invariant-audit-population",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/pull-request-invariant-audit-population")
      >();
    return {
      ...actual,
      unverifiedOpenPullRequestWhere: vi.fn(
        actual.unverifiedOpenPullRequestWhere
      ),
    };
  }
);

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
  resetReconcileDbState,
} from "@/__tests__/support/cron/reconcile-pull-requests/repo-reconciler.test-fixtures";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import { unverifiedOpenPullRequestWhere } from "@/lib/pull-request-invariant-audit-population";
import {
  RECONCILE_COVERAGE_GAP_BATCH,
  RECONCILE_SELF_HEAL_BATCH,
  RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH,
} from "../constants";
import { reconcileRepo } from "../repo-reconciler";
import {
  reconcileTargetedSessionLinkedPullRequests,
  TargetedReconcileStatus,
} from "../targeted-reconciler";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
const mockGetClient = getGitHubSyncClient as unknown as ReturnType<
  typeof vi.fn
>;
const mockWindow =
  queryBundledPullRequestsWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockByNumber =
  queryPullRequestsByNumberWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockTargeted =
  reconcileTargetedSessionLinkedPullRequests as unknown as ReturnType<
    typeof vi.fn
  >;

beforeEach(() => {
  vi.clearAllMocks();
  resetReconcileDbState();
  vi.mocked(findInstallationRepositoryId).mockResolvedValue("repo-row-1");
  const db = makeDb();
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  mockGetClient.mockResolvedValue({
    ok: true,
    value: makeClient(GitHubCredentialKind.Installation),
  });
  mockWindow.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: { pullRequests: [], truncated: false, nextCursor: null },
  });
  mockByNumber.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: { pullRequests: [] },
  });
});

describe("reconcileRepo — ISS-12272 installed-tier unverified arm", () => {
  it("asks for at most the room the by-number read has left", async () => {
    dbState.unverifiedRows = [{ number: 41 }];

    await reconcileRepo(INPUT, { now: NOW });

    expect(dbState.unverifiedArgs).toMatchObject({
      take: RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH,
    });
    // The read drops numbers past the alias cap and the caller still stamps
    // them, so the three arms together must fit inside it.
    expect(RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH).toBeGreaterThan(0);
    expect(
      RECONCILE_SELF_HEAL_BATCH +
        RECONCILE_COVERAGE_GAP_BATCH +
        RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH
    ).toBeLessThanOrEqual(GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES);
  });

  it("folds unverified, self-heal and gap rows into ONE deduped by-number read", async () => {
    dbState.selfHealRows = [{ number: 41 }];
    dbState.coverageGapRows = [
      { id: "detail-42", branchArtifactId: "branch-42", number: 42 },
    ];
    dbState.unverifiedRows = [{ number: 42 }, { number: 43 }];

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockByNumber).toHaveBeenCalledTimes(1);
    expect(mockByNumber.mock.calls[0]?.[3]).toEqual([41, 42, 43]);
  });

  it("does not point-read when the repo has no unverified row", async () => {
    // The counterfactual for the case above: a healthy repo buys no provider
    // round trip for this arm.
    await reconcileRepo(INPUT, { now: NOW });

    expect(dbState.unverifiedArgs).not.toBeNull();
    expect(mockByNumber).not.toHaveBeenCalled();
  });

  it("does not run the unverified arm on the tier-2 targeted path", async () => {
    dbState.unverifiedRows = [{ number: 41 }];
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.OauthUser),
    });
    mockTargeted.mockResolvedValue({
      status: TargetedReconcileStatus.Success,
      observations: [],
      providerRead: false,
      writtenCount: 0,
      newestUpdatedAt: null,
      targetNumbers: [],
      missingNumbers: [],
    });

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockTargeted).toHaveBeenCalled();
    expect(dbState.unverifiedArgs).toBeNull();
  });

  it("ANDs the shared predicate whole, so an OR it gains survives the debounce OR", async () => {
    // tamsinb review: spread at the top level, the selector's own debounce
    // `OR` overwrote any `OR` the shared predicate declared, widening the
    // population past what the gate owner admits.
    const widened = {
      ...unverifiedOpenPullRequestWhere(),
      OR: [{ number: 41 }, { number: 43 }],
    };
    vi.mocked(unverifiedOpenPullRequestWhere).mockReturnValue(widened);

    await reconcileRepo(INPUT, { now: NOW });

    expect(dbState.unverifiedArgs?.where).toMatchObject({
      AND: expect.arrayContaining([
        widened,
        { OR: expect.arrayContaining([{ lastRefreshAttemptAt: null }]) },
      ]),
    });
  });
});
