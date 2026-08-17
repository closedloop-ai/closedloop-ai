import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  // The source resolves the repo with installation.status = ACTIVE.
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
}));

const getTrackedMock = vi.hoisted(() => vi.fn());
vi.mock("./tracked-pull-requests", () => ({
  getTrackedPullRequestState: getTrackedMock,
}));

import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  readRepositoryPullRequestsFromProjection,
  serveRepositoryPullRequestsFromProjection,
} from "./projection-read";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

const prFindMany = vi.fn();
const repoFindFirst = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    pullRequestDetail: { findMany: prFindMany },
    gitHubInstallationRepository: { findFirst: repoFindFirst },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
});

const ORG = "org-1";
const REPO = "repo-1";

function prRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pr-detail-1",
    githubId: "100",
    number: 7,
    title: "Add X",
    htmlUrl: "https://github.com/acme/widgets/pull/7",
    prState: GitHubPRState.Merged,
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    closedAt: new Date("2026-02-11T09:00:00Z"),
    mergedAt: new Date("2026-02-11T09:00:00Z"),
    mergeCommitSha: "merge-sha",
    githubUpdatedAt: new Date("2026-02-11T09:00:00Z"),
    headRefOid: "head-oid",
    headRepositoryGithubId: null,
    headRepositoryFullName: null,
    headRepositoryDefaultBranchName: null,
    headRepositoryDefaultBranchAvailability: null,
    headRepositoryDefaultBranchCompleteness: null,
    headRepositoryDefaultBranchReason: null,
    headRepositoryDefaultBranchSource: null,
    headRepositoryDefaultBranchMechanism: null,
    headRepositoryDefaultBranchTrigger: null,
    headRepositoryDefaultBranchCredentialType: null,
    headRepositoryDefaultBranchCredentialOwnerId: null,
    headRepositoryDefaultBranchObservationKey: null,
    headRepositoryDefaultBranchObservedAt: null,
    headRepositoryDefaultBranchEventAt: null,
    authorLogin: "octocat",
    reviewDecision: ReviewDecision.Approved,
    branchArtifact: {
      branch: {
        branchName: "feature-x",
        baseBranch: "main",
        checksStatus: ChecksStatus.Passing,
        currentPullRequestDetailId: "pr-detail-1",
      },
    },
    ...overrides,
  };
}

