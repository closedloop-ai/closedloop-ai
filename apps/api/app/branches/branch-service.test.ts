import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN", PENDING: "PENDING" },
  });
});

import { BranchBaseBranchSource, LinkType } from "@repo/api/src/types/artifact";
import { RepositoryRole, SnapshotSource } from "@repo/api/src/types/document";
import { Result, Status } from "@repo/api/src/types/result";
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
        findUnique: vi.fn().mockResolvedValue({
          id: "branch-artifact-1",
          pullRequest: null,
          branch: null,
        }),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
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
      select: { document: { select: { repositorySnapshot: true } } },
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
});

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
