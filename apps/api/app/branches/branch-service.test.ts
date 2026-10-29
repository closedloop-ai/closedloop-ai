import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-12552: writing a source link derives implementation evidence, a store
// this suite does not exercise.
vi.mock(
  "@/app/agent-sessions/service/attribution/derive-implementation-evidence",
  () => ({ deriveImplementationEvidence: vi.fn() })
);
vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN", PENDING: "PENDING" },
  });
});

vi.mock("./pull-request-author-identity", () => ({
  ensurePullRequestAuthorIdentity: vi.fn(),
}));

import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { RepositoryRole, SnapshotSource } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
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
  repositoryDefaultAuthorityValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { Result, Status } from "@repo/api/src/types/result";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { ArtifactType } from "@repo/database";
import { getMockWithDb, mockWithDbAll } from "../../__tests__/utils/db-helpers";
import {
  branchService,
  type UpsertBranchArtifactInput,
} from "./branch-service";
import { ensurePullRequestAuthorIdentity } from "./pull-request-author-identity";
import { pullRequestProviderLockTxOptions } from "./pull-request-provider-lock";

const baseInput = {
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryFullName: "closedloop-ai/sidecar",
  branchName: "symphony/fea-1132-sidecar",
  defaultBranch: "main",
  repositoryDefaultObservation: {
    authority: repositoryDefaultAuthorityValidator.parse({
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "123",
        fullName: "closedloop-ai/sidecar",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: "main",
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "observation-1",
        observedAt: "2026-08-11T12:00:00.000Z",
      },
    }),
  },
  projectId: "project-1",
  sourceArtifactId: "source-1",
  baseBranch: "main",
  baseBranchSource: BranchBaseBranchSource.HarnessInput,
};