describe("readRepositoryPullRequestsFromProjection", () => {
  it("maps a projected PR to the live summary shape", async () => {
    prFindMany.mockResolvedValue([prRow()]);

    const result = await readRepositoryPullRequestsFromProjection(REPO, ORG, {
      limit: 30,
      targetNumbers: [],
    });

    expect(result.pullRequests).toEqual([
      {
        githubId: "100",
        number: 7,
        title: "Add X",
        htmlUrl: "https://github.com/acme/widgets/pull/7",
        headBranch: "feature-x",
        baseBranch: "main",
        headSha: "head-oid",
        state: GitHubPRState.Merged,
        isDraft: false,
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        closedAt: "2026-02-11T09:00:00.000Z",
        mergedAt: "2026-02-11T09:00:00.000Z",
        mergeCommitSha: "merge-sha",
        updatedAt: "2026-02-11T09:00:00.000Z",
        author: "octocat",
        checksStatus: ChecksStatus.Passing,
        reviewDecision: ReviewDecision.Approved,
      },
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("excludes rows with no htmlUrl/githubId instead of manufacturing an empty identity", async () => {
    prFindMany.mockResolvedValue([prRow()]);

    await readRepositoryPullRequestsFromProjection(REPO, ORG, {
      limit: 30,
      targetNumbers: [],
    });

    // The query filters unidentifiable rows out; the read never coalesces a null
    // htmlUrl/githubId into an empty-string key that collides and links nothing.
    expect(prFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          githubId: { not: null },
          htmlUrl: { not: null },
        }),
      })
    );
  });

  it("coalesces a missing author to 'unknown' and a null watermark to ''", async () => {
    prFindMany.mockResolvedValue([
      prRow({ authorLogin: null, githubUpdatedAt: null }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.author).toBe("unknown");
    expect(pr.updatedAt).toBe("");
  });

  it("reports checksStatus only for the branch's current PR", async () => {
    prFindMany.mockResolvedValue([
      prRow({
        id: "pr-detail-1",
        branchArtifact: {
          branch: {
            branchName: "feature-x",
            baseBranch: "main",
            checksStatus: ChecksStatus.Passing,
            // Branch's current PR is a DIFFERENT row — this PR is superseded.
            currentPullRequestDetailId: "pr-detail-2",
          },
        },
      }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.checksStatus).toBeNull();
  });

  it("projects complete fork-head authority with a custom default", async () => {
    prFindMany.mockResolvedValue([
      prRow({
        headRepositoryGithubId: "5826",
        headRepositoryFullName: "fork-owner/widgets",
        headRepositoryDefaultBranchName: "trunk",
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Available,
        headRepositoryDefaultBranchCompleteness:
          RepositoryDefaultCompleteness.Complete,
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestGraphql,
        headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Graphql,
        headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
        headRepositoryDefaultBranchCredentialType:
          GitHubFetchCredentialType.GitHubApp,
        headRepositoryDefaultBranchObservationKey: "graphql-page-1",
        headRepositoryDefaultBranchObservedAt: new Date("2026-02-11T09:01:00Z"),
      }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.headRepository).toEqual({
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "5826",
        fullName: "fork-owner/widgets",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: "trunk",
      },
      provenance: expect.objectContaining({
        source: RepositoryDefaultSource.PullRequestGraphql,
        observationKey: "graphql-page-1",
        observedAt: "2026-02-11T09:01:00.000Z",
      }),
    });
    expect(pr).not.toHaveProperty("headRepositoryUnavailable");
  });

  it("retains distinct future fork-head source identities with the same key", async () => {
    const futureRow = (
      id: string,
      number: number,
      source: string,
      observedAt: string
    ) =>
      prRow({
        id,
        number,
        headRepositoryGithubId: "5826",
        headRepositoryFullName: "fork-owner/widgets",
        headRepositoryDefaultBranchName: "not-trusted",
        headRepositoryDefaultBranchAvailability: "future_availability",
        headRepositoryDefaultBranchCompleteness: "future_completeness",
        headRepositoryDefaultBranchReason: "future_reason",
        headRepositoryDefaultBranchSource: source,
        headRepositoryDefaultBranchMechanism: "future_mechanism",
        headRepositoryDefaultBranchTrigger: "future_trigger",
        headRepositoryDefaultBranchCredentialType: "future_credential",
        headRepositoryDefaultBranchObservationKey: "shared-future-key",
        headRepositoryDefaultBranchObservedAt: new Date(observedAt),
      });
    prFindMany.mockResolvedValue([
      futureRow("future-a", 8, "future_source_a", "2026-02-11T09:04:00Z"),
      futureRow("future-b", 9, "future_source_b", "2026-02-11T09:05:00Z"),
    ]);

    const result = await readRepositoryPullRequestsFromProjection(REPO, ORG, {
      limit: 30,
      targetNumbers: [],
    });

    expect(
      result.pullRequests.map(
        (pullRequest) => pullRequest.headRepository?.provenance
      )
    ).toEqual([
      expect.objectContaining({
        source: RepositoryDefaultSource.Unknown,
        sourceIdentity: "future_source_a",
        observationKey: "shared-future-key",
      }),
      expect.objectContaining({
        source: RepositoryDefaultSource.Unknown,
        sourceIdentity: "future_source_b",
        observationKey: "shared-future-key",
      }),
    ]);
  });

  it("projects typed unavailable fork-head evidence without base fallback", async () => {
    prFindMany.mockResolvedValue([
      prRow({
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Unavailable,
        headRepositoryDefaultBranchCompleteness:
          RepositoryDefaultCompleteness.Unavailable,
        headRepositoryDefaultBranchReason:
          RepositoryDefaultReason.PermissionFiltered,
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestGraphql,
        headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Graphql,
        headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
        headRepositoryDefaultBranchCredentialType:
          GitHubFetchCredentialType.GitHubApp,
        headRepositoryDefaultBranchObservationKey: "inaccessible-head-1",
        headRepositoryDefaultBranchObservedAt: new Date("2026-02-11T09:02:00Z"),
      }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr).not.toHaveProperty("headRepository");
    expect(pr.headRepositoryUnavailable).toEqual({
      reason: RepositoryDefaultReason.PermissionFiltered,
      provenance: expect.objectContaining({
        observationKey: "inaccessible-head-1",
      }),
    });
    expect(pr.headRepositoryUnavailable).not.toHaveProperty("repository");
  });

  it("omits provenance-less persisted fork-head groups", async () => {
    prFindMany.mockResolvedValue([
      prRow({
        headRepositoryGithubId: "5826",
        headRepositoryFullName: "fork-owner/widgets",
        headRepositoryDefaultBranchName: "trunk",
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Available,
        headRepositoryDefaultBranchCompleteness:
          RepositoryDefaultCompleteness.Complete,
        headRepositoryDefaultBranchObservationKey: "missing-provenance",
        headRepositoryDefaultBranchObservedAt: new Date("2026-02-11T09:03:00Z"),
      }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr).not.toHaveProperty("headRepository");
    expect(pr).not.toHaveProperty("headRepositoryUnavailable");
  });

  it("sets hasMore AND truncated when the projection has more rows than the limit", async () => {
    // limit + 1 rows come back; the extra row signals more exist.
    prFindMany.mockResolvedValue([
      prRow({ id: "a", number: 1 }),
      prRow({ id: "b", number: 2 }),
    ]);

    const result = await readRepositoryPullRequestsFromProjection(REPO, ORG, {
      limit: 1,
      targetNumbers: [],
    });

    expect(result.hasMore).toBe(true);
    // truncated must track hasMore — a non-exhaustive slice cannot claim
    // completeness (the "some older PRs omitted" warning gates on both).
    expect(result.truncated).toBe(true);
    expect(result.pullRequests).toHaveLength(1);
  });

  it("includes a target PR outside the top limit and flags a truly missing target", async () => {
    prFindMany
      // Primary page (limit + 1) — target #77 is not in it.
      .mockResolvedValueOnce([prRow({ id: "a", number: 1 })])
      // Second query fetches the outstanding target rows; #77 exists, #99 does not.
      .mockResolvedValueOnce([prRow({ id: "t", number: 77 })]);

    const result = await readRepositoryPullRequestsFromProjection(REPO, ORG, {
      limit: 5,
      targetNumbers: [77, 99],
    });

    const numbers = result.pullRequests.map((pr) => pr.number);
    expect(numbers).toContain(77);
    expect(result.missingTargetNumbers).toEqual([99]);
    // The second query is scoped to only the outstanding targets.
    expect(prFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ number: { in: [77, 99] } }),
      })
    );
  });

  it("does not issue a second query when there are no target numbers", async () => {
    prFindMany.mockResolvedValue([prRow()]);

    await readRepositoryPullRequestsFromProjection(REPO, ORG, {
      limit: 30,
      targetNumbers: [],
    });

    expect(prFindMany).toHaveBeenCalledTimes(1);
  });
});

describe("serveRepositoryPullRequestsFromProjection", () => {
  it("resolves an active, non-removed, org-owned repo, merges tracked state, and reads with NO GraphQL", async () => {
    repoFindFirst.mockResolvedValue({ fullName: "acme/widgets" });
    getTrackedMock.mockResolvedValue({
      trackedPrUrls: ["https://github.com/acme/widgets/pull/7"],
      trackedBranches: [],
      trackedBranchKeys: ["key-1"],
      trackedPrNumbers: [7],
    });
    prFindMany.mockResolvedValue([prRow()]);

    const response = await serveRepositoryPullRequestsFromProjection(
      REPO,
      ORG,
      "project-1",
      30
    );

    // Repo resolution requires org ownership, non-tombstoned, active installation
    // — so an unavailable repo 404s instead of collapsing to an empty list.
    expect(repoFindFirst).toHaveBeenCalledWith({
      where: {
        id: REPO,
        removedAt: null,
        installation: {
          organizationId: ORG,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { fullName: true },
    });
    expect(getTrackedMock).toHaveBeenCalledWith({
      organizationId: ORG,
      projectId: "project-1",
      repositoryFullName: "acme/widgets",
      repositoryId: REPO,
    });
    expect(prFindMany).toHaveBeenCalled();
    expect(response.pullRequests).toHaveLength(1);
    expect(response.trackedPrUrls).toEqual([
      "https://github.com/acme/widgets/pull/7",
    ]);
    expect(response.trackedBranchKeys).toEqual(["key-1"]);
  });

  it("throws for an unknown, cross-org, removed, or suspended-installation id", async () => {
    repoFindFirst.mockResolvedValue(null);

    await expect(
      serveRepositoryPullRequestsFromProjection(REPO, ORG, null, 30)
    ).rejects.toThrow("Repository not found");
    expect(getTrackedMock).not.toHaveBeenCalled();
  });
});
