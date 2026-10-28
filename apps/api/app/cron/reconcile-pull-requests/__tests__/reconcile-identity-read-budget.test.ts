import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));

vi.mock("@/lib/github/github-repo-sync-state", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/github-repo-sync-state")
  >()),
  classifyRepoSyncTier: vi.fn(),
}));

vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findInstallationRepositoryId: vi.fn(),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/branches/github-projection-writer", () => ({
  buildPullRequestDetailUpdate: vi.fn(() => ({ __detailUpdate: true })),
}));

vi.mock("@/app/branches/pull-request-authority-producer", () => ({
  persistPullRequestProviderFailure: vi.fn(() => Promise.resolve(false)),
}));

vi.mock(
  "@/app/branches/pull-request-head-authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/branches/pull-request-head-authority")
    >()),
    persistPullRequestHeadRepositoryAuthority: vi.fn(() =>
      Promise.resolve(true)
    ),
  })
);

import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "@repo/github";
import {
  INPUT,
  makeClient,
  NOW,
  readModelPr,
} from "@/__tests__/support/cron/reconcile-pull-requests/repo-reconciler.test-fixtures";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import {
  resolveReconcileTargets,
  writeReconciledPullRequest,
} from "../reconcile-projection-write";
import { reconcileRepo } from "../repo-reconciler";

/**
 * ISS-8919: the reconciler's identity read is per-PAGE, not per-PR.
 *
 * This lane used to open a connection and issue a single-row SELECT for every
 * pull request it wrote, so a draining repo paid `RECONCILE_MAX_ITEMS` (200) of
 * each before writing a row.
 *
 * The middle case is the regression guard proper, and it is a SCALING comparison
 * rather than a pinned number: the identity-read count is measured at two page
 * sizes and must not grow with the page. A per-PR read cannot satisfy that at
 * any budget. The cases either side of it do pin numbers — `40` in particular is
 * the current cost of the two writes each row still makes, so read its comment
 * before changing it.
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
const mockFindInstallationRepositoryId =
  findInstallationRepositoryId as unknown as ReturnType<typeof vi.fn>;

// A null watermark makes every fetched PR "fresh", so the whole page is written
// — the shape that made the per-row read expensive.
const DRAINING_INPUT = { ...INPUT, watermark: null };

/**
 * Counts the reads that map PR numbers onto projection rows, split by shape:
 * `findMany` is the batched per-page read, `findUnique`/`findFirst` are the
 * per-PR reads this ticket retired.
 */
function installDbCounters(rowsForNumbers: number[]) {
  const counts = { findMany: 0, perRow: 0, withDbCalls: 0 };
  const client = {
    pullRequestDetail: {
      findMany: (args: { where?: { number?: { in?: number[] } } }) => {
        // Only the identity read carries `number: { in: … }`; the self-heal
        // selection is a different query on the same model.
        if (args?.where?.number?.in) {
          counts.findMany += 1;
          return Promise.resolve(
            args.where.number.in
              .filter((n) => rowsForNumbers.includes(n))
              .map((n) => ({
                id: `detail-${n}`,
                number: n,
                branchArtifact: { branch: { branchName: `feature-${n}` } },
              }))
          );
        }
        return Promise.resolve([]);
      },
      findUnique: () => {
        counts.perRow += 1;
        return Promise.resolve({ id: "detail-1" });
      },
      findFirst: () => {
        counts.perRow += 1;
        return Promise.resolve({ id: "detail-1" });
      },
      updateManyAndReturn: () => Promise.resolve([{ branchArtifactId: null }]),
    },
    // ISS-12034: the coverage-gap arm's raw read. It is ONE read per tick
    // regardless of page size, which is why the flat/delta assertions below
    // are unchanged by it.
    $queryRaw: () => Promise.resolve([]),
    gitHubRepoSyncState: {
      updateMany: () => Promise.resolve({ count: 1 }),
    },
  };
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) => {
    counts.withDbCalls += 1;
    return fn(client);
  });
  mockWithDb.tx.mockImplementation((fn: (db: unknown) => unknown) =>
    fn(client)
  );
  return counts;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindInstallationRepositoryId.mockResolvedValue(null);
  mockGetClient.mockResolvedValue({
    ok: true,
    value: makeClient(GitHubCredentialKind.Installation),
  });
});

async function reconcilePageOf(size: number) {
  const numbers = Array.from({ length: size }, (_, index) => index + 1);
  const counts = installDbCounters(numbers);
  mockQuery.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests: numbers.map((number) =>
        readModelPr({ number, updatedAt: "2026-09-01T00:00:00Z" })
      ),
      truncated: false,
      nextCursor: null,
    },
  });
  const outcome = await reconcileRepo(DRAINING_INPUT, { now: NOW });
  return { counts, outcome };
}

