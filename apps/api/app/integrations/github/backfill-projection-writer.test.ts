import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  existingPullRequest,
  pullRequestMetadata,
  readModelPullRequest,
  statusCheckOnlyMetadata,
} from "@/__tests__/support/integrations/github/backfill-projection-writer.test-fixtures";
import { pullRequestProviderLockHolderTxOptions } from "@/app/branches/pull-request-provider-lock";

/** The installation lane, which is what every pre-ISS-7721 case exercised. */
const APP_CREDENTIAL = {
  type: GitHubFetchCredentialType.GitHubApp,
  ownerId: null,
} as const;

const persistBranchStatusChecksFromRollupMock = vi.fn();
const persistLatestGitHubPRReviewMock = vi.fn();
const recomputeAndUpdateAggregateMock = vi.fn();
const buildPullRequestLifecycleActivityRecordsMock = vi.fn(
  buildLifecycleRecordMocks
);
const persistPullRequestLifecycleActivityRecordsMock = vi.fn();
const predictBackfillLifecycleProjectionDiffMock = vi.fn();

const dbMock = {
  branchActivityAtom: {
    findMany: vi.fn(),
  },
  branchDetail: {
    findMany: vi.fn(),
  },
  pullRequestDetail: {
    findMany: vi.fn(),
  },
};
const txMock = {
  $executeRaw: vi.fn(),
  branchDetail: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  pullRequestDetail: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  gitHubPRReview: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  gitHubCommentProjection: {
    findMany: vi.fn(),
  },
  gitHubCommentThreadProjection: {
    findMany: vi.fn(),
  },
  branchStatusCheck: {
    findMany: vi.fn(),
  },
};
const withDbMock = Object.assign(
  vi.fn((callback) => callback(dbMock)),
  {
    tx: vi.fn((callback) => callback(txMock)),
  }
);

vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
}));

// ISS-12463: the branch-owner seed is raw SQL this stubbed database does not
// model; its wiring is pinned by the real-Postgres seed-wiring suite.
vi.mock("@/app/branches/branch-owner-seed/branch-owner-seed", () => ({
  seedBranchOwners: vi.fn().mockResolvedValue(0),
}));

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind: {
    ISSUE_COMMENT: "ISSUE_COMMENT",
    REVIEW_THREAD: "REVIEW_THREAD",
  },
  GitHubLegacyCommentState: {
    PENDING: "PENDING",
    ADDRESSED: "ADDRESSED",
  },
  ThreadStatus: {
    OPEN: "OPEN",
    RESOLVED: "RESOLVED",
  },
  withDb: withDbMock,
}));

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange: vi.fn(),
  persistBranchStatusChecksFromRollup: persistBranchStatusChecksFromRollupMock,
}));

vi.mock("@/app/comments/github-diff-side", () => ({
  normalizeGitHubDiffSide: (side: string | null | undefined) => side ?? null,
}));

vi.mock("@/lib/review-decision-utils", () => ({
  recomputeAndUpdateAggregate: recomputeAndUpdateAggregateMock,
}));

vi.mock("@/app/branches/pull-request-lifecycle-activity", () => ({
  buildPullRequestLifecycleActivityRecords:
    buildPullRequestLifecycleActivityRecordsMock,
  persistPullRequestLifecycleActivityRecordsInTransaction:
    persistPullRequestLifecycleActivityRecordsMock,
}));

vi.mock("./backfill-lifecycle-projection-diff", () => ({
  predictBackfillLifecycleProjectionDiff:
    predictBackfillLifecycleProjectionDiffMock,
}));

vi.mock("./pr-review-projection", () => ({
  persistLatestGitHubPRReview: persistLatestGitHubPRReviewMock,
}));

const { githubBackfillProjectionWriter } = await import(
  "./backfill-projection-writer"
);

