/**
 * The tree's `category` population filter, and the property that makes it the
 * fix for filter-after-paginate: it applies BEFORE the `limit` bound.
 *
 * The defect it regresses against: the client filtered the BOUNDED read, so
 * `?limit=` counted mixed roots. A project whose PRDs all ranked past the
 * bound reported "no PRDs" ("1–9 of 9+ PRDs — counted from the first 500
 * top-level artifacts"), and a filtered page under-filled ("1–93 of 148
 * issues" on a 100-row page). With the filter server-side, the bound and every
 * count describe the population the tab renders.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/tags/tag-projection-select", () => ({
  mapTagRelations: vi.fn(() => []),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { ArtifactSubtype, LinkType } from "@repo/api/src/types/artifact";
import { ProjectTreeCategory } from "@repo/api/src/types/project-tree";
import { ArtifactType } from "@repo/database";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { projectTreeService } from "./project-tree-service";

const projectId = "11111111-1111-7111-8111-111111111111";
const organizationId = "33333333-3333-7333-8333-333333333333";
const SAME_INSTANT = new Date("2026-08-05T12:00:00.000Z");

function createMockDb() {
  return {
    $queryRaw: vi.fn(),
    artifact: { findMany: vi.fn() },
    artifactLink: { findMany: vi.fn() },
    documentDetail: { findMany: vi.fn().mockResolvedValue([]) },
    tagArtifact: { findMany: vi.fn() },
  };
}

function makeArtifact(
  id: string,
  sortOrder: number | null,
  type: ArtifactType,
  subtype: ArtifactSubtype | null
) {
  return {
    assignee: null,
    createdAt: SAME_INSTANT,
    id,
    name: id,
    organizationId,
    projectId,
    sortOrder,
    subtype,
    type,
  };
}

/**
 * The client-visible defect shape: six branches OUTRANK three PRDs, so any
 * bound of six that counts mixed roots serves zero PRDs.
 */
function branchesAheadOfPrds() {
  return [
    ...Array.from({ length: 6 }, (_unused, i) =>
      makeArtifact(`branch-0${i}`, i, ArtifactType.BRANCH, null)
    ),
    ...Array.from({ length: 3 }, (_unused, i) =>
      makeArtifact(
        `prd-0${i}`,
        6 + i,
        ArtifactType.DOCUMENT,
        ArtifactSubtype.Prd
      )
    ),
  ];
}

function rootIds(nodes: { root: { id: string } }[]): string[] {
  return nodes.map((node) => node.root.id);
}