describe("branchService.upsertBranchArtifact", () => {
  const mockWithDb = getMockWithDb();
  let mockTx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = createMockTx();
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
  });

  it("rejects source artifacts whose repository snapshot excludes the branch repo", async () => {
    const result = await branchService.upsertBranchArtifact(baseInput);

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(mockTx.artifact.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "source-1",
        organizationId: "org-1",
        projectId: "project-1",
        type: ArtifactType.DOCUMENT,
      }),
      select: {
        createdById: true,
        document: { select: { repositorySnapshot: true } },
      },
    });
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
    expect(mockTx.artifactLink.upsert).not.toHaveBeenCalled();
  });

  /**
   * ISS-7130: a Branch write carrying a PR takes the ISS-6980 PR-provider
   * advisory lock, and `pg_advisory_xact_lock` blocks inside the waiter's own
   * transaction — so on Prisma's 5s default a writer contending with the 30s
   * session-sync holder aborts with P2028 mid-wait instead of serializing behind
   * it. The lock-free case is the other half of the same decision: raising its
   * ceiling too would let a stalled push/desktop write pin a pooled connection
   * six times longer for a lock it never takes.
   */
  it("sizes a PR-carrying Branch write to the provider lock's worst-case holder", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      pullRequest: {
        githubId: "pr-7130",
        number: 71,
        title: "Contends for the provider lock",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/71",
        state: GitHubPRState.Open,
      },
    });

    expect(mockWithDb.tx).toHaveBeenCalledWith(
      expect.any(Function),
      pullRequestProviderLockTxOptions
    );
  });

  it("leaves a Branch write that takes no provider lock on Prisma's defaults", async () => {
    await branchService.upsertBranchArtifact(baseInput);

    expect(mockWithDb.tx).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  it("links the source artifact when its repository snapshot names the branch repo", async () => {
    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalled();
    expect(mockTx.artifactLink.upsert).toHaveBeenCalledWith({
      where: {
        sourceId_targetId_linkType: {
          sourceId: "source-1",
          targetId: "branch-artifact-1",
          linkType: LinkType.Produces,
        },
      },
      create: {
        organizationId: "org-1",
        sourceId: "source-1",
        targetId: "branch-artifact-1",
        linkType: LinkType.Produces,
        sortOrder: 0,
      },
      update: {},
      // ISS-6274: `linkSourceIfRequested` discards the link row, so the upsert
      // asks for the primary key alone — the narrowest `select` Prisma accepts.
      select: { id: true },
    });
  });

  it("never rewrites the source's repository snapshot on a branch link", async () => {
    mockTx.artifact.findFirst.mockResolvedValue({
      id: "source-1",
      document: {
        repositorySnapshot: {
          repositories: [
            {
              fullName: "closedloop-ai/sidecar",
              role: RepositoryRole.Primary,
              position: 0,
            },
          ],
          source: SnapshotSource.ProjectDefaults,
        },
      },
    });

    const result = await branchService.upsertBranchArtifact(baseInput);

    expect(result.ok).toBe(true);
    expect(mockTx.artifactLink.upsert).toHaveBeenCalled();
    expect(mockTx.documentDetail.updateMany).not.toHaveBeenCalled();
  });

  it("suppresses receipt-derived activity when a producer explicitly has no occurrence time", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");

    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "head-sha",
      headShaObservedAt: observedAt,
      activityAt: null,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branch: expect.objectContaining({
            create: expect.objectContaining({
              headShaObservedAt: observedAt,
              lastActivityAt: null,
            }),
          }),
        }),
      })
    );
  });

  it("preserves the head-observation activity fallback when activity is omitted", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");

    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "head-sha",
      headShaObservedAt: observedAt,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branch: expect.objectContaining({
            create: expect.objectContaining({
              headShaObservedAt: observedAt,
              lastActivityAt: observedAt,
            }),
          }),
        }),
      })
    );
  });

  it("does not advance existing-Branch activity from a receipt-only head change", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");
    mockTx.branchDetail.findUnique.mockResolvedValue(
      existingBranchDetail("old-head", BranchHeadShaSource.HarnessInput)
    );

    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "new-head",
      headShaSource: BranchHeadShaSource.PullRequestWebhook,
      headShaObservedAt: observedAt,
      activityAt: null,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("preserves the observed-time fallback for an existing same-SHA push", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");
    mockTx.branchDetail.findUnique.mockResolvedValue(
      existingBranchDetail("same-head", BranchHeadShaSource.HarnessInput)
    );

    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      beforeSha: "prior-head",
      headSha: "same-head",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: observedAt } }],
      },
      data: { lastActivityAt: observedAt },
    });
  });

  it("authorizes a fork head through its verified PR base repository", async () => {
    mockTx.pullRequestDetail.findFirst.mockResolvedValue({
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
    });
    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryId: null,
      pullRequestRepositoryId: "base-repo-1",
      pullRequestBaseRepositoryFullName: "ClosedLoop-AI/Primary.git",
      pullRequest: {
        githubId: "pr-1",
        number: 17,
        title: "Fork contribution",
        htmlUrl: "https://github.com/closedloop-ai/primary/pull/17",
        state: GitHubPRState.Open,
        headRepositoryObservation: baseInput.repositoryDefaultObservation,
      },
    });

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalled();
    expect(mockTx.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ repositoryId: "base-repo-1" }),
      })
    );
    expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRepositoryFullName: "closedloop-ai/sidecar",
          headRepositoryDefaultBranchName: "main",
        }),
      })
    );
    // A branch link never rewrites the source's repository snapshot.
    expect(mockTx.documentDetail.updateMany).not.toHaveBeenCalled();
  });

  // ISS-8155. This upsert is the chokepoint for every lane that materializes a
  // branch AND its PR in one call — the webhook's first-sighting path
  // (pull-request-branch-materialization) and the link-an-existing-PR route
  // among them. It stamped `branch_detail.base_branch` from the caller's base
  // and left `pull_request_detail.base_ref_name` NULL, so a brand-new PR read as
  // "base unknown" while the base ref sat in the row next to it.
  it("stamps the PR's base ref when the caller's base came from a PR base", async () => {
    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      baseBranch: "release/24",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      pullRequest: {
        githubId: "pr-8155",
        number: 42,
        title: "Base ref reaches the PR row",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/42",
        state: GitHubPRState.Open,
        authorLogin: "octocat",
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      },
    });

    expect(result.ok).toBe(true);
    expect(mockTx.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          baseRefName: "release/24",
          authorLogin: "octocat",
          authorProviderUserId: "123",
          authorActorType: GitHubActorType.User,
        }),
        update: expect.objectContaining({
          baseRefName: "release/24",
          authorLogin: "octocat",
          authorProviderUserId: "123",
          authorActorType: GitHubActorType.User,
        }),
      })
    );
    expect(ensurePullRequestAuthorIdentity).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        organizationId: baseInput.organizationId,
        githubId: "pr-8155",
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      })
    );
  });

  // The opposite state of the same predicate. A branch base the caller took from
  // a harness input is not evidence about any pull request, so copying it onto
  // the PR row would be the borrowed value ISS-8155 removed from the read.
  it("stores no PR base ref when the caller's base did not come from a PR base", async () => {
    allowBranchRepoInSourceSnapshot(mockTx);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      baseBranch: "release/24",
      baseBranchSource: BranchBaseBranchSource.HarnessInput,
      pullRequest: {
        githubId: "pr-8155",
        number: 42,
        title: "Base ref reaches the PR row",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/42",
        state: GitHubPRState.Open,
      },
    });

    expect(result.ok).toBe(true);
    const [call] = mockTx.pullRequestDetail.upsert.mock.calls;
    expect(call[0].create.baseRefName).toBeNull();
    // Omission-preserving: it must not NULL a value a richer producer stored.
    expect(call[0].update).not.toHaveProperty("baseRefName");
    expect(call[0].update).not.toHaveProperty("authorProviderUserId");
    expect(call[0].update).not.toHaveProperty("authorActorType");
  });

  it("does not trust a legacy raw source-repo allowlist", async () => {
    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      sourceArtifactTargetRepoAllowlist: ["closedloop-ai/sidecar"],
    } as UpsertBranchArtifactInput & {
      sourceArtifactTargetRepoAllowlist: string[];
    });

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
    expect(mockTx.artifactLink.upsert).not.toHaveBeenCalled();
  });

  it("rejects a wrong-scope source artifact", async () => {
    mockTx.artifact.findFirst.mockResolvedValueOnce(null);

    const result = await branchService.upsertBranchArtifact(baseInput);

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
    expect(mockTx.artifactLink.upsert).not.toHaveBeenCalled();
  });

  it("does not fall back to stored authority for a fresh unavailable observation", async () => {
    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryDefaultObservation: {
        unavailable: repositoryDefaultUnavailableObservationValidator.parse({
          reason: RepositoryDefaultReason.ProviderError,
          provenance: {
            source: RepositoryDefaultSource.PullRequestRest,
            mechanism: GitHubFetchMechanism.Rest,
            trigger: GitHubFetchTrigger.UserAction,
            credentialType: GitHubFetchCredentialType.GitHubApp,
            observationKey: "failed-observation",
            observedAt: "2026-08-11T13:00:00.000Z",
          },
        }),
      },
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(mockTx.$queryRaw).toHaveBeenCalled();
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
  });

  it("ignores a falsified legacy defaultBranch assertion", async () => {
    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      branchName: "main",
      defaultBranch: "develop",
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
  });
});

