import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/documents/generation-status-helpers", () => ({
  mergeLoopStatuses: vi.fn(),
  suppressDismissedFailuresForDocumentMap: vi.fn(),
}));

vi.mock("@/app/tags/service", () => ({
  mapTagRelations: vi.fn(() => []),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { LinkType } from "@repo/api/src/types/artifact";
import { ArtifactType, withDb } from "@repo/database";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { projectTreeService } from "./project-tree-service";

const projectId = "11111111-1111-7111-8111-111111111111";
const organizationId = "33333333-3333-7333-8333-333333333333";
const contributorUserId = "22222222-2222-7222-8222-222222222222";
const documentId = "44444444-4444-7444-8444-444444444444";
const branchId = "55555555-5555-7555-8555-555555555555";
const externalProjectId = "66666666-6666-7666-8666-666666666666";

describe("projectTreeService", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
  });

  it("reads the full project tree when no contributor filter is present", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
      makeArtifact(branchId, ArtifactType.BRANCH, 2000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(withDb).toHaveBeenCalledTimes(2);
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId,
          organizationId,
        },
      })
    );
    expect(result.nodes.map((node) => node.root.id)).toEqual([
      documentId,
      branchId,
    ]);
  });

  it("keeps non-branch artifacts while filtering branch roots by contributor writes", async () => {
    mockDb.$queryRaw.mockResolvedValue([{ id: branchId }]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
      makeArtifact(branchId, ArtifactType.BRANCH, 2000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { contributorUserId }
    );

    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { type: { not: ArtifactType.BRANCH } },
            { id: { in: [branchId] } },
          ],
          projectId,
          organizationId,
        },
      })
    );
    expect(result.nodes.map((node) => node.root.id)).toEqual([
      documentId,
      branchId,
    ]);
  });

  it("resolves contributor branch ids once for detailed tree reads", async () => {
    mockDb.$queryRaw.mockResolvedValue([{ id: branchId }]);
    mockDb.artifact.findMany
      .mockResolvedValueOnce([
        makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
        makeArtifact(branchId, ArtifactType.BRANCH, 2000),
      ])
      .mockResolvedValueOnce([
        makeArtifactViewRow(documentId, ArtifactType.DOCUMENT),
        makeArtifactViewRow(branchId, ArtifactType.BRANCH),
      ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId,
      { contributorUserId }
    );

    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          OR: [
            { type: { not: ArtifactType.BRANCH } },
            { id: { in: [branchId] } },
          ],
          projectId,
          organizationId,
        },
      })
    );
    expect(mockDb.artifact.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          OR: [
            { type: { not: ArtifactType.BRANCH } },
            { id: { in: [branchId] } },
          ],
          projectId,
          organizationId,
        },
      })
    );
    expect(result.nodes.map((node) => node.root.id)).toEqual([
      documentId,
      branchId,
    ]);
  });

  it("does not expose same-project filtered branches as external parents", async () => {
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.artifact.findMany
      .mockResolvedValueOnce([
        makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
      ])
      .mockResolvedValueOnce([
        makeArtifact(branchId, ArtifactType.BRANCH, 500),
      ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeArtifactLink(branchId, documentId),
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { contributorUserId }
    );

    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.nodes.map((node) => node.root.id)).toEqual([documentId]);
    expect(result.externalParents).toEqual([]);
  });

  it("requires contributor visibility for external branch parents", async () => {
    const externalBranch = makeArtifact(branchId, ArtifactType.BRANCH, 500, {
      projectId: externalProjectId,
    });
    mockDb.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.artifact.findMany
      .mockResolvedValueOnce([
        makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
      ])
      .mockResolvedValueOnce([externalBranch]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeArtifactLink(branchId, documentId),
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { contributorUserId }
    );

    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
    expect(result.externalParents).toEqual([]);
  });
});

function createMockDb() {
  return {
    $queryRaw: vi.fn(),
    artifact: {
      findMany: vi.fn(),
    },
    artifactLink: {
      findMany: vi.fn(),
    },
  };
}

function makeArtifact(
  id: string,
  type: ArtifactType,
  sortOrder: number,
  overrides: { projectId?: string } = {}
) {
  return {
    id,
    organizationId,
    projectId: overrides.projectId ?? projectId,
    type,
    name: id,
    sortOrder,
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    assignee: null,
  };
}

function makeArtifactLink(sourceId: string, targetId: string) {
  return {
    sourceId,
    targetId,
    linkType: LinkType.Produces,
  };
}

function makeArtifactViewRow(id: string, type: ArtifactType) {
  return {
    id,
    type,
    tagArtifacts: [],
  };
}
