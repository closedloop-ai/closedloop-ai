import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-12552: writing a source link derives implementation evidence, a store
// this suite does not exercise.
vi.mock(
  "@/app/agent-sessions/service/attribution/derive-implementation-evidence",
  () => ({ deriveImplementationEvidence: vi.fn() })
);
vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN", PENDING: "PENDING" },
  });
});

import {
  BranchBaseBranchSource,
  BranchPushSource,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { Result, Status } from "@repo/api/src/types/result";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import {
  branchService,
  type UpsertBranchArtifactInput,
} from "./branch-service";

const baseInput: UpsertBranchArtifactInput = {
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
  baseBranch: "main",
  baseBranchSource: BranchBaseBranchSource.HarnessInput,
};

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

function existingBranchDetail() {
  return {
    artifactId: "branch-artifact-1",
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/sidecar",
    branchName: "symphony/fea-1132-sidecar",
    baseBranch: "main",
    baseBranchSource: BranchBaseBranchSource.HarnessInput,
    headSha: "existing-head",
    headShaSource: null,
    headShaObservedAt: new Date("2026-08-12T19:00:00.000Z"),
    lastPushBeforeSha: null,
    firstPushedAt: null,
    pushSource: null,
    deletedAt: null,
    artifact: { createdById: "creator-1", status: GitHubPRState.Open },
  };
}

type PersistedAuthorityRow = ReturnType<typeof persistedRepositoryAuthority>;

/** What the `Prisma.sql` double in `mock-modules.ts` produces. */
type FakeSql = { strings: readonly string[]; values: unknown[] };

/**
 * Answers the eligibility reads by the table each statement names, read from
 * its literal chunks. A raw statement this fake does not model throws.
 */
function authorityReads(rows: {
  installationRepositories: PersistedAuthorityRow[];
  publicRepositories: PersistedAuthorityRow[];
}) {
  return (statement: FakeSql) => {
    const text = statement.strings.join("");
    if (text.includes("FROM public_repositories")) {
      return Promise.resolve(rows.publicRepositories);
    }
    if (text.includes("FROM github_installation_repositories")) {
      return Promise.resolve(rows.installationRepositories);
    }
    throw new Error(`branch-service fake: unmodelled raw statement: ${text}`);
  };
}

function createMockTx() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockImplementation(
      authorityReads({
        installationRepositories: [persistedRepositoryAuthority()],
        publicRepositories: [],
      })
    ),
    artifact: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "branch-artifact-1" }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({
        id: "branch-artifact-1",
        pullRequest: null,
        branch: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchStatusCheck: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
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
      upsert: vi.fn().mockResolvedValue({ id: "link-1" }),
    },
  };
}

