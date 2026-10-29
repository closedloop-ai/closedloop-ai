import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: vi.fn() },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  branchProviderFallbackService: { findByIds: vi.fn() },
}));

vi.mock("@/app/tags/tag-projection-select", () => ({
  mapTagRelations: vi.fn(() => []),
}));

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: { getValuesForEntity: vi.fn(async () => []) },
}));

// The tree reports the placement fence from the placement owner, whose own
// reads are covered by its tests and the Postgres placement suites.
vi.mock("@/app/documents/project-artifact-placement-state", () => ({
  readProjectPlacementVersion: vi.fn(async () => "placement-version"),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ProjectTreeCategory } from "@repo/api/src/types/project-tree";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { makeSequencedProducesLinkFactory } from "@/__tests__/support/artifacts/project-tree.test-fixtures";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { basicUserSelect } from "@/lib/db-utils";
import { mockWithDbAll } from "../../__tests__/utils/db-helpers";
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
    mockWithDbAll(mockDb);
    vi.mocked(branchProductEligibilityService.findByIds).mockResolvedValue(
      new Map()
    );
    vi.mocked(branchProviderFallbackService.findByIds).mockResolvedValue(
      new Set()
    );
  });

  it("projects API-owned provider fallback availability onto Branch rows", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(branchId, ArtifactType.BRANCH, 1000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    vi.mocked(branchProviderFallbackService.findByIds).mockResolvedValue(
      new Set([branchId])
    );

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.nodes[0]?.root.hasCompatibilityProviderFallback).toBe(true);
  });

  it("advertises status mutation capability on document tree rows only", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
      makeArtifact(branchId, ArtifactType.BRANCH, 2000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.nodes[0]?.root.statusMutation).toEqual({
      allowedStatuses: [
        DocumentStatus.Draft,
        DocumentStatus.InReview,
        DocumentStatus.ChangesRequested,
        DocumentStatus.Approved,
        DocumentStatus.Executed,
        DocumentStatus.Obsolete,
      ],
      expectedStatusField: "expectedStatus",
      expectedStatusByIdField: "expectedStatusById",
    });
    expect(result.nodes[1]?.root.statusMutation).toBeUndefined();
  });

  it("projects API-owned eligibility onto Branch rows", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(branchId, ArtifactType.BRANCH, 1000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    vi.mocked(branchProductEligibilityService.findByIds).mockResolvedValue(
      new Map([[branchId, BranchProductEligibility.Eligible]])
    );

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.nodes[0]?.root.productEligibility).toBe(
      BranchProductEligibility.Eligible
    );
    expect(branchProductEligibilityService.findByIds).toHaveBeenCalledWith(
      organizationId,
      [branchId]
    );
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

  it("keeps flag-off child neighborhoods in canonical link order", async () => {
    const childA = "77777777-7777-7777-8777-777777777771";
    const childB = "77777777-7777-7777-8777-777777777772";
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 0),
      makeArtifact(childA, ArtifactType.DOCUMENT, 2000, {
        createdAt: new Date("2026-07-05T00:00:00.000Z"),
      }),
      makeArtifact(childB, ArtifactType.DOCUMENT, 1000, {
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      { ...makeArtifactLink(documentId, childA), sortOrder: 2000 },
      { ...makeArtifactLink(documentId, childB), sortOrder: 1000 },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.children.map(({ id }) => id)).toEqual([
      childA,
      childB,
    ]);
  });

  it("AC-007 orders each flag-on child neighborhood by the canonical rank comparator", async () => {
    const childA = "77777777-7777-7777-8777-777777777771";
    const childB = "77777777-7777-7777-8777-777777777772";
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 0),
      makeArtifact(childA, ArtifactType.DOCUMENT, 2000),
      makeArtifact(childB, ArtifactType.DOCUMENT, 1000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      { ...makeArtifactLink(documentId, childA), sortOrder: 2000 },
      { ...makeArtifactLink(documentId, childB), sortOrder: 1000 },
    ]);

    const result = await projectTreeService.getManuallyOrderedProjectTree(
      projectId,
      organizationId,
      {}
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.children.map(({ id }) => id)).toEqual([
      childB,
      childA,
    ]);
  });

  it("orders unplaced flag-on children oldest first after ranked children with a stable tie", async () => {
    const ranked = "77777777-7777-7777-8777-777777777770";
    const older = "77777777-7777-7777-8777-777777777771";
    const tiedHigh = "77777777-7777-7777-8777-777777777773";
    const tiedLow = "77777777-7777-7777-8777-777777777772";
    const newer = "77777777-7777-7777-8777-777777777774";
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 0),
      makeArtifact(newer, ArtifactType.DOCUMENT, 0, {
        createdAt: new Date("2026-07-05T00:00:00.000Z"),
      }),
      makeArtifact(tiedHigh, ArtifactType.DOCUMENT, 0, {
        createdAt: new Date("2026-07-03T00:00:00.000Z"),
      }),
      makeArtifact(ranked, ArtifactType.DOCUMENT, 0, {
        createdAt: new Date("2026-07-06T00:00:00.000Z"),
      }),
      makeArtifact(older, ArtifactType.DOCUMENT, 0, {
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
      makeArtifact(tiedLow, ArtifactType.DOCUMENT, 0, {
        createdAt: new Date("2026-07-03T00:00:00.000Z"),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      { ...makeArtifactLink(documentId, newer), sortOrder: null },
      { ...makeArtifactLink(documentId, tiedHigh), sortOrder: null },
      { ...makeArtifactLink(documentId, ranked), sortOrder: 1000 },
      { ...makeArtifactLink(documentId, older), sortOrder: null },
      { ...makeArtifactLink(documentId, tiedLow), sortOrder: null },
    ]);

    const result = await projectTreeService.getManuallyOrderedProjectTree(
      projectId,
      organizationId,
      {}
    );

    expect(result.nodes[0]?.children.map(({ id }) => id)).toEqual([
      ranked,
      older,
      tiedLow,
      tiedHigh,
      newer,
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

  it("promotes a category match after the unfiltered bound and preserves its parent context", async () => {
    mockDb.$queryRaw
      .mockResolvedValueOnce([
        { hierarchySeed: "hierarchy", mutationSeed: "mutation" },
      ])
      .mockResolvedValueOnce([
        hierarchyRow(documentId, branchId, "2026-10-20T02:00:00.000Z"),
      ])
      .mockResolvedValueOnce([]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 1000, {
        subtype: ArtifactSubtype.PRD,
      }),
      makeArtifact(branchId, ArtifactType.BRANCH, 0),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeArtifactLink(branchId, documentId),
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds, hierarchy: true, limit: 1 }
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.root.id).toBe(documentId);
    expect(result.nodes[0]?.children).toEqual([]);
    expect(result.nodes[0]?.hierarchy).toMatchObject({
      childCount: 0,
      hierarchyPath: [documentId],
    });
    expect(result.flatParents).toEqual([
      expect.objectContaining({
        childId: documentId,
        parent: expect.objectContaining({ id: branchId }),
      }),
    ]);
  });

  /**
   * ISS-8857 regression. The detailed read used to select this exact scope
   * TWICE — once for the tree with its assignee, once again purely to reach
   * `tagArtifacts` — and re-join the two row sets through a `Map`. Asserting
   * the returned tree alone stays green when that second pass comes back, so
   * this test asserts the QUERY COUNT: the artifact scope is read once, and the
   * tags arrive keyed by the ids that read already returned.
   */
  it("selects the project artifact scope exactly once for a detailed read", async () => {
    const contributorScopedWhere = {
      OR: [{ type: { not: ArtifactType.BRANCH } }, { id: { in: [branchId] } }],
      projectId,
      organizationId,
    };
    mockDb.$queryRaw.mockResolvedValue([{ id: branchId }]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(documentId, ArtifactType.DOCUMENT, 1000),
      makeArtifact(branchId, ArtifactType.BRANCH, 2000),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.tagArtifact.findMany.mockResolvedValue([]);
    mockDb.documentDetail.findMany.mockResolvedValue([
      { artifactId: documentId, latestVersion: 7 },
    ]);

    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId,
      { contributorUserId }
    );

    expect(
      result.nodes.find((node) => node.root.id === documentId)?.root
        .currentVersion
    ).toBe(7);
    expect(
      result.nodes.find((node) => node.root.id === documentId)?.root
        .customFieldValues
    ).toEqual([]);
    expect(
      result.nodes.find((node) => node.root.id === branchId)?.root
    ).not.toHaveProperty("currentVersion");
    expect(
      result.nodes.find((node) => node.root.id === branchId)?.root
    ).not.toHaveProperty("customFieldValues");
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
      where: contributorScopedWhere,
      include: { assignee: basicUserSelect },
    });
    expect(mockDb.tagArtifact.findMany).toHaveBeenCalledWith({
      where: { artifactId: { in: [documentId, branchId] } },
      include: { tag: true },
    });
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
    documentDetail: { findMany: vi.fn().mockResolvedValue([]) },
    tagArtifact: {
      findMany: vi.fn(),
    },
  };
}

function makeArtifact(
  id: string,
  type: ArtifactType,
  sortOrder: number,
  overrides: {
    createdAt?: Date;
    projectId?: string;
    subtype?: ArtifactSubtype;
  } = {}
) {
  return {
    id,
    organizationId,
    projectId: overrides.projectId ?? projectId,
    type,
    subtype: overrides.subtype ?? null,
    name: id,
    status: DocumentStatus.Draft,
    sortOrder,
    createdAt: overrides.createdAt ?? new Date("2026-07-03T00:00:00.000Z"),
    assignee: null,
  };
}

function hierarchyRow(
  id: string,
  parentId: string | null,
  createdAt: string,
  sortOrder = 10
) {
  return {
    createdAt: new Date(createdAt),
    id,
    parentId,
    projectId,
    sortOrder,
  };
}

const makeArtifactLink = makeSequencedProducesLinkFactory();
