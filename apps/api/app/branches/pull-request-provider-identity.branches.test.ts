import { LinkType } from "@repo/api/src/types/artifact";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { describe, expect, it, vi } from "vitest";
import { reconcilePullRequestProviderIdentityInTransaction } from "./pull-request-provider-identity";

const ORGANIZATION_ID = "019ff900-3000-7000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "019ff900-3000-7000-8000-000000000002";
const ROW_A = "019ff900-3000-7000-8000-000000000010";
const ROW_B = "019ff900-3000-7000-8000-000000000020";
const BRANCH_A = "019ff900-3000-7000-8000-000000000030";
const BRANCH_B = "019ff900-3000-7000-8000-000000000040";
const FOREIGN_ROW = "019ff900-3000-7000-8000-000000000050";
const FOREIGN_BRANCH = "019ff900-3000-7000-8000-000000000060";

describe("pull request provider identity convergence (branch pins)", () => {
  it("reads candidate rows scoped to the organization and number across all three identity arms", async () => {
    const tx = createClient([]);

    await reconcilePullRequestProviderIdentityInTransaction(
      tx as never,
      input()
    );

    // The third arm compares the stored full name by raw equality against the
    // NORMALIZED input, which is why a lowercase stored name matches the
    // mixed-case `.git` input below.
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        number: 6980,
        OR: [
          { githubId: "github-pr-6980" },
          { repositoryId: "repository-1" },
          {
            repositoryId: null,
            repositoryFullName: "closedloop-ai/closedloop-ai",
          },
        ],
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        branchArtifactId: true,
        githubId: true,
        repositoryId: true,
        repositoryFullName: true,
        number: true,
      },
    });
  });

  it("neither adopts nor collapses another organization's row carrying the same PR coordinates", async () => {
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: FOREIGN_ROW,
        organizationId: OTHER_ORGANIZATION_ID,
        branchArtifactId: FOREIGN_BRANCH,
        githubId: "github-pr-6980",
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(ROW_A);

    expect(tx.pullRequestDetail.deleteMany).not.toHaveBeenCalled();
    expect(tx.branchActivityAtom.updateMany).not.toHaveBeenCalled();
  });

  it("throws when the canonical row's identity changed before the adoption write lands", async () => {
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).rejects.toThrow("provider identity changed during adoption");
  });

  it("ranks a repository-only row above a GitHub-only row when tie-breaking canonical authority", async () => {
    // ISS-6980: two independently-observed rows for the same PR, neither
    // conflicting with the caller's expected coordinates. The repository-owned
    // row (rank 1) outranks the GitHub-only row (rank 2), so it is adopted as
    // canonical and the GitHub-only row is collapsed into it.
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: null,
        repositoryFullName: null,
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(
        tx as never,
        input({ repositoryId: "repository-1" })
      )
    ).resolves.toBe(ROW_A);

    expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: ROW_A,
        organizationId: ORGANIZATION_ID,
        number: 6980,
        repositoryId: "repository-1",
        githubId: null,
      },
      data: {
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        githubId: "github-pr-6980",
      },
    });
    expect(tx.pullRequestDetail.deleteMany).toHaveBeenCalledWith({
      where: { id: ROW_B, organizationId: ORGANIZATION_ID },
    });
  });

  it("tie-breaks two repository-only rows by id", async () => {
    // Both rows carry only repositoryId (rank 1 each), so compareProviderAuthority
    // falls through to the lexicographic id tie-break. The fake serves rows in
    // fixture order, id-descending here; the real query's ORDER BY id ASC would
    // hand them over already sorted, so this pins the comparator's own
    // tie-break rather than a state the database produces.
    const tx = createClient([
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_A,
        branchArtifactId: BRANCH_B,
        githubId: null,
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(
        tx as never,
        input({ repositoryId: "repository-1" })
      )
    ).resolves.toBe(ROW_A);
    expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: ROW_A,
        organizationId: ORGANIZATION_ID,
        number: 6980,
        repositoryId: "repository-1",
        githubId: null,
      },
      data: {
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        githubId: "github-pr-6980",
      },
    });
  });

  it("treats a null stored repositoryFullName as compatible with any expected repository", async () => {
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: null,
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(ROW_A);
    expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: ROW_A,
        organizationId: ORGANIZATION_ID,
        number: 6980,
        repositoryId: "repository-1",
        githubId: "github-pr-6980",
      },
      data: {
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        githubId: "github-pr-6980",
      },
    });
  });

  it("collapses a duplicate that owns a different Branch, carrying its session links along", async () => {
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_B,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(ROW_A);

    // The session-link relink discovery must be scoped to BOTH branches
    // (source BRANCH_B and target BRANCH_A) — this is the arm that flips
    // when `duplicate.branchArtifactId === canonical.branchArtifactId ?
    // [] : [duplicate.branchArtifactId]` is inverted.
    expect(tx.artifactLink.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        linkType: LinkType.RelatesTo,
        targetId: { in: [BRANCH_B, BRANCH_A] },
      },
      select: { id: true, sourceId: true, targetId: true, metadata: true },
    });
    expect(tx.commentThread.updateMany).not.toHaveBeenCalled();
  });

  it("throws when the duplicate row changes before its convergence delete lands", async () => {
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.pullRequestDetail.deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).rejects.toThrow("pull request duplicate changed during convergence");
  });

  it("silently converges an identical review present on both canonical and duplicate rows", async () => {
    const review = {
      id: "review-canonical",
      githubReviewId: "6980001",
      authorLogin: "reviewer",
      state: ReviewDecision.Approved,
      body: null,
      htmlUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/6980#review",
      submittedAt: new Date("2026-08-17T20:00:00.000Z"),
    };
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.gitHubPRReview.findMany
      .mockResolvedValueOnce([review])
      .mockResolvedValueOnce([{ ...review, id: "review-duplicate" }]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBe(ROW_A);

    expect(tx.gitHubPRReview.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "review-duplicate",
        pullRequestDetail: { organizationId: ORGANIZATION_ID },
      },
    });
    expect(tx.gitHubPRReview.updateMany).not.toHaveBeenCalled();
  });

  it("returns null when no row anywhere matches the requested provider identity", async () => {
    const tx = createClient([]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).resolves.toBeNull();
    expect(tx.pullRequestDetail.updateMany).not.toHaveBeenCalled();
  });

  it("throws when an identical review's delete changes before it lands", async () => {
    const review = {
      id: "review-canonical",
      githubReviewId: "6980001",
      authorLogin: "reviewer",
      state: ReviewDecision.Approved,
      body: null,
      htmlUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/6980#review",
      submittedAt: new Date("2026-08-17T20:00:00.000Z"),
    };
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.gitHubPRReview.findMany
      .mockResolvedValueOnce([review])
      .mockResolvedValueOnce([{ ...review, id: "review-duplicate" }]);
    tx.gitHubPRReview.deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).rejects.toThrow("pull request review changed during convergence");
  });

  it("throws on a same-author review whose fields disagree between canonical and duplicate", async () => {
    const base = {
      githubReviewId: "6980001",
      authorLogin: "reviewer",
      state: ReviewDecision.Approved,
      body: null,
      htmlUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/6980#review",
      submittedAt: new Date("2026-08-17T20:00:00.000Z"),
    };
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.gitHubPRReview.findMany
      .mockResolvedValueOnce([{ ...base, id: "review-canonical" }])
      .mockResolvedValueOnce([
        {
          ...base,
          id: "review-duplicate",
          state: ReviewDecision.ChangesRequested,
        },
      ]);

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).rejects.toThrow("pull request review convergence conflict");
  });

  it("throws when a moved review changes before its own convergence update lands", async () => {
    const tx = createClient([
      {
        id: ROW_A,
        branchArtifactId: BRANCH_A,
        githubId: "github-pr-6980",
        repositoryId: "repository-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
      {
        id: ROW_B,
        branchArtifactId: BRANCH_A,
        githubId: null,
        repositoryId: null,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        number: 6980,
      },
    ]);
    tx.gitHubPRReview.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "review-1",
        githubReviewId: "6980001",
        authorLogin: "reviewer",
        state: ReviewDecision.Approved,
        body: null,
        htmlUrl:
          "https://github.com/closedloop-ai/closedloop-ai/pull/6980#review",
        submittedAt: new Date("2026-08-17T20:00:00.000Z"),
      },
    ]);
    tx.gitHubPRReview.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(tx as never, input())
    ).rejects.toThrow("pull request review changed during convergence");
  });
});