describe("ISS-8919 reconcile identity-read budget", () => {
  it("issues no per-PR identity read when writing a whole page", async () => {
    const { counts, outcome } = await reconcilePageOf(25);

    // Positive controls: the tick really wrote the whole page and really
    // resolved identities, so `perRow: 0` reports a batched read rather than a
    // reconcile that bailed out before reading anything.
    expect(outcome.writtenCount).toBe(25);
    expect(counts.findMany).toBe(1);
    expect(counts.perRow).toBe(0);
  });

  it("keeps the identity read count flat as the page grows", async () => {
    const small = await reconcilePageOf(5);
    const large = await reconcilePageOf(25);

    // Positive control first: both runs wrote their whole page, so a flat read
    // count below cannot be two reconciles that did nothing.
    expect(small.outcome.writtenCount).toBe(5);
    expect(large.outcome.writtenCount).toBe(25);
    // The batched read is issued once per page regardless of its size. A per-PR
    // read makes `large` exceed `small`; this is the assertion that fails when
    // the N+1 comes back.
    expect(large.counts.findMany).toBe(small.counts.findMany);
    expect(large.counts.perRow).toBe(small.counts.perRow);
  });

  it("does not open more connections per additional PR than the writes need", async () => {
    const small = await reconcilePageOf(5);
    const large = await reconcilePageOf(25);

    expect(small.outcome.writtenCount).toBe(5);
    expect(large.outcome.writtenCount).toBe(25);
    // Each written PR still costs its own projection UPDATE and its own head
    // authority write — two checkouts. The identity read must add nothing on
    // top, so 20 more PRs may cost at most 40 more checkouts. With the per-PR
    // read restored the delta is 60, and this upper bound fails. If a future
    // change legitimately adds a third per-row write, SPLIT that cost out
    // rather than raising this to 60 — 60 is exactly the regression value.
    expect(
      large.counts.withDbCalls - small.counts.withDbCalls
    ).toBeLessThanOrEqual(40);
  });
});

describe("resolveReconcileTargets", () => {
  const CONTEXT = {
    organizationId: "org-1",
    repositoryId: null,
    repositoryFullName: "acme/widgets",
  };

  function installRows(rows: { id: string; number: number }[]) {
    const findMany = vi.fn((_args: { where: { number: { in: number[] } } }) =>
      Promise.resolve(
        rows.map((row) => ({
          ...row,
          branchArtifact: { branch: { branchName: "feature-x" } },
        }))
      )
    );
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({ pullRequestDetail: { findMany } })
    );
    return findMany;
  }

  it("reads once and asks for each number only once", async () => {
    const findMany = installRows([{ id: "detail-7", number: 7 }]);

    await resolveReconcileTargets([7, 7, 8, 7], CONTEXT);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ number: { in: [7, 8] } }),
      })
    );
  });

  it("takes the lowest id when a number resolves to more than one row", async () => {
    // The partial unique makes this unreachable for rows written since it
    // landed, but older tier-2 rows predate it, and the refresh lane must pick
    // the same one every tick rather than whichever the database returns first.
    installRows([
      { id: "detail-a", number: 7 },
      { id: "detail-b", number: 7 },
    ]);

    const resolved = await resolveReconcileTargets([7], CONTEXT);

    expect(resolved.get(7)?.id).toBe("detail-a");
  });

  it("omits a number with no tracked row rather than inventing one", async () => {
    installRows([{ id: "detail-7", number: 7 }]);

    const resolved = await resolveReconcileTargets([7, 9], CONTEXT);

    expect(resolved.has(9)).toBe(false);
    expect(resolved.size).toBe(1);
  });

  it("touches no connection when asked for nothing", async () => {
    installRows([]);

    const resolved = await resolveReconcileTargets([], CONTEXT);

    expect(resolved.size).toBe(0);
    expect(mockWithDb).not.toHaveBeenCalled();
  });
});

describe("writeReconciledPullRequest with a supplied identity map", () => {
  it("skips a PR the map does not name, without falling back to a read", async () => {
    // The hazard the `detailTargets` contract warns about: a caller that resolves a
    // partial map silently drops the numbers missing from it. It must skip, not
    // quietly re-read the row per PR — which would reintroduce the N+1.
    const findMany = vi.fn(() => Promise.resolve([]));
    const findUnique = vi.fn();
    const findFirst = vi.fn();
    const updateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        pullRequestDetail: { findMany, findUnique, findFirst, updateMany },
      })
    );

    const wrote = await writeReconciledPullRequest(
      // The shared fixture types `state` as a plain string; every other caller
      // reaches this through a mocked provider, so this is the one typed site.
      readModelPr({
        number: 8,
        updatedAt: "2026-09-01T00:00:00Z",
      }) as GitHubReadModelPullRequest,
      {
        organizationId: "org-1",
        repositoryId: null,
        repositoryFullName: "acme/widgets",
        credentialKind: GitHubCredentialKind.Installation,
        credentialOwnerId: null,
        now: NOW,
        detailTargets: new Map([
          [
            7,
            {
              id: "detail-7",
              filedBranch: null,
              number: 7,
              branchArtifactId: null,
              githubUpdatedAt: null,
            },
          ],
        ]),
      }
    );

    expect(wrote).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
