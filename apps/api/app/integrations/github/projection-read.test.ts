import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import type { GetPullRequestsResponse } from "@repo/api/src/types/github";
import {
  GitHubPRState,
  GitHubPullRequestTrackingScope,
} from "@repo/api/src/types/github";
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
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";

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
const observedRepoFindFirst = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    pullRequestDetail: { findMany: prFindMany },
    gitHubInstallationRepository: { findFirst: repoFindFirst },
    gitHubObservedRepository: { findFirst: observedRepoFindFirst },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  // ISS-8049: the observed lane resolves only when a test seeds a row.
  observedRepoFindFirst.mockResolvedValue(null);
});

// Row fixtures live in @/__tests__/support/integrations/github so the
// producer-parity suite (ISS-8162 split it into its own file) reads the
// identical stored row.
import {
  BRANCH_CURRENT_BASE_DECOY,
  ORG,
  PARITY_BRANCH_ARTIFACT_NAME,
  PARITY_PR,
  parityRow,
  prRow,
  REPO,
  REPO_SELECTOR,
} from "@/__tests__/support/integrations/github/projection-read.test-fixtures";

describe("readRepositoryPullRequestsFromProjection", () => {
  it("maps a projected PR to the live summary shape", async () => {
    prFindMany.mockResolvedValue([prRow()]);

    const result = await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 30,
        targetNumbers: [],
      }
    );

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

  it("serves the provider head ref, not the owning Branch's current name", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
    ).pullRequests;

    expect(pr.headBranch).toBe(PARITY_PR.headRefName);
  });

  it("selects the persisted head ref rather than inferring it from the Branch", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 30,
        targetNumbers: [],
      }
    );

    expect(prFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ headRefName: true }),
      })
    );
  });

  it("falls back to the Branch name for a row head_ref_name is still null on", async () => {
    prFindMany.mockResolvedValue([parityRow({ headRefName: null })]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
    ).pullRequests;

    expect(pr.headBranch).toBe(PARITY_BRANCH_ARTIFACT_NAME);
  });

  it("serves an orphaned row with no head ref and no branch as an empty head ref", async () => {
    prFindMany.mockResolvedValue([
      parityRow({ headRefName: null, branchArtifact: { branch: null } }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
    ).pullRequests;

    expect(pr.headBranch).toBe("");
  });

  // ISS-8155 AC-1. The Branch row carries the branch's CURRENT base, which moves
  // when the branch is retargeted or reused for a second PR; serving it made
  // every earlier PR on that branch report a target it was never opened against.
  it("serves the PR's own base ref, not the owning Branch's current base", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.baseBranch).toBe(PARITY_PR.baseBranch);
    expect(pr.baseBranch).not.toBe(BRANCH_CURRENT_BASE_DECOY);
  });

  it("selects the persisted base ref rather than inferring it from the Branch", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
      limit: 30,
      targetNumbers: [],
    });

    expect(prFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ baseRefName: true }),
      })
    );
  });

  // ISS-8155 AC-4 (skew). A row written before base_ref_name existed, or by a
  // producer that reported no author, has no measured value for either. It must
  // read as an explicit absence the surface can name — never a crash, never the
  // neighbouring Branch's base, and never the literal "unknown", which is a
  // login a real GitHub account can hold.
  //
  // ISS-8162 AC-4, ISS-8176's skew case, and ISS-8158 AC-4 ride on this rather
  // than duplicating it: a row the refresh, repair, tombstoned-repo settle, or
  // PRD-683 targeted-sync lane wrote before it stamped the PR column is exactly
  // this row — both columns null, every other field filled — so this is where
  // that contract lives for those lanes too.
  it("serves an explicit absence for a row no producer has filled", async () => {
    prFindMany.mockResolvedValue([
      parityRow({ baseRefName: null, authorLogin: null }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.baseBranch).toBe("");
    expect(pr.author).toBe("");
    expect(pr.baseBranch).not.toBe(BRANCH_CURRENT_BASE_DECOY);
    // Every other field on the same row still resolves, so the absence is one
    // field's, not a row the read gave up on.
    expect(pr.number).toBe(PARITY_PR.number);
    expect(pr.headBranch).toBe(PARITY_PR.headRefName);
  });

  // ISS-8155 AC-1: the checks half. A superseded PR's head is not the branch
  // head, so the branch's rollup says nothing about it — null, for the surface
  // to render as unknown, rather than the current PR's result.
  //
  // ISS-8158 AC-3's checks field rides on this too, and is not asserted per
  // producer: `checksStatus` is a BranchDetail column no PR detail payload can
  // carry, so every lane reads it through this one rule and none can drift from
  // another on it. A per-arm assertion would only re-read a fixture constant.
  it("reports no checks rollup for a PR the branch has superseded", async () => {
    prFindMany.mockResolvedValue([
      parityRow({
        branchArtifact: {
          branch: {
            branchName: PARITY_BRANCH_ARTIFACT_NAME,
            baseBranch: BRANCH_CURRENT_BASE_DECOY,
            checksStatus: ChecksStatus.Passing,
            currentPullRequestDetailId: "a-later-pr-detail",
          },
        },
      }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.checksStatus).toBeNull();
    expect(pr.checksStatus).not.toBe(ChecksStatus.Passing);
  });

  it("reports the branch head rollup for the PR that head belongs to", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;

    expect(pr.checksStatus).toBe(ChecksStatus.Passing);
  });

  it("excludes rows with no htmlUrl/githubId instead of manufacturing an empty identity", async () => {
    prFindMany.mockResolvedValue([prRow()]);

    await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 30,
        targetNumbers: [],
      }
    );

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

  // ISS-8155 CHANGED THIS EXPECTATION DELIBERATELY. It used to require the
  // literal "unknown" for a missing author. That is a login a real GitHub
  // account can hold, so the surface could not tell an absence from a
  // measurement and had to render one as the other. The absent form is what both
  // producers serve now; the null watermark half is unchanged.
  it("coalesces a missing author and a null watermark to their absent form", async () => {
    prFindMany.mockResolvedValue([
      prRow({ authorLogin: null, githubUpdatedAt: null }),
    ]);

    const [pr] = (
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
    ).pullRequests;

    expect(pr.author).toBe("");
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
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
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
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
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

    const result = await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 30,
        targetNumbers: [],
      }
    );

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
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
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
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
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

    const result = await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 1,
        targetNumbers: [],
      }
    );

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

    const result = await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 5,
        targetNumbers: [77, 99],
      }
    );

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

    await readRepositoryPullRequestsFromProjection(
      { repositoryId: REPO },
      ORG,
      {
        limit: 30,
        targetNumbers: [],
      }
    );

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

    const response = expectServed(
      await serveRepositoryPullRequestsFromProjection(
        REPO,
        ORG,
        "project-1",
        30
      )
    );

    // Repo resolution requires org ownership, non-tombstoned, active
    // installation — anything else defers to the live lane rather than
    // collapsing to an empty list.
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

  it("propagates organization target-discovery truncation from the production projection path", async () => {
    repoFindFirst.mockResolvedValue({ fullName: "acme/widgets" });
    getTrackedMock.mockResolvedValue({
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [7],
      targetDiscoveryTruncated: true,
    });
    prFindMany.mockResolvedValue([prRow()]);

    const response = expectServed(
      await serveRepositoryPullRequestsFromProjection(
        REPO,
        ORG,
        null,
        30,
        GitHubPullRequestTrackingScope.Organization
      )
    );

    expect(response.targetDiscoveryTruncated).toBe(true);
  });

  it("defers an unknown, cross-org, removed, or suspended-installation id to the live lane", async () => {
    // PLN-1775 M7 behavior change: a miss used to throw "Repository not found"
    // here. It now returns null so the route falls through to the live lane,
    // which owns that verdict and still raises it for an id NO lane can
    // resolve — while an installation-free org's observed-repository id, which
    // this query can never match, now reaches the lane that CAN serve it.
    repoFindFirst.mockResolvedValue(null);

    await expect(
      serveRepositoryPullRequestsFromProjection(REPO, ORG, null, 30)
    ).resolves.toBeNull();
    expect(getTrackedMock).not.toHaveBeenCalled();
  });

  it("serves a verified observed-repository id through the repo-less selector (ISS-8049)", async () => {
    repoFindFirst.mockResolvedValue(null);
    observedRepoFindFirst.mockResolvedValue({
      id: REPO,
      repositoryFullName: "acme/widgets",
      owner: "Acme",
      name: "Widgets",
      githubRepoId: "1234",
      isPrivate: false,
    });
    getTrackedMock.mockResolvedValue({
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [],
    });
    prFindMany.mockResolvedValue([prRow()]);

    const response = expectServed(
      await serveRepositoryPullRequestsFromProjection(REPO, ORG, null, 30)
    );

    // Resolution is pinned to VERIFIED rows: pending or denied observations
    // must fall through to the live lane, so the where clause is the contract.
    expect(observedRepoFindFirst).toHaveBeenCalledWith({
      where: {
        id: REPO,
        organizationId: ORG,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
      },
      // The select is the live resolver's (findVerifiedObservedRepository) —
      // one shared usable-row bar for both lanes (PR #6037 review).
      select: expect.any(Object),
    });
    // Tracked state gets provider casing and the repo-less selector.
    expect(getTrackedMock).toHaveBeenCalledWith({
      organizationId: ORG,
      projectId: null,
      repositoryFullName: "Acme/Widgets",
      repositoryId: null,
    });
    // The projection read keys on the NORMALIZED name with the null pin, so an
    // installation row for the same name cannot be double-served.
    expect(prFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repositoryFullName: "acme/widgets",
          repositoryId: null,
          organizationId: ORG,
        }),
      })
    );
    expect(response.pullRequests).toHaveLength(1);
  });

  it("defers a Verified row missing its identity writes to the live lane (PR #6037 review)", async () => {
    // The live lane drops a Verified row without owner/name/githubRepoId/
    // isPrivate as corrupt; the projection lane must apply the SAME bar so the
    // two lanes cannot disagree about one id. The live lane owns the verdict.
    repoFindFirst.mockResolvedValue(null);
    observedRepoFindFirst.mockResolvedValue({
      id: REPO,
      repositoryFullName: "acme/widgets",
      owner: "Acme",
      name: "Widgets",
      githubRepoId: null,
      isPrivate: false,
    });

    await expect(
      serveRepositoryPullRequestsFromProjection(REPO, ORG, null, 30)
    ).resolves.toBeNull();
    expect(getTrackedMock).not.toHaveBeenCalled();
    expect(prFindMany).not.toHaveBeenCalled();
  });

  it("keeps deferring to the live lane when the observation is not verified (ISS-8049)", async () => {
    repoFindFirst.mockResolvedValue(null);
    observedRepoFindFirst.mockResolvedValue(null);

    await expect(
      serveRepositoryPullRequestsFromProjection(REPO, ORG, null, 30)
    ).resolves.toBeNull();
    expect(getTrackedMock).not.toHaveBeenCalled();
    expect(prFindMany).not.toHaveBeenCalled();
  });
});

/**
 * Narrow the lane's `| null` at the one place it means "this lane could not
 * resolve the id" — a case each caller here has already ruled out by seeding a
 * resolvable repository, so a null is a broken fixture, not the behavior.
 */
function expectServed(
  response: GetPullRequestsResponse | null
): GetPullRequestsResponse {
  if (!response) {
    throw new Error("expected the projection lane to serve this repository id");
  }
  return response;
}