describe("githubBackfillProjectionWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.branchDetail.findMany.mockResolvedValue([
      {
        artifactId: "branch-artifact-1",
        branchName: "feature/test",
        currentPullRequestDetailId: null,
        checksStatus: ChecksStatus.Unknown,
        currentPullRequestDetail: null,
      },
    ]);
    dbMock.pullRequestDetail.findMany.mockResolvedValue([]);
    dbMock.branchActivityAtom.findMany.mockResolvedValue([]);
    const projectedBranch = {
      artifactId: "branch-artifact-1",
      branchName: "feature/test",
      baseBranch: null,
      baseBranchSource: null,
      headSha: null,
      headShaSource: null,
      checksStatus: ChecksStatus.Unknown,
      checksDetailProviderState: null,
      checksDetailUpdatedAt: null,
      currentPullRequestDetailId: null,
    };
    // The write path reads this scope in ONE batched statement now (ISS-9116)
    // and re-reads per branch only after it has written to that branch, so both
    // shapes have to answer with the same row.
    txMock.branchDetail.findFirst.mockResolvedValue(projectedBranch);
    txMock.branchDetail.findMany.mockResolvedValue([projectedBranch]);
    txMock.pullRequestDetail.findFirst.mockImplementation(
      (args: { where?: { id?: string; branchArtifactId?: string } }) =>
        args.where?.id && args.where.branchArtifactId
          ? Promise.resolve({ id: args.where.id })
          : Promise.resolve(null)
    );
    txMock.pullRequestDetail.findMany.mockResolvedValue([]);
    txMock.pullRequestDetail.findUnique.mockResolvedValue(null);
    txMock.pullRequestDetail.update.mockResolvedValue({});
    txMock.pullRequestDetail.upsert.mockResolvedValue({ id: "pr-detail-1" });
    txMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
    txMock.branchDetail.update.mockResolvedValue({});
    txMock.branchDetail.updateMany.mockResolvedValue({ count: 1 });
    persistLatestGitHubPRReviewMock.mockResolvedValue(undefined);
    txMock.gitHubPRReview.findMany.mockResolvedValue([]);
    txMock.gitHubCommentProjection.findMany.mockResolvedValue([]);
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([]);
    txMock.branchStatusCheck.findMany.mockResolvedValue([]);
    persistBranchStatusChecksFromRollupMock.mockResolvedValue({
      status: "updated",
      checksStatusChanged: false,
      previousChecksStatus: ChecksStatus.Unknown,
      nextChecksStatus: ChecksStatus.Passing,
    });
    recomputeAndUpdateAggregateMock.mockResolvedValue(undefined);
    persistPullRequestLifecycleActivityRecordsMock.mockResolvedValue(undefined);
    predictBackfillLifecycleProjectionDiffMock.mockResolvedValue({
      lifecycleAtomProjectionChangeCount: 1,
      branchLastActivityProjectionChangeCount: 1,
    });
  });

  it("computes a dry-run projection diff without mutating rows", async () => {
    const diff = await githubBackfillProjectionWriter.diff({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      pullRequests: [readModelPullRequest()],
    });

    expect(diff).toEqual({
      branchProjectionChangeCount: 1,
      pullRequestProjectionChangeCount: 1,
      lifecycleAtomProjectionChangeCount: 1,
      branchLastActivityProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 0,
      reviewCommentProjectionChangeCount: 0,
      reviewThreadProjectionChangeCount: 0,
      reviewProjectionChangeCount: 0,
      statusCheckProjectionChangeCount: 0,
      skippedBranchCount: 0,
    });
    expect(withDbMock.tx).not.toHaveBeenCalled();
    expect(buildPullRequestLifecycleActivityRecordsMock).not.toHaveBeenCalled();
    expect(
      persistPullRequestLifecycleActivityRecordsMock
    ).not.toHaveBeenCalled();
    expect(txMock.pullRequestDetail.upsert).not.toHaveBeenCalled();
    expect(txMock.pullRequestDetail.update).not.toHaveBeenCalled();
    expect(txMock.pullRequestDetail.updateMany).not.toHaveBeenCalled();
    expect(txMock.branchDetail.update).not.toHaveBeenCalled();
    expect(persistLatestGitHubPRReviewMock).not.toHaveBeenCalled();
    expect(persistBranchStatusChecksFromRollupMock).not.toHaveBeenCalled();
  });

  it("writes provider PR fields through the shared projection writer", async () => {
    const diff = await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      credential: APP_CREDENTIAL,
      pullRequests: [readModelPullRequest()],
    });

    expect(diff.pullRequestProjectionChangeCount).toBe(1);
    expect(withDbMock.tx).toHaveBeenCalledWith(
      expect.any(Function),
      pullRequestProviderLockHolderTxOptions
    );
    expect(buildPullRequestLifecycleActivityRecordsMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      pullRequestDetailId: "pr-detail-1",
      openedAt: new Date("2026-07-05T00:00:00.000Z"),
      mergedAt: null,
      closedAt: null,
    });
    expect(persistPullRequestLifecycleActivityRecordsMock).toHaveBeenCalledWith(
      txMock,
      {
        organizationId: "org-1",
        records: [
          {
            branchArtifactId: "branch-artifact-1",
            atom: {
              sourceEventId: "pr-detail-1:opened",
              occurredAt: new Date("2026-07-05T00:00:00.000Z"),
            },
          },
        ],
      }
    );
    expect(txMock.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId_number: {
            repositoryId: "repo-1",
            number: 42,
          },
        },
        create: expect.objectContaining({
          branchArtifactId: "branch-artifact-1",
          githubId: "4242",
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          reviewDecision: ReviewDecision.Approved,
        }),
        update: expect.objectContaining({
          additions: 1,
          deletions: 0,
          changedFiles: 1,
        }),
      })
    );
    expect(txMock.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "branch-artifact-1",
          organizationId: "org-1",
        },
        data: expect.objectContaining({
          currentPullRequestDetailId: "pr-detail-1",
        }),
      })
    );
    const headObservationWrite = txMock.branchDetail.update.mock.calls.find(
      ([input]) => input.data.headShaObservedAt !== undefined
    )?.[0];
    expect(headObservationWrite?.data).toMatchObject({
      headShaObservedAt: new Date(readModelPullRequest().updatedAt),
    });
    expect(headObservationWrite?.data).not.toHaveProperty("lastActivityAt");
    expect(txMock.branchDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "branch-artifact-1" },
        data: expect.objectContaining({
          baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        }),
      })
    );
    expect(txMock.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "branch-artifact-1",
          organizationId: "org-1",
        },
        data: expect.objectContaining({
          checksStatus: ChecksStatus.Passing,
        }),
      })
    );
  });

  it("persists a 100-PR lifecycle window through one canonical batch", async () => {
    txMock.pullRequestDetail.upsert.mockImplementation(({ create }) =>
      Promise.resolve({ id: `pr-detail-${create.number}` })
    );
    const pullRequests = Array.from({ length: 100 }, (_, index) => ({
      ...readModelPullRequest(),
      githubId: `github-pr-${index + 1}`,
      number: index + 1,
      title: `Projected PR ${index + 1}`,
      mergedAt: "2026-07-06T00:00:00.000Z",
      closedAt: "2026-07-06T00:00:00.000Z",
    }));

    await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      credential: APP_CREDENTIAL,
      pullRequests,
    });

    expect(buildPullRequestLifecycleActivityRecordsMock).toHaveBeenCalledTimes(
      100
    );
    expect(
      persistPullRequestLifecycleActivityRecordsMock
    ).toHaveBeenCalledOnce();
    expect(
      persistPullRequestLifecycleActivityRecordsMock.mock.calls[0]?.[1].records
    ).toHaveLength(200);
  });

  it("treats whole-second and millisecond-equivalent GitHub timestamps as unchanged", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValue([
      {
        ...existingPullRequest(),
        closedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
    ]);

    const diff = await githubBackfillProjectionWriter.diff({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      pullRequests: [
        {
          ...readModelPullRequest(),
          closedAt: "2026-07-05T00:00:00Z",
        },
      ],
    });

    expect(diff.pullRequestProjectionChangeCount).toBe(0);
  });

  // FEA-3552: an existing row from before the createdAt column (null
  // githubCreatedAt) must re-project when the read model supplies openedAt, so the
  // rail's "PR opened" dot back-fills.
  it("re-projects a PR row missing the persisted createdAt to back-fill openedAt", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValue([
      {
        ...existingPullRequest(),
        githubCreatedAt: null,
      },
    ]);

    const diff = await githubBackfillProjectionWriter.diff({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      pullRequests: [
        {
          ...readModelPullRequest(),
          openedAt: "2026-07-05T00:00:00.000Z",
        },
      ],
    });

    expect(diff.pullRequestProjectionChangeCount).toBe(1);
  });

  it("counts comment changes, writes review rows and per-check rows, and leaves the comments to the reconcile", async () => {
    const projected: { number: number; pullRequestDetailId: string }[] = [];
    const diff = await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      credential: APP_CREDENTIAL,
      pullRequests: [readModelPullRequest()],
      pullRequestMetadata: [pullRequestMetadata()],
      onPullRequestProjected: (pullRequest) => projected.push(pullRequest),
    });

    expect(diff).toMatchObject({
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
    });
    // PLN-2122 Step 4: the caller reconciles this pull request's comments
    // after the transaction commits; nothing here writes a comment table.
    expect(projected).toEqual([
      {
        number: readModelPullRequest().number,
        pullRequestDetailId: "pr-detail-1",
      },
    ]);
    expect(persistLatestGitHubPRReviewMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        pullRequestId: "pr-detail-1",
        authorLogin: "reviewer",
        state: ReviewDecision.Approved,
        ...expectedBackfillStoredProvenance(),
      })
    );
    expect(recomputeAndUpdateAggregateMock).toHaveBeenCalledWith(
      txMock,
      "pr-detail-1"
    );
    expect(persistBranchStatusChecksFromRollupMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        organizationId: "org-1",
        headSha: "abc123",
        fetchProvenance: expectedGraphqlBackfillFetchProvenance(),
      })
    );
  });

  it("counts stale per-check rows deleted by the shared status-check writer", async () => {
    txMock.pullRequestDetail.findUnique.mockResolvedValue(
      existingPullRequest()
    );
    txMock.branchStatusCheck.findMany.mockResolvedValue([
      {
        providerKey: "check-1",
        kind: "check_run",
        providerNodeId: "check-node-1",
        name: "unit",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        targetUrl: "https://github.com/checks/1",
        position: 0,
      },
      {
        providerKey: "stale-check",
        kind: "check_run",
        providerNodeId: "stale-node",
        name: "old e2e",
        status: "COMPLETED",
        conclusion: "FAILURE",
        targetUrl: "https://github.com/checks/stale",
        position: 1,
      },
    ]);

    const diff = await githubBackfillProjectionWriter.write({
      organizationId: "org-1",
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
      credential: APP_CREDENTIAL,
      pullRequests: [readModelPullRequest()],
      pullRequestMetadata: [statusCheckOnlyMetadata()],
    });

    expect(diff.statusCheckProjectionChangeCount).toBe(1);
    expect(persistBranchStatusChecksFromRollupMock).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        headSha: "abc123",
        rollup: expect.objectContaining({
          checks: [expect.objectContaining({ id: "check-1" })],
        }),
      })
    );
  });

  describe("repo-less (observation) lane", () => {
    /** Provider casing on the way in; every predicate must normalize it. */
    const REPO_LESS_REPOSITORY = {
      id: null,
      fullName: "CloseDLoop-AI/ClosedLoop-AI",
    };
    const POOL_CREDENTIAL = {
      type: GitHubFetchCredentialType.UserOAuth,
      ownerId: "3f1c0a52-9d64-4c1a-9c2e-2b0b3e6a7c11",
    };
    const REPO_LESS_SELECTOR = {
      repositoryId: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
    };

    function resolveRepoLessRowTo(id: string | null) {
      txMock.pullRequestDetail.findFirst.mockImplementation(
        (args: { where?: Record<string, unknown> }) => {
          const where = args.where ?? {};
          if (where.id) {
            return Promise.resolve({
              id: where.id,
              branchArtifactId: "branch-artifact-1",
              githubUpdatedAt: null,
              headRefName: null,
            });
          }
          return Promise.resolve(id ? { id } : null);
        }
      );
    }

    beforeEach(() => {
      txMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
      resolveRepoLessRowTo("pr-detail-repo-less");
    });

    it("selects branches and PR rows by the normalized full name, never by id", async () => {
      await githubBackfillProjectionWriter.write({
        organizationId: "org-1",
        repository: REPO_LESS_REPOSITORY,
        credential: POOL_CREDENTIAL,
        pullRequests: [readModelPullRequest()],
      });

      expect(txMock.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(REPO_LESS_SELECTOR),
        })
      );
      // The `(repositoryId, number)` unique is the App lane's identity and has
      // no repo-less equivalent Prisma can express; reaching for it here would
      // pass a null through a non-null key.
      expect(txMock.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(txMock.pullRequestDetail.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
            repositoryFullName: "closedloop-ai/closedloop-ai",
            number: 42,
          }),
        })
      );
    });

    it("persists the pool credential and leaves repositoryId untouched", async () => {
      await githubBackfillProjectionWriter.write({
        organizationId: "org-1",
        repository: REPO_LESS_REPOSITORY,
        credential: POOL_CREDENTIAL,
        pullRequests: [readModelPullRequest()],
      });

      const detailUpdate = txMock.pullRequestDetail.updateMany.mock.calls.find(
        (call: { where?: { id?: string } }[]) =>
          call[0]?.where?.id === "pr-detail-repo-less"
      );
      expect(detailUpdate?.[0].data).toMatchObject({
        fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
        fetchCredentialOwnerId: POOL_CREDENTIAL.ownerId,
        fetchMechanism: GitHubFetchMechanism.Backfill,
      });
      // The regression this milestone exists to prevent: an observation row's
      // UUID reaching the installation-repo surrogate column.
      expect(detailUpdate?.[0].data).not.toHaveProperty("repositoryId");
      expect(txMock.pullRequestDetail.upsert).not.toHaveBeenCalled();
    });

    it("stamps the pool credential on the status-check rollup too", async () => {
      await githubBackfillProjectionWriter.write({
        organizationId: "org-1",
        repository: REPO_LESS_REPOSITORY,
        credential: POOL_CREDENTIAL,
        pullRequests: [readModelPullRequest()],
        pullRequestMetadata: [statusCheckOnlyMetadata()],
      });

      expect(persistBranchStatusChecksFromRollupMock).toHaveBeenCalledWith(
        txMock,
        expect.objectContaining({
          fetchProvenance: expect.objectContaining({
            credentialType: GitHubFetchCredentialType.UserOAuth,
            credentialOwnerId: POOL_CREDENTIAL.ownerId,
            mechanism: GitHubFetchMechanism.Graphql,
          }),
        })
      );
    });

    it("skips a PR with no repo-less row rather than creating one", async () => {
      resolveRepoLessRowTo(null);

      const diff = await githubBackfillProjectionWriter.write({
        organizationId: "org-1",
        repository: REPO_LESS_REPOSITORY,
        credential: POOL_CREDENTIAL,
        pullRequests: [readModelPullRequest()],
      });

      // Backfill never creates PR rows on this lane. The shared writer's create
      // path would throw on a null repositoryId, taking the whole repository's
      // sweep down with it.
      expect(diff.skippedBranchCount).toBe(1);
      expect(txMock.pullRequestDetail.upsert).not.toHaveBeenCalled();
      expect(txMock.pullRequestDetail.updateMany).not.toHaveBeenCalled();
    });

    it("does not predict a create the repo-less write will never make", async () => {
      dbMock.pullRequestDetail.findMany.mockResolvedValue([]);

      const diff = await githubBackfillProjectionWriter.diff({
        organizationId: "org-1",
        repository: REPO_LESS_REPOSITORY,
        pullRequests: [readModelPullRequest()],
      });

      expect(diff.skippedBranchCount).toBe(1);
      expect(diff.pullRequestProjectionChangeCount).toBe(0);
      expect(dbMock.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(REPO_LESS_SELECTOR),
        })
      );
      // #6038 review: the lifecycle predictor used to run against the FULL
      // branch and PR lists before this skip, so it counted atoms for the very
      // PR the write drops. It now sees only what survived the loop.
      expect(predictBackfillLifecycleProjectionDiffMock).toHaveBeenCalledWith(
        dbMock,
        expect.objectContaining({ branches: [], existingPullRequests: [] })
      );
    });

    it("resolves the skip with the shared writer's own repo-less predicate", async () => {
      resolveRepoLessRowTo(null);

      await githubBackfillProjectionWriter.write({
        organizationId: "org-1",
        repository: REPO_LESS_REPOSITORY,
        credential: POOL_CREDENTIAL,
        pullRequests: [readModelPullRequest()],
      });

      // #6038 review: this pre-check decides the skip, and the shared writer
      // then re-resolves independently. A narrower predicate here found rows
      // the resolver missed, and the write fell through to a create path that
      // refuses a null repositoryId and throws. `repositoryId: null` keeps an
      // installation-backed row for the same (fullName, number) out of both.
      expect(txMock.pullRequestDetail.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: "org-1",
            repositoryId: null,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            number: 42,
            OR: [{ githubId: "4242" }, { githubId: null }],
          },
        })
      );
    });
  });
});

