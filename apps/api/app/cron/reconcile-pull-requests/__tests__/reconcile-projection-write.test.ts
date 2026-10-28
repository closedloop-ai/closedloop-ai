import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { BranchSignalType } from "@repo/realtime-contract/signals";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-12463: the branch-owner seed is raw SQL this stubbed database does not
// model; its wiring is pinned by the real-Postgres seed-wiring suite.
vi.mock("@/app/branches/branch-owner-seed/branch-owner-seed", () => ({
  seedBranchOwners: vi.fn().mockResolvedValue(0),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/branches/github-projection-writer", () => ({
  buildPullRequestDetailUpdate: vi.fn((input, options) => ({
    __detailUpdate: true,
    prState: input.prState,
    additions: input.additions,
    deletions: input.deletions,
    changedFiles: input.changedFiles,
    githubUpdatedAt: input.githubUpdatedAt,
    headRefOid: input.headRefOid,
    mergedAt: input.mergedAt,
    closedAt: input.closedAt,
    lastVerifiedAt: input.verifiedAt,
    lastRefreshAttemptAt: input.verifiedAt,
    setCurrent: options?.setCurrent,
  })),
}));

vi.mock("@repo/api/src/types/branch", () => ({
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("@/app/branches/pull-request-authority-producer", () => ({
  persistPullRequestProviderFailure: vi.fn(),
}));
vi.mock("@/app/branches/pull-request-author-identity", () => ({
  ensurePullRequestAuthorIdentity: vi.fn(async () => undefined),
}));

vi.mock("@/app/branches/pull-request-github-head-refile", () => ({
  refilePullRequestUnderGitHubHead: vi.fn(async () => false),
}));

vi.mock(
  "@/app/branches/pull-request-head-authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/branches/pull-request-head-authority")
    >()),
    persistPullRequestHeadRepositoryAuthority: vi.fn(),
  })
);

import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { buildPullRequestDetailUpdate } from "@/app/branches/github-projection-writer";
import { ensurePullRequestAuthorIdentity } from "@/app/branches/pull-request-author-identity";
import { persistPullRequestProviderFailure } from "@/app/branches/pull-request-authority-producer";
import { refilePullRequestUnderGitHubHead } from "@/app/branches/pull-request-github-head-refile";
import { persistPullRequestHeadRepositoryAuthority } from "@/app/branches/pull-request-head-authority";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "../reconcile-projection-write";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockBuild = buildPullRequestDetailUpdate as unknown as ReturnType<
  typeof vi.fn
>;
const mockPersistFailure =
  persistPullRequestProviderFailure as unknown as ReturnType<typeof vi.fn>;
const mockPersistHeadAuthority =
  persistPullRequestHeadRepositoryAuthority as unknown as ReturnType<
    typeof vi.fn
  >;

const NOW = new Date("2026-08-03T12:00:00.000Z");
const FETCH_UPDATED_AT = new Date("2026-08-02T00:00:00Z");

/**
 * The filed Branch defaults to the `pr()` head in the PR's own repository, so
 * no ISS-12344 move is due.
 */
let detailRow: {
  id: string;
  filedBranchName?: string;
  filedBranchRepository?: string;
  branchArtifactId?: string;
  githubUpdatedAt?: Date;
} | null;
let failureRows: { id: string; number: number }[];
const findUnique = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();
const updateManyAndReturn = vi.fn();
const executeRaw = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  detailRow = null;
  failureRows = [];
  // Identity, provider watermark, and branch owner share the batched read.
  findFirst.mockResolvedValue(null);
  executeRaw.mockResolvedValue(1);
  findMany.mockImplementation(
    (args: { where?: { number?: { in?: number[] } } }) => {
      if (failureRows.length > 0) {
        return Promise.resolve(
          failureRows.map((failureRow) => filedUnder(failureRow, "feature-x"))
        );
      }
      const row = detailRow;
      const numbers = args?.where?.number?.in ?? [];
      return Promise.resolve(
        row
          ? numbers.map((n) =>
              filedUnder(
                { ...row, number: n },
                row.filedBranchName ?? "feature-x",
                row.filedBranchRepository
              )
            )
          : []
      );
    }
  );
  updateManyAndReturn.mockImplementation(() =>
    Promise.resolve([{ branchArtifactId: detailRow?.branchArtifactId ?? null }])
  );
  mockPersistFailure.mockResolvedValue(true);
  mockPersistHeadAuthority.mockResolvedValue(false);
  const db = {
    pullRequestDetail: { findUnique, findFirst, findMany, updateManyAndReturn },
    $executeRaw: executeRaw,
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
    fn(db)
  );
});