describe("branchService.upsertBranchArtifact create path (branch pins)", () => {
  const mockWithDb = getMockWithDb();
  let mockTx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = createMockTx();
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
  });

  it("does not constrain the write when the source artifact has no parseable repository snapshot", async () => {
    mockTx.artifact.findFirst.mockResolvedValue({
      id: "source-1",
      document: { repositorySnapshot: null },
    });

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      sourceArtifactId: "source-1",
    });

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalled();
  });

  it("stamps first-pushed evidence on a brand-new branch when the create carries it", async () => {
    const firstPushedAt = new Date("2026-08-12T20:00:00.000Z");

    await branchService.upsertBranchArtifact({
      ...baseInput,
      firstPushedAt,
      pushSource: BranchPushSource.Webhook,
    });

    expect(mockTx.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branch: expect.objectContaining({
            create: expect.objectContaining({
              firstPushedAt,
              pushSource: BranchPushSource.Webhook,
            }),
          }),
        }),
      })
    );
  });

  it("stamps first-pushed evidence with a null pushSource when the create omits one", async () => {
    const firstPushedAt = new Date("2026-08-12T20:00:00.000Z");

    await branchService.upsertBranchArtifact({
      ...baseInput,
      firstPushedAt,
    });

    expect(mockTx.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branch: expect.objectContaining({
            create: expect.objectContaining({
              firstPushedAt,
              pushSource: null,
            }),
          }),
        }),
      })
    );
  });

  it("does not stamp any push evidence on create when firstPushedAt is omitted", async () => {
    await branchService.upsertBranchArtifact(baseInput);

    const created = mockTx.artifact.create.mock.calls[0][0].data.branch.create;
    expect(created).not.toHaveProperty("firstPushedAt");
    expect(created).not.toHaveProperty("pushSource");
  });

  it("skips creating a PR detail when a create carries a PR but no resolvable installation repo", async () => {
    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryId: null,
      pullRequestRepositoryId: null,
      pullRequest: {
        githubId: "pr-1",
        number: 1,
        title: "No installation repo",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/1",
        state: GitHubPRState.Open,
      },
    });

    expect(result.ok).toBe(true);
    expect(mockTx.pullRequestDetail.upsert).not.toHaveBeenCalled();
  });

  it("materializes a branch whose only persisted authority is its public repository row", async () => {
    mockTx.$queryRaw.mockImplementation(
      authorityReads({
        installationRepositories: [],
        publicRepositories: [persistedRepositoryAuthority()],
      })
    );

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryId: null,
      repositoryDefaultObservation: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalledOnce();
  });

  it("refuses the write when the installation and public repository reads disagree on the provider repository", async () => {
    mockTx.$queryRaw.mockImplementation(
      authorityReads({
        installationRepositories: [persistedRepositoryAuthority()],
        publicRepositories: [
          { ...persistedRepositoryAuthority(), githubRepoId: "456" },
        ],
      })
    );

    const result = await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryId: null,
      repositoryDefaultObservation: undefined,
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
  });

  it("leaves no PR base ref when the caller's base did not come from a PR base, even with a real value", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      baseBranch: "release/24",
      baseBranchSource: BranchBaseBranchSource.HarnessInput,
      pullRequest: {
        githubId: "pr-1",
        number: 1,
        title: "Not a PR-base branch",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/1",
        state: GitHubPRState.Open,
      },
    });

    expect(mockTx.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ baseRefName: null }),
      })
    );
  });

  it("returns NotFound when the artifact vanishes between the write and the reread", async () => {
    mockTx.artifact.findUnique.mockResolvedValue(null);

    const result = await branchService.upsertBranchArtifact(baseInput);

    expect(result).toEqual(Result.err(Status.NotFound));
  });

  it("retries once and succeeds after a unique-constraint race on the first attempt", async () => {
    mockTx.artifact.create.mockRejectedValueOnce({ code: "P2002" });

    const result = await branchService.upsertBranchArtifact(baseInput);

    expect(result.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry and rethrows a non-unique-constraint database error", async () => {
    mockTx.artifact.create.mockRejectedValueOnce(new Error("connection reset"));

    await expect(branchService.upsertBranchArtifact(baseInput)).rejects.toThrow(
      "connection reset"
    );
    expect(mockTx.artifact.create).toHaveBeenCalledTimes(1);
  });
});

describe("branchService.upsertBranchArtifactGuarded (branch pins)", () => {
  const mockWithDb = getMockWithDb();
  let mockTx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = createMockTx();
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
  });

  it("rejects the write and touches nothing when the write guard returns false", async () => {
    const guard = vi.fn().mockResolvedValue(false);

    const result = await branchService.upsertBranchArtifactGuarded(
      baseInput,
      guard
    );

    expect(result).toBeNull();
    expect(guard).toHaveBeenCalledWith(mockTx);
    expect(mockTx.artifact.create).not.toHaveBeenCalled();
  });

  it("proceeds with the write when the write guard returns true", async () => {
    const guard = vi.fn().mockResolvedValue(true);

    const result = await branchService.upsertBranchArtifactGuarded(
      baseInput,
      guard
    );

    expect(result?.ok).toBe(true);
    expect(mockTx.artifact.create).toHaveBeenCalled();
  });
});

