import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/branches/branch-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/branch-service")
  >("@/app/branches/branch-service");
  return {
    ...actual,
    branchService: {
      upsertBranchArtifact: vi.fn(),
    },
  };
});

import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { LoopBranchMaterializationRole } from "@repo/api/src/types/loop-body";
import { Result, Status } from "@repo/api/src/types/result";
import { GitHubInstallationStatus, LoopStatus } from "@repo/database";
import {
  branchService,
  SourceArtifactTargetRepoAuthorizationProvenance,
} from "@/app/branches/branch-service";
import { getMockWithDb } from "../../../../__tests__/utils/db-helpers";
import {
  createLoopBranchArtifact,
  loopBranchArtifactSchema,
} from "./branch-artifact-service";

const LOOP_ID = "loop-1";
const ORG_ID = "org-1";

const loopRow = {
  artifactId: "plan-1",
  status: LoopStatus.RUNNING,
  repo: { fullName: "closedloop-ai/symphony-alpha", branch: "main" },
  additionalRepos: [{ fullName: "closedloop-ai/sidecar", branch: "sidecar" }],
  metadata: {
    branchMaterialization: {
      schemaVersion: 1,
      branches: [
        {
          role: LoopBranchMaterializationRole.Primary,
          repositoryFullName: "closedloop-ai/symphony-alpha",
          baseBranch: "main",
          branchName: "symphony/fea-1116",
        },
        {
          role: LoopBranchMaterializationRole.Additional,
          repositoryFullName: "closedloop-ai/sidecar",
          baseBranch: "sidecar",
          branchName: "symphony/fea-1116-closedloop-ai-sidecar-d142fc80",
        },
      ],
    },
  },
};

const repoRow = {
  id: "repo-1",
  fullName: "closedloop-ai/symphony-alpha",
};

const sourceArtifactRow = {
  projectId: "project-1",
};

function body(overrides = {}) {
  return {
    repositoryFullName: "closedloop-ai/symphony-alpha",
    branchName: "symphony/fea-1116",
    defaultBranch: "main",
    baseBranch: "main",
    headSha: "abc123def456abc123def456abc123def456abcd",
    ...overrides,
  };
}