function pr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    githubId: "42",
    number: 42,
    title: "Add X",
    htmlUrl: "https://github.com/acme/widgets/pull/42",
    headBranch: "feature-x",
    baseBranch: "main",
    headSha: "head-abc",
    state: "MERGED",
    isDraft: false,
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-07-01T00:00:00Z",
    closedAt: "2026-08-02T00:00:00Z",
    mergedAt: "2026-08-02T00:00:00Z",
    mergeCommitSha: "merge-sha",
    updatedAt: "2026-08-02T00:00:00Z",
    author: "octocat",
    source: "provider",
    ...overrides,
  } as never;
}

const CONTEXT = {
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryFullName: "acme/widgets",
  credentialKind: GitHubCredentialKind.Installation,
  credentialOwnerId: null,
  now: NOW,
};

describe("writeReconciledPullRequest (detail-only, monotonic)", () => {
  it("refreshes the App-repo row by (repositoryId, number) without promoting it to current", async () => {
    detailRow = { id: "detail-1" };

    const wrote = await writeReconciledPullRequest(pr(), CONTEXT);

    expect(wrote).toBe(true);
    // App-repo identity: the shared batched read, keyed on (repositoryId,
    // number) and org-scoped. ISS-8919 retired the per-PR findUnique.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        repositoryId: "repo-1",
        number: { in: [42] },
      },
      orderBy: { id: "asc" },
      select: IDENTITY_SELECT,
    });
    expect(findUnique).not.toHaveBeenCalled();
    // The metric fields + M1 watermark/head oid feed the detail update, and the
    // reconciler NEVER sets isCurrent (setCurrent: false).
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        prState: "MERGED",
        additions: 120,
        deletions: 30,
        changedFiles: 4,
        githubUpdatedAt: FETCH_UPDATED_AT,
        headRefOid: "head-abc",
        verifiedAt: NOW,
        mergedAt: FETCH_UPDATED_AT,
        closedAt: FETCH_UPDATED_AT,
        // M3: the read-model author threads through to the projection row.
        authorLogin: "octocat",
      }),
      { setCurrent: false }
    );
    // Detail-only UPDATE on the resolved row, guarded monotonically. No branch
    // pointer / head / status-check side effects.
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      select: { branchArtifactId: true },
      where: {
        id: "detail-1",
        organizationId: CONTEXT.organizationId,
        OR: [
          { githubUpdatedAt: null },
          { githubUpdatedAt: { lte: FETCH_UPDATED_AT } },
        ],
      },
      data: expect.objectContaining({
        __detailUpdate: true,
        lastVerifiedAt: NOW,
        lastRefreshAttemptAt: NOW,
        setCurrent: false,
      }),
    });
  });

  it("emits the registered branch signal only for a changed provider revision", async () => {
    detailRow = { id: "detail-1" };
    const organizationId = "0190c6c8-0000-7000-8000-0000000000a1";
    const branchArtifactId = "0190c6c8-0000-7000-8000-0000000000b1";
    detailRow = {
      id: "detail-1",
      branchArtifactId,
      githubUpdatedAt: new Date("2026-08-01T00:00:00Z"),
    };
    await writeReconciledPullRequest(pr(), { ...CONTEXT, organizationId });
    expect(executeRaw).toHaveBeenCalledOnce();
    const payload = JSON.parse(executeRaw.mock.calls[0][2]);
    expect(payload).toMatchObject({
      c: `branches:${organizationId}:${branchArtifactId}`,
      t: BranchSignalType.Updated,
      d: { branchId: branchArtifactId },
    });
    executeRaw.mockClear();
    detailRow = {
      id: "detail-1",
      branchArtifactId,
      githubUpdatedAt: FETCH_UPDATED_AT,
    };
    await writeReconciledPullRequest(pr(), { ...CONTEXT, organizationId });
    expect(executeRaw).not.toHaveBeenCalled();
    updateManyAndReturn.mockResolvedValueOnce([]);
    detailRow = {
      id: "detail-1",
      branchArtifactId,
      githubUpdatedAt: new Date("2026-08-01T00:00:00Z"),
    };
    await writeReconciledPullRequest(pr(), { ...CONTEXT, organizationId });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("notifies the current owner returned by the write after a concurrent relink", async () => {
    const organizationId = "0190c6c8-0000-7000-8000-0000000000a1";
    const oldBranchId = "0190c6c8-0000-7000-8000-0000000000b1";
    const currentBranchId = "0190c6c8-0000-7000-8000-0000000000b2";
    detailRow = {
      id: "detail-1",
      branchArtifactId: oldBranchId,
      githubUpdatedAt: new Date("2026-08-01T00:00:00Z"),
    };
    // The identity read saw A; the guarded write lands on the row now under B.
    updateManyAndReturn.mockResolvedValueOnce([
      { branchArtifactId: currentBranchId },
    ]);
    await writeReconciledPullRequest(pr(), { ...CONTEXT, organizationId });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(JSON.parse(executeRaw.mock.calls[0][2])).toMatchObject({
      c: `branches:${organizationId}:${currentBranchId}`,
      d: { branchId: currentBranchId },
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("persists immutable author evidence and resolves it only after a successful guarded projection write", async () => {
    detailRow = { id: "detail-1" };
    const observed = pr({
      authorProviderUserId: "123",
      authorActorType: GitHubActorType.User,
    });
    expect(await writeReconciledPullRequest(observed, CONTEXT)).toBe(true);
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      }),
      { setCurrent: false }
    );
    expect(ensurePullRequestAuthorIdentity).toHaveBeenCalledWith(
      expect.any(Object),
      {
        organizationId: CONTEXT.organizationId,
        githubId: "42",
        authorLogin: "octocat",
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      }
    );
    vi.mocked(ensurePullRequestAuthorIdentity).mockClear();
    updateManyAndReturn.mockResolvedValueOnce([]);
    expect(await writeReconciledPullRequest(observed, CONTEXT)).toBe(false);
    expect(ensurePullRequestAuthorIdentity).not.toHaveBeenCalled();
  });

  it("passes explicit ghost author clears to the shared projection builder", async () => {
    detailRow = { id: "detail-1" };

    expect(
      await writeReconciledPullRequest(
        pr({
          author: null,
          authorProviderUserId: null,
          authorActorType: null,
        }),
        CONTEXT
      )
    ).toBe(true);

    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        authorLogin: null,
        authorProviderUserId: null,
        authorActorType: null,
      }),
      { setCurrent: false }
    );
  });

  it("resolves a repo-less tier-2 row by the current partial identity, deterministically", async () => {
    detailRow = { id: "detail-2" };

    const wrote = await writeReconciledPullRequest(pr(), {
      ...CONTEXT,
      repositoryId: null,
    });

    expect(wrote).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        repositoryFullName: "acme/widgets",
        repositoryId: null,
        number: { in: [42] },
      },
      orderBy: { id: "asc" },
      select: IDENTITY_SELECT,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("preserves an interactive targeted refresh trigger in fetch provenance", async () => {
    detailRow = { id: "detail-2" };

    await writeReconciledPullRequest(pr(), {
      ...CONTEXT,
      repositoryId: null,
      fetchTrigger: GitHubFetchTrigger.SurfaceOpen,
    });

    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchProvenance: expect.objectContaining({
          trigger: GitHubFetchTrigger.SurfaceOpen,
        }),
      }),
      { setCurrent: false }
    );
  });

  it("does not resolve a superseded repo-less row by isCurrent (tier-1/tier-2 parity)", async () => {
    detailRow = { id: "detail-2" };

    await writeReconciledPullRequest(pr(), { ...CONTEXT, repositoryId: null });

    // The where clause must NOT filter isCurrent — a superseded (isCurrent=false)
    // merged row still holds LOC the metric needs and this is its only refresh
    // path. The partial-unique already guarantees a single repo-less row.
    const [call] = findMany.mock.calls;
    expect(call[0].where).not.toHaveProperty("isCurrent");
  });

  it("omits null LOC so a fetch without counts cannot wipe stored values", async () => {
    detailRow = { id: "detail-1" };

    await writeReconciledPullRequest(
      pr({ additions: null, deletions: null, changedFiles: null }),
      CONTEXT
    );

    const [input] = mockBuild.mock.calls[0];
    expect(input.additions).toBeUndefined();
    expect(input.deletions).toBeUndefined();
    expect(input.changedFiles).toBeUndefined();
  });

  it("skips a PR that maps to no tracked row (no write)", async () => {
    detailRow = null;

    const wrote = await writeReconciledPullRequest(pr(), CONTEXT);

    expect(wrote).toBe(false);
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("skips a repo-less tier-2 PR that maps to no existing row", async () => {
    detailRow = null;

    const wrote = await writeReconciledPullRequest(pr(), {
      ...CONTEXT,
      repositoryId: null,
    });

    expect(wrote).toBe(false);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        repositoryFullName: "acme/widgets",
        repositoryId: null,
        number: { in: [42] },
      },
      orderBy: { id: "asc" },
      select: IDENTITY_SELECT,
    });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("reports no write when the monotonic guard matches zero rows", async () => {
    detailRow = { id: "detail-1" };
    // A newer webhook already advanced the watermark, so the guarded updateManyAndReturn
    // no-ops (count 0) — the sweep's write count must not treat that as a write.
    updateManyAndReturn.mockResolvedValueOnce([]);

    const wrote = await writeReconciledPullRequest(pr(), CONTEXT);

    expect(wrote).toBe(false);
    expect(mockPersistHeadAuthority).not.toHaveBeenCalled();
  });

  it("keeps a successful projection write when head-authority persistence rejects", async () => {
    detailRow = { id: "detail-1" };
    mockPersistHeadAuthority.mockRejectedValueOnce(
      new Error("authority compare-and-swap timed out")
    );

    const wrote = await writeReconciledPullRequest(pr(), CONTEXT);

    expect(wrote).toBe(true);
    expect(updateManyAndReturn).toHaveBeenCalledOnce();
    expect(mockPersistHeadAuthority).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      "reconcile_pull_request_head_authority_write_failed",
      {
        organizationId: "org-1",
        repositoryFullName: "acme/widgets",
        pullRequestDetailId: "detail-1",
        pullRequestNumber: 42,
        error: "authority compare-and-swap timed out",
      }
    );
  });

  it("clears mergedAt/closedAt for an open PR (state must not lie)", async () => {
    detailRow = { id: "detail-1" };

    await writeReconciledPullRequest(
      pr({ state: "OPEN", mergedAt: null, closedAt: null }),
      CONTEXT
    );

    const [input] = mockBuild.mock.calls[0];
    expect(input.mergedAt).toBeNull();
    expect(input.closedAt).toBeNull();
  });

  it("re-files the PR when the read reports a head other than its filed Branch (ISS-12344)", async () => {
    detailRow = { id: "detail-1", filedBranchName: "feature-desktop-guess" };
    const fetched = pr(SAME_REPOSITORY_HEAD);

    await writeReconciledPullRequest(fetched, CONTEXT);

    expect(refilePullRequestUnderGitHubHead).toHaveBeenCalledTimes(1);
    expect(refilePullRequestUnderGitHubHead).toHaveBeenCalledWith(
      "org-1",
      "detail-1",
      fetched
    );
  });

  it("asks for no move when the PR is already filed under the head this read reports", async () => {
    detailRow = { id: "detail-1", filedBranchName: "feature-x" };

    await writeReconciledPullRequest(pr(SAME_REPOSITORY_HEAD), CONTEXT);

    expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(refilePullRequestUnderGitHubHead).not.toHaveBeenCalled();
  });

  // ISS-12344 review (PR #8704): a same-named Branch of another repository is
  // not this PR's head Branch, so the name match alone must not skip the move.
  it("re-files a PR filed under a same-named Branch of another repository", async () => {
    detailRow = {
      id: "detail-1",
      filedBranchName: "feature-x",
      filedBranchRepository: "acme/other-repo",
    };
    const fetched = pr(SAME_REPOSITORY_HEAD);

    await writeReconciledPullRequest(fetched, CONTEXT);

    expect(refilePullRequestUnderGitHubHead).toHaveBeenCalledWith(
      "org-1",
      "detail-1",
      fetched
    );
  });

  it("asks for no move when the monotonic guard skipped this read as stale", async () => {
    detailRow = { id: "detail-1", filedBranchName: "feature-desktop-guess" };
    updateManyAndReturn.mockResolvedValue([]);

    await writeReconciledPullRequest(pr(SAME_REPOSITORY_HEAD), CONTEXT);

    expect(refilePullRequestUnderGitHubHead).not.toHaveBeenCalled();
  });

  it("drops the monotonic guard when the fetched PR has no updatedAt", async () => {
    detailRow = { id: "detail-1" };

    await writeReconciledPullRequest(pr({ updatedAt: null }), CONTEXT);

    expect(updateManyAndReturn).toHaveBeenCalledWith({
      select: { branchArtifactId: true },
      where: { id: "detail-1", organizationId: CONTEXT.organizationId },
      data: expect.anything(),
    });
  });
});