describe("branchService.upsertBranchArtifact update path (branch pins)", () => {
  const mockWithDb = getMockWithDb();
  let mockTx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = createMockTx();
    mockTx.branchDetail.findUnique.mockResolvedValue(existingBranchDetail());
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
  });

  it("stamps push evidence on an existing branch when the update carries firstPushedAt and pushSource", async () => {
    const firstPushedAt = new Date("2026-08-13T00:00:00.000Z");

    await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "existing-head",
      firstPushedAt,
      pushSource: BranchPushSource.Webhook,
    });

    expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        OR: [{ firstPushedAt: null }, { firstPushedAt: { gt: firstPushedAt } }],
      },
      data: { firstPushedAt, pushSource: BranchPushSource.Webhook },
    });
  });

  it("does not stamp push evidence on an existing branch when the update carries only firstPushedAt", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "existing-head",
      firstPushedAt: new Date("2026-08-13T00:00:00.000Z"),
    });

    expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("does not re-parent an existing branch when the update carries no projectId", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      projectId: null,
      headSha: "existing-head",
    });

    const data = mockTx.artifact.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("projectId");
  });

  /**
   * ISS-10995 (operator ruling 2026-10-12): a SYNC-shaped producer's project is
   * a FILL, so a project set on the Details row survives the next push. The
   * measured defect: file `iss-42-foo` into project B by hand while ISS-42
   * lives in project A, and the next push put it back in A.
   *
   * The fill's predicate is the DATABASE's, not this service's — the branch row
   * is unlocked between the `findUnique` that resolves it and this write, and
   * `batch-move` commits inside that window under READ COMMITTED (davetho
   * review). So the proof is the statement's shape: an `updateMany` carrying
   * `projectId: null`, never a value this process compared.
   */
  it("fills a sync producer's project under a database predicate", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      projectId: "project-from-lineage",
      projectFillOnly: true,
      headSha: "existing-head",
    });

    // The update arm really ran: it rewrote a column it owns unconditionally.
    const data = mockTx.artifact.update.mock.calls[0][0].data;
    expect(data.name).toBe(baseInput.branchName);
    expect(data).not.toHaveProperty("projectId");
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1", projectId: null },
      data: { projectId: "project-from-lineage" },
    });
  });

  /**
   * The counterfactual for the case above, and for P1a: a producer whose
   * `projectId` is a value the CALLER chose — `POST /artifact-links/branches`
   * and the Select-PR dialog — re-files unconditionally. Discarding it would
   * answer 200 for a move that never happened.
   */
  it("re-files a branch unconditionally for a producer that is not fill-only", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      projectId: "project-chosen-by-user",
      headSha: "existing-head",
    });

    const data = mockTx.artifact.update.mock.calls[0][0].data;
    expect(data.projectId).toBe("project-chosen-by-user");
    expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
  });

  it("adopts a newly-observed installation repo id on an existing branch that had none", async () => {
    mockTx.branchDetail.findUnique.mockResolvedValue({
      ...existingBranchDetail(),
      repositoryId: null,
    });

    await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryId: "newly-observed-repo",
      headSha: "existing-head",
    });

    expect(mockTx.branchDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ repositoryId: "newly-observed-repo" }),
      })
    );
  });

  it("does not touch repositoryId on an existing branch when the update carries none", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      repositoryId: undefined,
      headSha: "existing-head",
    });

    const data = mockTx.branchDetail.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("repositoryId");
  });

  it("upserts an existing branch's PR detail when headSha is omitted, without attempting a head-authority write", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: undefined,
      pullRequestRepositoryId: "pr-repo-1",
      pullRequest: {
        githubId: "pr-1",
        number: 1,
        title: "No head sha yet",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/1",
        state: GitHubPRState.Open,
      },
    });

    expect(mockTx.pullRequestDetail.upsert).toHaveBeenCalled();
    // No repository observation on this input means
    // persistPullRequestHeadRepositoryAuthority's `resolveIncomingObservation`
    // bails before ever reading a stored row, so a null head oid never
    // reaches a compare-and-swap write in this path.
    expect(mockTx.pullRequestDetail.findFirst).not.toHaveBeenCalled();
  });

  it("closes and stamps deletedAt on an existing open branch when a non-stale delete arrives", async () => {
    const deletedAt = new Date("2026-08-12T20:00:00.000Z");

    await branchService.upsertBranchArtifact({
      ...baseInput,
      headSha: "existing-head",
      isDelete: true,
      deletedAt,
    });

    expect(mockTx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: GitHubPRState.Closed }),
      })
    );
    expect(mockTx.branchDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt }),
      })
    );
  });
});

describe("branchService.upsertBranchArtifact PR base ref resolution (branch pins)", () => {
  const mockWithDb = getMockWithDb();
  let mockTx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = createMockTx();
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
  });

  it("stores no PR base ref when the caller's base came from a PR base but carries an empty value", async () => {
    await branchService.upsertBranchArtifact({
      ...baseInput,
      baseBranch: "",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      pullRequest: {
        githubId: "pr-1",
        number: 1,
        title: "Empty PR base",
        htmlUrl: "https://github.com/closedloop-ai/sidecar/pull/1",
        state: GitHubPRState.Open,
      },
    });

    expect(mockTx.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ baseRefName: null }),
      })
    );
  });
});
