import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN", PENDING: "PENDING" },
  });
});

import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { RepositoryRole, SnapshotSource } from "@repo/api/src/types/document";
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
  repositoryDefaultAuthorityValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { Result, Status } from "@repo/api/src/types/result";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { ArtifactType } from "@repo/database";
import {
  getMockWithDb,
  mockWithDbCall,
} from "../../__tests__/utils/db-helpers";
import {
  branchService,
  SourceArtifactTargetRepoAuthorizationProvenance,
  type UpsertBranchArtifactInput,
} from "./branch-service";

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
  let mockTx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
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
      gitHubInstallationRepository: {
        findMany: vi.fn().mockResolvedValue([persistedRepositoryAuthority()]),
      },
      publicRepository: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      pullRequestDetail: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: "pr-detail-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      repositoryDefaultObservationReceipt: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifactLink: {
        upsert: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
    };
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

  it("allows loop callback authorization to supplement a source snapshot that excludes the branch repo", async () => {
    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/primary", "closedloop-ai/sidecar"],
      },
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
      },
      update: {},
    });
  });

  it("suppresses receipt-derived activity when a producer explicitly has no occurrence time", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "head-sha",
      headShaObservedAt: observedAt,
      activityAt: null,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/sidecar"],
      },
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

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "head-sha",
      headShaObservedAt: observedAt,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/sidecar"],
      },
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

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "new-head",
      headShaSource: BranchHeadShaSource.PullRequestWebhook,
      headShaObservedAt: observedAt,
      activityAt: null,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/sidecar"],
      },
    });

    expect(result.ok).toBe(true);
    expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("preserves the observed-time fallback for an existing same-SHA push", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");
    mockTx.branchDetail.findUnique.mockResolvedValue(
      existingBranchDetail("same-head", BranchHeadShaSource.HarnessInput)
    );

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      beforeSha: "prior-head",
      headSha: "same-head",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/sidecar"],
      },
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
  });

  it("does not trust a legacy raw allowlist without loop callback provenance", async () => {
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

  it("rejects supplementary authorization with the wrong provenance or repo", async () => {
    const wrongProvenanceResult = await branchService.upsertBranchArtifact({
      ...baseInput,
      sourceArtifactTargetRepoAuthorization: {
        provenance: "public_route" as never,
        repositoryFullNames: ["closedloop-ai/sidecar"],
      },
    });

    const wrongRepoResult = await branchService.upsertBranchArtifact({
      ...baseInput,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/other"],
      },
    });

    expect(wrongProvenanceResult).toEqual(Result.err(Status.Forbidden));
    expect(wrongRepoResult).toEqual(Result.err(Status.Forbidden));
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
    expect(mockTx.artifactLink.upsert).not.toHaveBeenCalled();
  });

  it("does not let valid-looking loop authorization rescue a wrong-scope source artifact", async () => {
    mockTx.artifact.findFirst.mockResolvedValueOnce(null);

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      sourceArtifactTargetRepoAuthorization: {
        provenance:
          SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
        repositoryFullNames: ["closedloop-ai/sidecar"],
      },
    });

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
    mockWithDbCall(mockDb);
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