const FAILURE_INPUT = {
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryFullName: "acme/widgets",
  pullRequestNumbers: [1, 2, 3],
  result: { status: "provider_repo_forbidden" },
  provenance: { observationKey: "obs-1" },
} as unknown as Parameters<typeof writeReconciledPullRequestFailures>[0];

describe("writeReconciledPullRequestFailures (per-row write boundaries)", () => {
  it("batches the read but writes each row on its own boundary, never one transaction", async () => {
    failureRows = [
      { id: "detail-1", number: 1 },
      { id: "detail-2", number: 2 },
      { id: "detail-3", number: 3 },
    ];

    const written = await writeReconciledPullRequestFailures(FAILURE_INPUT);

    expect(written).toBe(3);
    // The read stays ONE batched query however many numbers the caller passes.
    expect(findMany).toHaveBeenCalledTimes(1);
    // ISS-8919: the refresh lane batched its own per-PR identity lookup onto
    // this same read, so both lanes now share one query — hence the stable
    // `id ASC` order and the `number` the refresh lane keys its map by.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        number: { in: [1, 2, 3] },
        repositoryId: "repo-1",
      },
      orderBy: { id: "asc" },
      select: IDENTITY_SELECT,
    });
    // ISS-6604: each compare-and-swap write gets its own short boundary, so a
    // slow or contended row cannot exhaust one shared 5s transaction budget and
    // roll the whole batch back.
    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(mockWithDb).toHaveBeenCalledTimes(4);
    expect(mockPersistFailure).toHaveBeenCalledTimes(3);
    expect(mockPersistFailure.mock.calls.map((call) => call[1])).toEqual([
      { organizationId: "org-1", pullRequestDetailId: "detail-1" },
      { organizationId: "org-1", pullRequestDetailId: "detail-2" },
      { organizationId: "org-1", pullRequestDetailId: "detail-3" },
    ]);
  });

  it("isolates a failed row instead of rolling back or abandoning the batch", async () => {
    failureRows = [
      { id: "detail-1", number: 1 },
      { id: "detail-2", number: 2 },
      { id: "detail-3", number: 3 },
    ];
    mockPersistFailure
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("compare-and-swap exhausted"))
      .mockResolvedValueOnce(true);

    const written = await writeReconciledPullRequestFailures(FAILURE_INPUT);

    // The rows before the failure committed on their own boundaries (nothing
    // rolls them back) AND the rows behind it still got their observation, so
    // one contended row cannot starve the tail of the batch next tick.
    expect(written).toBe(2);
    expect(mockPersistFailure).toHaveBeenCalledTimes(3);
    expect(mockPersistFailure.mock.calls.map((call) => call[1])).toEqual([
      { organizationId: "org-1", pullRequestDetailId: "detail-1" },
      { organizationId: "org-1", pullRequestDetailId: "detail-2" },
      { organizationId: "org-1", pullRequestDetailId: "detail-3" },
    ]);
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("counts only the rows the persister reports as written", async () => {
    failureRows = [
      { id: "detail-1", number: 1 },
      { id: "detail-2", number: 2 },
    ];
    mockPersistFailure.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await writeReconciledPullRequestFailures(FAILURE_INPUT)).toBe(1);
  });

  it("scopes repo-less tier-2 targets by normalized full name", async () => {
    failureRows = [];

    await writeReconciledPullRequestFailures({
      ...FAILURE_INPUT,
      repositoryId: null,
      repositoryFullName: " ACME/Widgets ",
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        number: { in: [1, 2, 3] },
        repositoryId: null,
        repositoryFullName: "acme/widgets",
      },
      orderBy: { id: "asc" },
      select: IDENTITY_SELECT,
    });
  });

  it("short-circuits without touching the database when there are no targets", async () => {
    expect(
      await writeReconciledPullRequestFailures({
        ...FAILURE_INPUT,
        pullRequestNumbers: [],
      })
    ).toBe(0);
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

/** The batched identity read's select, which carries the filed Branch. */
const IDENTITY_SELECT = {
  id: true,
  number: true,
  branchArtifactId: true,
  githubUpdatedAt: true,
  branchArtifact: {
    select: {
      branch: { select: { branchName: true, repositoryFullName: true } },
    },
  },
};

function filedUnder(
  row: { id: string; number: number },
  branchName: string,
  repositoryFullName = CONTEXT.repositoryFullName
) {
  return {
    ...row,
    branchArtifact: { branch: { branchName, repositoryFullName } },
  };
}

/** A read whose head GitHub reports in the PR's own repository. */
const SAME_REPOSITORY_HEAD = {
  headRepository: { repository: { fullName: "acme/widgets" } },
};
