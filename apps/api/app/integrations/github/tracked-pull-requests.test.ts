import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: { BRANCH: "BRANCH" },
}));

import { GitHubPullRequestTrackingScope } from "@repo/api/src/types/github";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import { getTrackedPullRequestState } from "./tracked-pull-requests";

/** A full owned PR-detail row in the shape the canonical resolver consumes. */
function trackedPrDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "detail-42",
    branchArtifactId: "art-1",
    repositoryId: "repo-1",
    repositoryFullName: null,
    repository: { fullName: "acme/repo" },
    number: 42,
    title: "PR 42",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    prState: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: null,
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: null,
    fetchMechanism: "webhook",
    githubId: "gh-42",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    ...overrides,
  };
}

function trackedBranchScalars(overrides: Record<string, unknown> = {}) {
  return {
    branchName: "feature-42",
    currentPullRequestDetailId: "detail-42",
    repositoryId: "repo-1",
    repositoryFullName: null,
    repository: { fullName: "acme/repo" },
    ...overrides,
  };
}

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
let artifacts: unknown[] = [];
type PullRequestFixture = {
  organizationId?: string;
  repositoryId?: string;
  [key: string]: unknown;
};

let pullRequests: PullRequestFixture[] = [];
const pullRequestFindManyMock = vi.fn(
  (query: { where: { organizationId?: string; repositoryId?: string } }) =>
    Promise.resolve(
      pullRequests.filter(
        (row) =>
          (query.where.organizationId === undefined ||
            row.organizationId === undefined ||
            row.organizationId === query.where.organizationId) &&
          (query.where.repositoryId === undefined ||
            row.repositoryId === undefined ||
            row.repositoryId === query.where.repositoryId)
      )
    )
);