function persistedRepositoryAuthority() {
  return {
    githubRepoId: "123",
    fullName: "closedloop-ai/sidecar",
    defaultBranchName: "main",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: "persisted-observation",
    defaultBranchObservedAt: new Date("2026-08-11T11:00:00.000Z"),
    defaultBranchEventAt: null,
  };
}

function existingBranchDetail(
  headSha: string,
  headShaSource: BranchHeadShaSource
) {
  return {
    artifactId: "branch-artifact-1",
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/sidecar",
    branchName: "symphony/fea-1132-sidecar",
    baseBranch: "main",
    baseBranchSource: BranchBaseBranchSource.HarnessInput,
    headSha,
    headShaSource,
    headShaObservedAt: new Date("2026-08-12T19:00:00.000Z"),
    lastPushBeforeSha: null,
    firstPushedAt: null,
    pushSource: null,
    deletedAt: null,
    artifact: { createdById: null, status: GitHubPRState.Open },
  };
}

describe("branchService.deleteBranchArtifact", () => {
  const validUuid = "11111111-1111-4111-8111-111111111111";
  let mockDb: {
    artifact: {
      deleteMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      artifact: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDbAll(mockDb);
  });

  it("deletes a branch artifact with a single org- and type-scoped query", async () => {
    const deleted = await branchService.deleteBranchArtifact(
      validUuid,
      "org-1"
    );

    expect(deleted).toBe(true);
    expect(mockDb.artifact.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.deleteMany).toHaveBeenCalledWith({
      where: {
        id: validUuid,
        organizationId: "org-1",
        type: ArtifactType.BRANCH,
      },
    });
  });

  it("returns false when nothing matches (missing, wrong org, or non-branch artifact)", async () => {
    mockDb.artifact.deleteMany.mockResolvedValue({ count: 0 });

    const deleted = await branchService.deleteBranchArtifact(
      validUuid,
      "org-1"
    );

    expect(deleted).toBe(false);
  });

  it("is idempotent under a concurrent double-delete instead of throwing", async () => {
    mockDb.artifact.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([
      branchService.deleteBranchArtifact(validUuid, "org-1"),
      branchService.deleteBranchArtifact(validUuid, "org-1"),
    ]);

    expect([first, second].sort()).toEqual([false, true]);
  });

  it("rejects a non-UUID id without touching the database", async () => {
    const deleted = await branchService.deleteBranchArtifact("PRD-42", "org-1");

    expect(deleted).toBe(false);
    expect(mockDb.artifact.deleteMany).not.toHaveBeenCalled();
  });
});