describe("createLoopBranchArtifact", () => {
  const mockWithDb = getMockWithDb();

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce(loopRow)
      .mockResolvedValueOnce(repoRow)
      .mockResolvedValueOnce(sourceArtifactRow);
    vi.mocked(branchService.upsertBranchArtifact).mockResolvedValue(
      Result.ok({ id: "branch-artifact-1" } as never)
    );
  });

  it("derives source/project/repo from the loop context", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.ok({ id: "branch-artifact-1" }));
    expect(branchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        repositoryId: "repo-1",
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "symphony/fea-1116",
        projectId: "project-1",
        sourceArtifactId: "plan-1",
        sourceArtifactTargetRepoAuthorization: {
          provenance:
            SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
          repositoryFullNames: [
            "closedloop-ai/symphony-alpha",
            "closedloop-ai/sidecar",
          ],
        },
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
        headSha: "abc123def456abc123def456abc123def456abcd",
        headShaSource: BranchHeadShaSource.HarnessInput,
      })
    );
  });

  it("accepts an additional repo callback only through its additional materialization entry", async () => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce(loopRow)
      .mockResolvedValueOnce({
        id: "repo-sidecar",
        fullName: "closedloop-ai/sidecar",
      })
      .mockResolvedValueOnce(sourceArtifactRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({
        repositoryFullName: "closedloop-ai/sidecar",
        branchName: "symphony/fea-1116-closedloop-ai-sidecar-d142fc80",
        baseBranch: "sidecar",
      }),
    });

    expect(result).toEqual(Result.ok({ id: "branch-artifact-1" }));
    expect(branchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo-sidecar",
        repositoryFullName: "closedloop-ai/sidecar",
        branchName: "symphony/fea-1116-closedloop-ai-sidecar-d142fc80",
        baseBranch: "sidecar",
      })
    );
  });

  it("keeps headSha optional and permissive at the schema boundary for legacy callbacks", () => {
    const parsed = loopBranchArtifactSchema.safeParse(
      body({ headSha: "not-a-sha" })
    );

    expect(parsed.success).toBe(true);
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects invalid headSha for server-owned branch materialization", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({ headSha: "not-a-sha" }),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects a branch mismatch for an otherwise allowed repo", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({ branchName: "wrong-branch" }),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects a base branch mismatch for an otherwise allowed repo", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({ baseBranch: "release" }),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects repos absent from the loop context", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({ repositoryFullName: "closedloop-ai/unlisted" }),
    });

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects default branch materialization before touching branchService", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({ branchName: "main", defaultBranch: "main" }),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects malformed stored additional repos before mutation", async () => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce({ ...loopRow, additionalRepos: [{ bad: true }] })
      .mockResolvedValueOnce(repoRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects a missing active installation repository before mutation", async () => {
    mockWithDb.mockReset();
    mockWithDb.mockResolvedValueOnce(loopRow).mockResolvedValueOnce(null);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("rejects tombstoned installation repositories before mutation", async () => {
    const repositoryDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce(loopRow)
      .mockImplementationOnce((callback) => callback(repositoryDb));

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(
      repositoryDb.gitHubInstallationRepository.findFirst
    ).toHaveBeenCalledWith({
      where: {
        fullName: "closedloop-ai/symphony-alpha",
        removedAt: null,
        installation: {
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, fullName: true },
    });
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("falls back to the legacy branch callback path when stored branch materialization is absent", async () => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce({
        ...loopRow,
        repo: {
          fullName: "closedloop-ai/symphony-alpha",
          branch: "feature/legacy",
        },
        metadata: {},
      })
      .mockResolvedValueOnce(repoRow)
      .mockResolvedValueOnce(sourceArtifactRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({
        branchName: "feature/legacy",
        baseBranch: undefined,
        headSha: undefined,
      }),
    });

    expect(result).toEqual(Result.ok({ id: "branch-artifact-1" }));
    expect(branchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "feature/legacy",
        baseBranch: null,
        baseBranchSource: null,
        headSha: null,
        headShaSource: null,
      })
    );
  });

  it("rejects server-owned branch callbacks when stored branch materialization is absent", async () => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce({ ...loopRow, metadata: {} })
      .mockResolvedValueOnce(repoRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects server-owned branch callbacks missing baseBranch or headSha", async () => {
    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body({ baseBranch: undefined, headSha: undefined }),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it.each([
    LoopStatus.FAILED,
    LoopStatus.CANCELLED,
    LoopStatus.TIMED_OUT,
  ])("accepts late branch artifact callbacks for %s loops", async (status) => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce({ ...loopRow, status })
      .mockResolvedValueOnce(repoRow)
      .mockResolvedValueOnce(sourceArtifactRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.ok({ id: "branch-artifact-1" }));
    expect(branchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "symphony/fea-1116",
        sourceArtifactId: "plan-1",
      })
    );
  });

  it("rejects completed loops before branch artifact mutation", async () => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce({ ...loopRow, status: LoopStatus.COMPLETED })
      .mockResolvedValueOnce(repoRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous stored branch materialization entries", async () => {
    mockWithDb.mockReset();
    mockWithDb
      .mockResolvedValueOnce({
        ...loopRow,
        metadata: {
          branchMaterialization: {
            schemaVersion: 1,
            branches: [
              {
                role: LoopBranchMaterializationRole.Primary,
                repositoryFullName: "closedloop-ai/symphony-alpha",
                baseBranch: "main",
                branchName: "symphony/fea-1116-a",
              },
              {
                role: LoopBranchMaterializationRole.Primary,
                repositoryFullName: "Closedloop-AI/Symphony-Alpha",
                baseBranch: "main",
                branchName: "symphony/fea-1116-b",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce(repoRow);

    const result = await createLoopBranchArtifact({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: body(),
    });

    expect(result).toEqual(Result.err(Status.BadRequest));
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });
});
