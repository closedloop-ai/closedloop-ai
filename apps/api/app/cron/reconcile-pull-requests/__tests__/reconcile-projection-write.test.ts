import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
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
    setCurrent: options?.setCurrent,
  })),
}));

vi.mock("@repo/api/src/types/branch", () => ({
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

import { withDb } from "@repo/database";
import { buildPullRequestDetailUpdate } from "@/app/branches/github-projection-writer";
import { writeReconciledPullRequest } from "../reconcile-projection-write";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockBuild = buildPullRequestDetailUpdate as unknown as ReturnType<
  typeof vi.fn
>;

const NOW = new Date("2026-08-03T12:00:00.000Z");
const FETCH_UPDATED_AT = new Date("2026-08-02T00:00:00Z");

let detailRow: { id: string } | null;
const findUnique = vi.fn();
const findFirst = vi.fn();
const updateMany = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  detailRow = null;
  findUnique.mockImplementation(() => Promise.resolve(detailRow));
  findFirst.mockImplementation(() => Promise.resolve(detailRow));
  updateMany.mockImplementation(() => Promise.resolve({ count: 1 }));
  const db = { pullRequestDetail: { findUnique, findFirst, updateMany } };
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
    // App-repo identity: findUnique on the (repositoryId, number) unique.
    expect(findUnique).toHaveBeenCalledWith({
      where: { repositoryId_number: { repositoryId: "repo-1", number: 42 } },
      select: { id: true },
    });
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
        mergedAt: FETCH_UPDATED_AT,
        closedAt: FETCH_UPDATED_AT,
        // M3: the read-model author threads through to the projection row.
        authorLogin: "octocat",
      }),
      { setCurrent: false }
    );
    // Detail-only UPDATE on the resolved row, guarded monotonically. No branch
    // pointer / head / status-check side effects.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "detail-1",
        OR: [
          { githubUpdatedAt: null },
          { githubUpdatedAt: { lte: FETCH_UPDATED_AT } },
        ],
      },
      data: expect.objectContaining({
        __detailUpdate: true,
        setCurrent: false,
      }),
    });
  });

  it("resolves a repo-less tier-2 row by the current partial identity, deterministically", async () => {
    detailRow = { id: "detail-2" };

    const wrote = await writeReconciledPullRequest(pr(), {
      ...CONTEXT,
      repositoryId: null,
    });

    expect(wrote).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        repositoryFullName: "acme/widgets",
        repositoryId: null,
        number: 42,
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
  });

  it("does not resolve a superseded repo-less row by isCurrent (tier-1/tier-2 parity)", async () => {
    detailRow = { id: "detail-2" };

    await writeReconciledPullRequest(pr(), { ...CONTEXT, repositoryId: null });

    // The where clause must NOT filter isCurrent — a superseded (isCurrent=false)
    // merged row still holds LOC the metric needs and this is its only refresh
    // path. The partial-unique already guarantees a single repo-less row.
    const [call] = findFirst.mock.calls;
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
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reports no write when the monotonic guard matches zero rows", async () => {
    detailRow = { id: "detail-1" };
    // A newer webhook already advanced the watermark, so the guarded updateMany
    // no-ops (count 0) — the sweep's write count must not treat that as a write.
    updateMany.mockResolvedValueOnce({ count: 0 });

    const wrote = await writeReconciledPullRequest(pr(), CONTEXT);

    expect(wrote).toBe(false);
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

  it("drops the monotonic guard when the fetched PR has no updatedAt", async () => {
    detailRow = { id: "detail-1" };

    await writeReconciledPullRequest(pr({ updatedAt: null }), CONTEXT);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "detail-1" },
      data: expect.anything(),
    });
  });
});