beforeEach(() => {
  vi.clearAllMocks();
  artifacts = [];
  pullRequests = [];
  const db = {
    artifact: { findMany: vi.fn(() => Promise.resolve(artifacts)) },
    pullRequestDetail: { findMany: pullRequestFindManyMock },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
});

describe("getTrackedPullRequestState", () => {
  it("returns empty state and skips the DB when there is no projectId", async () => {
    const result = await getTrackedPullRequestState({
      organizationId: "org",
      projectId: null,
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
    });

    expect(result).toEqual({
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [],
      targetDiscoveryTruncated: false,
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("discovers organization-scoped associated PR targets with an org/repo predicate", async () => {
    pullRequests = [
      {
        number: 142,
        htmlUrl: "https://github.com/acme/repo/pull/142",
        branchArtifact: {
          externalUrl: "https://github.com/acme/repo/tree/feature-142",
          branch: { branchName: "feature-142" },
        },
      },
    ];

    const result = await getTrackedPullRequestState({
      organizationId: "org-a",
      projectId: null,
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
      trackingScope: GitHubPullRequestTrackingScope.Organization,
    });

    expect(result.trackedPrNumbers).toEqual([142]);
    expect(result.targetDiscoveryTruncated).toBe(false);
    expect(pullRequestFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-a", repositoryId: "repo-1" },
        orderBy: [
          { githubUpdatedAt: { sort: "desc", nulls: "last" } },
          { number: "desc" },
        ],
        take: 501,
      })
    );
  });

  it("cannot return another organization's PR target", async () => {
    pullRequests = [
      {
        organizationId: "org-a",
        repositoryId: "repo-1",
        number: 142,
        htmlUrl: "https://github.com/acme/repo/pull/142",
        branchArtifact: { externalUrl: null, branch: { branchName: "a" } },
      },
      {
        organizationId: "org-b",
        repositoryId: "repo-1",
        number: 143,
        htmlUrl: "https://github.com/acme/repo/pull/143",
        branchArtifact: { externalUrl: null, branch: { branchName: "b" } },
      },
    ];

    const result = await getTrackedPullRequestState({
      organizationId: "org-a",
      projectId: null,
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
      trackingScope: GitHubPullRequestTrackingScope.Organization,
    });

    expect(result.trackedPrNumbers).toEqual([142]);
  });

  it("reports organization target discovery truncation instead of claiming completeness", async () => {
    pullRequests = Array.from({ length: 501 }, (_, index) => ({
      number: 1000 - index,
      htmlUrl: `https://github.com/acme/repo/pull/${1000 - index}`,
      branchArtifact: {
        externalUrl: null,
        branch: { branchName: `feature-${1000 - index}` },
      },
    }));

    const result = await getTrackedPullRequestState({
      organizationId: "org-a",
      projectId: null,
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
      trackingScope: GitHubPullRequestTrackingScope.Organization,
    });

    expect(result.trackedPrNumbers).toHaveLength(500);
    expect(result.targetDiscoveryTruncated).toBe(true);
  });

  it("matches tracked PR urls whose casing differs from the repository name", async () => {
    // GitHub treats owner/repo as case-insensitive but preserves each
    // producer's casing, so the stored htmlUrl and the repository name can
    // legitimately disagree. A case-sensitive compare drops every target
    // number here, and target discovery going silently empty means already
    // tracked PRs past the first page stop being fetched.
    artifacts = [
      {
        id: "art-1",
        externalUrl: "https://github.com/Acme/Repo/tree/feature-42",
        pullRequestDetails: [
          trackedPrDetail({
            repository: { fullName: "Acme/Repo" },
            htmlUrl: "https://github.com/Acme/Repo/pull/42",
          }),
        ],
        branch: trackedBranchScalars({
          repository: { fullName: "Acme/Repo" },
        }),
      },
    ];

    const result = await getTrackedPullRequestState({
      organizationId: "org",
      projectId: "proj",
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
    });

    expect(result.trackedPrNumbers).toEqual([42]);
  });

  it("derives tracked branches, keys, PR urls, and deduped PR numbers for this repo", async () => {
    artifacts = [
      {
        id: "art-1",
        externalUrl: "https://github.com/acme/repo/tree/feature-42",
        pullRequestDetails: [trackedPrDetail()],
        branch: trackedBranchScalars(),
      },
      {
        id: "art-2",
        externalUrl: "https://github.com/acme/repo/tree/branch-only",
        pullRequestDetails: [],
        branch: trackedBranchScalars({
          branchName: "branch-only",
          currentPullRequestDetailId: null,
        }),
      },
      // A row whose branch relation did not load is skipped, not crashed on.
      { id: "art-3", externalUrl: null, pullRequestDetails: [], branch: null },
    ];

    const result = await getTrackedPullRequestState({
      organizationId: "org",
      projectId: "proj",
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
    });

    expect(result.trackedBranchKeys).toEqual([
      "acme/repo:feature-42",
      "acme/repo:branch-only",
    ]);
    expect(result.trackedPrUrls).toEqual([
      "https://github.com/acme/repo/pull/42",
    ]);
    expect(result.trackedPrNumbers).toEqual([42]);
    expect(result.targetDiscoveryTruncated).toBe(false);
    expect(result.trackedBranches).toContainEqual({
      branchName: "branch-only",
      branchKey: "acme/repo:branch-only",
      htmlUrl: "https://github.com/acme/repo/tree/branch-only",
      pullRequestUrl: null,
    });
  });

  it("serves the owned PR as the tracked URL when the pointer is absent (heal window)", async () => {
    artifacts = [
      {
        id: "art-1",
        externalUrl: "https://github.com/acme/repo/tree/healing",
        pullRequestDetails: [
          trackedPrDetail({
            id: "detail-7",
            number: 7,
            htmlUrl: "https://github.com/acme/repo/pull/7",
            prState: GitHubPRState.Merged,
            mergedAt: new Date("2026-08-01T00:00:00Z"),
            closedAt: new Date("2026-08-01T00:00:00Z"),
          }),
        ],
        branch: trackedBranchScalars({
          branchName: "healing",
          currentPullRequestDetailId: null,
        }),
      },
    ];

    const result = await getTrackedPullRequestState({
      organizationId: "org",
      projectId: "proj",
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
    });

    expect(result.trackedPrUrls).toEqual([
      "https://github.com/acme/repo/pull/7",
    ]);
    expect(result.trackedPrNumbers).toEqual([7]);
  });
});