function createMockTx() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi
      .fn()
      .mockImplementation((query: { sql?: string }) =>
        Promise.resolve(
          query.sql?.includes("public_repositories")
            ? []
            : [persistedRepositoryAuthority()]
        )
      ),
    artifact: {
      findFirst: vi.fn().mockResolvedValue({
        id: "source-1",
        document: {
          repositorySnapshot: {
            repositories: [
              {
                fullName: "closedloop-ai/primary",
                role: RepositoryRole.Primary,
                position: 0,
              },
            ],
            source: SnapshotSource.ProjectDefaults,
          },
        },
      }),
      create: vi.fn().mockResolvedValue({ id: "branch-artifact-1" }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({
        id: "branch-artifact-1",
        pullRequest: null,
        branch: null,
      }),
    },
    branchDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchStatusCheck: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // A branch link must never write the source's snapshot; tests assert this
    // stays uncalled.
    documentDetail: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    gitHubInstallationRepository: {
      findMany: vi.fn().mockResolvedValue([persistedRepositoryAuthority()]),
    },
    publicRepository: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pullRequestDetail: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({
        id: "pr-detail-1",
        branchArtifactId: "branch-artifact-1",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    artifactLink: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "link-1" }),
    },
  };
}

/**
 * Make the source artifact's repository snapshot name the branch repository,
 * so the source-artifact gate admits the write. The base fixture's snapshot
 * names only `closedloop-ai/primary`, which the gate rejects.
 */
function allowBranchRepoInSourceSnapshot(
  tx: ReturnType<typeof createMockTx>
): void {
  tx.artifact.findFirst.mockResolvedValue({
    id: "source-1",
    document: {
      repositorySnapshot: {
        repositories: [
          {
            fullName: "closedloop-ai/primary",
            role: RepositoryRole.Primary,
            position: 0,
          },
          {
            fullName: "closedloop-ai/sidecar",
            role: RepositoryRole.Additional,
            position: 1,
          },
        ],
        source: SnapshotSource.ProjectDefaults,
      },
    },
  });
}