function input(overrides: Partial<ReturnType<typeof baseInput>> = {}) {
  return { ...baseInput(), ...overrides };
}

function baseInput() {
  return {
    organizationId: ORGANIZATION_ID,
    repositoryId: "repository-1",
    repositoryFullName: "ClosedLoop-AI/ClosedLoop-AI.git",
    githubId: "github-pr-6980",
    number: 6980,
  };
}

function createClient(rows: readonly FixtureRow[]) {
  const stored = rows.map((row) => ({
    organizationId: ORGANIZATION_ID,
    ...row,
  }));
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    pullRequestDetail: {
      findMany: vi.fn(({ where, select }: FindManyArgs) =>
        Promise.resolve(
          stored
            .filter((row) => matchesWhere(row, where))
            .map((row) => projectSelect(row, select))
        )
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchActivityAtom: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    branchDetail: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    commentThread: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    gitHubCommentProjection: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubCommentThreadProjection: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    gitHubPRReview: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    artifactLink: {
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  };
}

type FixtureRow = {
  id: string;
  organizationId?: string;
  branchArtifactId: string;
  githubId: string | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  number: number;
};

type WhereShape = Record<string, unknown>;

type FindManyArgs = { where: WhereShape; select: Record<string, boolean> };

/**
 * Prisma equality semantics over the `where` the service built: every present
 * key must equal the row's value (`null` means IS NULL), an `OR` needs one
 * matching arm, and an absent key constrains nothing. Any operator object is
 * unmodelled and fails loudly instead of matching.
 */
function matchesWhere(
  row: Record<string, unknown>,
  where: WhereShape
): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") {
      return (value as WhereShape[]).some((arm) => matchesWhere(row, arm));
    }
    if (value !== null && typeof value === "object") {
      throw new Error(`provider identity fake: unmodelled operator on ${key}`);
    }
    return row[key] === value;
  });
}

function projectSelect(
  row: Record<string, unknown>,
  select: Record<string, boolean>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]])
  );
}