describe("project tree — category filter applies before the root bound", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockDb.artifact.findMany.mockResolvedValue(branchesAheadOfPrds());
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.tagArtifact.findMany.mockResolvedValue([]);
  });

  it("finds every match even when they all rank past the bound", async () => {
    // The regression case: bound 6, six branches ahead of every PRD. Bounding
    // first served zero PRDs; filtering first serves all three, unbounded.
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds, limit: 6 }
    );

    expect(rootIds(result.nodes)).toEqual(["prd-00", "prd-01", "prd-02"]);
    // Three matches fit inside a bound of six — this read is COMPLETE, and the
    // contract reserves the field's absence as the claim of completeness.
    expect(result).not.toHaveProperty("truncation");
  });

  it("bounds the FILTERED population and counts it in truncation", async () => {
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Branches, limit: 4 }
    );

    expect(rootIds(result.nodes)).toEqual([
      "branch-00",
      "branch-01",
      "branch-02",
      "branch-03",
    ]);
    // Both figures describe branches — the population the tab renders — never
    // the project's mixed root count.
    expect(result.truncation).toMatchObject({
      anchorsIncluded: 4,
      anchorsMatchedAtLeast: 6,
    });
  });

  it("splits DOCUMENT artifacts by persisted subtype, one category each", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact("prd", 0, ArtifactType.DOCUMENT, ArtifactSubtype.Prd),
      makeArtifact("issue", 1, ArtifactType.DOCUMENT, ArtifactSubtype.Feature),
      makeArtifact(
        "plan",
        2,
        ArtifactType.DOCUMENT,
        ArtifactSubtype.ImplementationPlan
      ),
      // Neither TEMPLATE nor DOC belongs to any filtered tab.
      makeArtifact("tmpl", 3, ArtifactType.DOCUMENT, ArtifactSubtype.Template),
      makeArtifact("doc", 4, ArtifactType.DOCUMENT, ArtifactSubtype.Doc),
      makeArtifact("branch", 5, ArtifactType.BRANCH, null),
    ]);

    const [prds, features, plans, branches] = await Promise.all([
      projectTreeService.getProjectTree(projectId, organizationId, {
        category: ProjectTreeCategory.Prds,
      }),
      projectTreeService.getProjectTree(projectId, organizationId, {
        category: ProjectTreeCategory.Features,
      }),
      projectTreeService.getProjectTree(projectId, organizationId, {
        category: ProjectTreeCategory.Plans,
      }),
      projectTreeService.getProjectTree(projectId, organizationId, {
        category: ProjectTreeCategory.Branches,
      }),
    ]);

    expect(rootIds(prds.nodes)).toEqual(["prd"]);
    expect(rootIds(features.nodes)).toEqual(["issue"]);
    expect(rootIds(plans.nodes)).toEqual(["plan"]);
    expect(rootIds(branches.nodes)).toEqual(["branch"]);
  });

  it("promotes a nested match to a flat root, shedding its chain fields", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact("issue", 0, ArtifactType.DOCUMENT, ArtifactSubtype.Feature),
      makeArtifact("prd", 1, ArtifactType.DOCUMENT, ArtifactSubtype.Prd),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        createdAt: SAME_INSTANT,
        id: "link-1",
        linkType: LinkType.Produces,
        sourceId: "issue",
        targetId: "prd",
      },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds }
    );

    // A PRD nested under an issue chain is still a PRD the tab must find.
    expect(rootIds(result.nodes)).toEqual(["prd"]);
    expect(result.nodes[0].children).toEqual([]);
    // A promoted child must not serialize a chain position the response no
    // longer contains.
    expect(result.nodes[0].root).not.toHaveProperty("linkType");
    expect(result.nodes[0].root).not.toHaveProperty("depth");
    expect(result.nodes[0].root).not.toHaveProperty("parentId");
  });

  it("keeps the promoted match's parent as flat parent context", async () => {
    // whitlockk, PR #6745: the promotion sheds `parentId`, which is one of the two
    // things the Parent column is rebuilt from — the other being a `children`
    // array a flat root does not have. Without the parent travelling alongside
    // the flat result, this row's Parent cell is blank on a filtered tab and
    // shows "issue" on the All tab, and a tab where EVERY cell is blank drops
    // the column entirely.
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact("issue", 0, ArtifactType.DOCUMENT, ArtifactSubtype.Feature),
      makeArtifact("prd", 1, ArtifactType.DOCUMENT, ArtifactSubtype.Prd),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        createdAt: SAME_INSTANT,
        id: "link-1",
        linkType: LinkType.Produces,
        sourceId: "issue",
        targetId: "prd",
      },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds }
    );

    expect(rootIds(result.nodes)).toEqual(["prd"]);
    expect(result.flatParents).toEqual([
      {
        childId: "prd",
        linkType: LinkType.Produces,
        parent: expect.objectContaining({ id: "issue", name: "issue" }),
      },
    ]);
  });

  it("carries flat parent context on the detailed tree the page actually reads", async () => {
    // The project page's tabs read `?include=details`, so a field only the
    // plain response carried would fix the Parent column on no real surface.
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact("issue", 0, ArtifactType.DOCUMENT, ArtifactSubtype.Feature),
      makeArtifact("prd", 1, ArtifactType.DOCUMENT, ArtifactSubtype.Prd),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        createdAt: SAME_INSTANT,
        id: "link-1",
        linkType: LinkType.Produces,
        sourceId: "issue",
        targetId: "prd",
      },
    ]);

    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds }
    );

    expect(result.flatParents?.map((entry) => entry.childId)).toEqual(["prd"]);
  });

  it("omits flat parent context entirely on an unfiltered read", async () => {
    // Absence, not `[]`: the unfiltered response must stay key-for-key what it
    // was before the field existed, so a client that predates it is unaffected.
    const unfiltered = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      {}
    );

    expect(unfiltered).not.toHaveProperty("flatParents");
  });

  it("drops flat parent context for a match the bound cut", async () => {
    // Same contract `externalParents` is narrowed by: an entry names a childId
    // the response promises to carry, and one whose child was bounded away
    // would leave the client resolving a parent for a row it never received.
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact("issue", 0, ArtifactType.DOCUMENT, ArtifactSubtype.Feature),
      makeArtifact("prd-00", 1, ArtifactType.DOCUMENT, ArtifactSubtype.Prd),
      makeArtifact("prd-01", 2, ArtifactType.DOCUMENT, ArtifactSubtype.Prd),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        createdAt: SAME_INSTANT,
        id: "link-1",
        linkType: LinkType.Produces,
        sourceId: "issue",
        targetId: "prd-00",
      },
      {
        createdAt: new Date(SAME_INSTANT.getTime() + 1),
        id: "link-2",
        linkType: LinkType.Produces,
        sourceId: "issue",
        targetId: "prd-01",
      },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds, limit: 1 }
    );

    expect(rootIds(result.nodes)).toEqual(["prd-00"]);
    expect(result.flatParents?.map((entry) => entry.childId)).toEqual([
      "prd-00",
    ]);
  });

  it("returns each match once even when reachable through several chains", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(
        "issue-a",
        0,
        ArtifactType.DOCUMENT,
        ArtifactSubtype.Feature
      ),
      makeArtifact(
        "issue-b",
        1,
        ArtifactType.DOCUMENT,
        ArtifactSubtype.Feature
      ),
      makeArtifact("branch", 2, ArtifactType.BRANCH, null),
    ]);
    // Both issues PRODUCE the same branch, so it is a child in two subtrees.
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        createdAt: SAME_INSTANT,
        id: "link-1",
        linkType: LinkType.Produces,
        sourceId: "issue-a",
        targetId: "branch",
      },
      {
        createdAt: new Date(SAME_INSTANT.getTime() + 1),
        id: "link-2",
        linkType: LinkType.Produces,
        sourceId: "issue-b",
        targetId: "branch",
      },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Branches }
    );

    expect(rootIds(result.nodes)).toEqual(["branch"]);
  });

  it("leaves the read untouched when no category is given", async () => {
    const unfiltered = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      {}
    );

    // Nine mixed roots, nesting preserved — byte-identical to the read every
    // caller issued before the parameter existed.
    expect(unfiltered.nodes).toHaveLength(9);
    expect(unfiltered).not.toHaveProperty("truncation");
  });

  it("keeps only external-parent entries whose child survived the filter", async () => {
    const externalParentId = "99999999-9999-7999-8999-999999999999";
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        createdAt: SAME_INSTANT,
        id: "link-ext",
        linkType: LinkType.Produces,
        sourceId: externalParentId,
        targetId: "branch-00",
      },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds }
    );

    // The contract promises every `childId` is present in `nodes`; the branch
    // this entry points at was filtered away with its category.
    const returnedRootIds = new Set(rootIds(result.nodes));
    for (const entry of result.externalParents) {
      expect(returnedRootIds.has(entry.childId)).toBe(true);
    }
  });

  it("filters the detailed (`?include=details`) tree the same way", async () => {
    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds, limit: 6 }
    );

    expect(rootIds(result.nodes)).toEqual(["prd-00", "prd-01", "prd-02"]);
    expect(result).not.toHaveProperty("truncation");
  });
});