function expectedGraphqlBackfillFetchProvenance() {
  return expect.objectContaining({
    credentialType: GitHubFetchCredentialType.GitHubApp,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    observedAt: expect.any(Date),
    resultReason: GitHubSyncResultReason.Success,
  });
}

function expectedBackfillStoredProvenance() {
  return {
    fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
    fetchCredentialOwnerId: null,
    fetchMechanism: GitHubFetchMechanism.Backfill,
    fetchTrigger: GitHubFetchTrigger.Backfill,
    fetchObservedAt: expect.any(Date),
    fetchResultReason: GitHubSyncResultReason.Success,
  };
}

function buildLifecycleRecordMocks(input: {
  branchArtifactId: string;
  pullRequestDetailId: string;
  openedAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
}) {
  const records: Array<{
    branchArtifactId: string;
    atom: { sourceEventId: string; occurredAt: Date };
  }> = [];
  if (input.openedAt) {
    records.push(lifecycleRecordMock(input, "opened", input.openedAt));
  }
  if (input.mergedAt) {
    records.push(lifecycleRecordMock(input, "merged", input.mergedAt));
  } else if (input.closedAt) {
    records.push(lifecycleRecordMock(input, "closed", input.closedAt));
  }
  return records;
}

function lifecycleRecordMock(
  input: { branchArtifactId: string; pullRequestDetailId: string },
  suffix: "opened" | "merged" | "closed",
  occurredAt: Date
) {
  return {
    branchArtifactId: input.branchArtifactId,
    atom: {
      sourceEventId: `${input.pullRequestDetailId}:${suffix}`,
      occurredAt,
    },
  };
}
