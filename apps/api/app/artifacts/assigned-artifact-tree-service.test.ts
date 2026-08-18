import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { LinkType } from "@repo/api/src/types/artifact";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { ArtifactType } from "@repo/database";
import { log } from "@repo/observability/log";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { assignedArtifactTreeService } from "./assigned-artifact-tree-service";

const ORGANIZATION_ID = "11111111-1111-7111-8111-111111111111";
const OTHER_ORGANIZATION_ID = "99999999-9999-7999-8999-999999999999";
const ASSIGNEE_ID = "22222222-2222-7222-8222-222222222222";
const PROJECT_ID = "33333333-3333-7333-8333-333333333333";
const OTHER_PROJECT_ID = "44444444-4444-7444-8444-444444444444";

const ROOT_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const MIDDLE_ID = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const ASSIGNED_ID = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const SECOND_ASSIGNED_ID = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
const THIRD_ASSIGNED_ID = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee";
const FOREIGN_PARENT_ID = "ffffffff-ffff-7fff-8fff-ffffffffffff";
const BRANCH_ID = "77777777-7777-7777-8777-777777777777";
const SESSION_ID = "88888888-8888-7888-8888-888888888888";

/**
 * Mirrors `MAX_CHAIN_DEPTH` / `MAX_TREE_ANCHORS` in the production modules.
 * Kept as local expectations rather than imported from production code so a
 * change to a production bound has to be acknowledged here instead of silently
 * satisfying its own assertion.
 */
const MAX_CHAIN_DEPTH_BOUND = 20;
const MAX_TREE_ANCHORS_BOUND = 500;
const DEEP_CHAIN_LENGTH = MAX_CHAIN_DEPTH_BOUND + 6;

type TestArtifact = {
  id: string;
  organizationId: string;
  projectId: string | null;
  assigneeId: string | null;
  type: ArtifactType;
  subtype: null;
  name: string;
  sortOrder: number | null;
  createdAt: Date;
  assignee: null;
};

type TestLink = {
  organizationId: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  createdAt: Date;
};

type ArtifactWhere = {
  organizationId: string;
  id?: { in: string[] };
};

type LinkWhere = {
  organizationId: string;
  linkType: LinkType;
  targetId?: { in: string[] };
  sourceId?: { in: string[] };
};

let mockDb: ReturnType<typeof createMockDb>;

describe("assignedArtifactTreeService.getAssignedArtifactTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
  });

  it("returns a merged org-scoped tree in a single service call, keyed by the assigned artifact's project", async () => {
    seedGraph(
      [
        artifact(ROOT_ID, { sortOrder: 100 }),
        artifact(MIDDLE_ID, { sortOrder: 200 }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 300 }),
      ],
      [link(ROOT_ID, MIDDLE_ID), link(MIDDLE_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes).toHaveLength(1);
    const [node] = result.nodes;
    expect(node?.root.id).toBe(ROOT_ID);
    expect(node?.children.map((child) => child.id)).toEqual([
      MIDDLE_ID,
      ASSIGNED_ID,
    ]);
    expect(node?.children.map((child) => child.depth)).toEqual([1, 2]);
    expect(node?.children.map((child) => child.parentId)).toEqual([
      ROOT_ID,
      MIDDLE_ID,
    ]);
    expect(node?.children.every((c) => c.linkType === LinkType.Produces)).toBe(
      true
    );
    expect(result.externalParents).toEqual([]);
    // A complete read makes no truncation claim at all — the field is absent,
    // never a `false` an older client would have to know how to read.
    expect(result.truncation).toBeUndefined();
    // The anchor query bound BOTH the caller's organization and the assignee.
    expect(anchorQueryValues()).toEqual(
      expect.arrayContaining([ORGANIZATION_ID, ASSIGNEE_ID])
    );
  });

  it("anchors on contributor branches as well as assigned artifacts", async () => {
    // A branch with NO assignee — the common shape. Under an assignee-only
    // scope this row (and the Branches stream with it) disappears entirely.
    seedGraph(
      [
        artifact(BRANCH_ID, {
          type: ArtifactType.BRANCH,
          assigneeId: null,
          sortOrder: 100,
        }),
      ],
      [],
      [BRANCH_ID]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes.map((node) => node.root.id)).toEqual([BRANCH_ID]);
    // The branch arm is in the QUERY, not just in the fixture: the anchor read
    // bound the BRANCH artifact type alongside the assignee.
    expect(anchorQueryValues()).toEqual(
      expect.arrayContaining([ArtifactType.BRANCH, ASSIGNEE_ID])
    );
  });

  it("nests the children of an anchor so an owned branch still expands", async () => {
    seedGraph(
      [
        artifact(BRANCH_ID, {
          type: ArtifactType.BRANCH,
          assigneeId: ASSIGNEE_ID,
          sortOrder: 100,
        }),
        // Someone else's session, produced by the branch the user owns. An
        // ancestors-only walk turns the branch row into a childless leaf.
        artifact(SESSION_ID, {
          type: ArtifactType.SESSION,
          assigneeId: null,
          sortOrder: 200,
        }),
      ],
      [link(BRANCH_ID, SESSION_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes.map((node) => node.root.id)).toEqual([BRANCH_ID]);
    expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
      SESSION_ID,
    ]);
    expect(result.nodes[0]?.children.map((child) => child.depth)).toEqual([1]);
  });

  it("does NOT return a cross-organization artifact reached through a parent chain", async () => {
    seedGraph(
      [
        // Same id space, different tenant: only an org-scoped `where` keeps it out.
        artifact(FOREIGN_PARENT_ID, {
          organizationId: OTHER_ORGANIZATION_ID,
          name: "another tenant's PRD",
        }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID }),
      ],
      // The link row itself is in the caller's org — the leak vector is the
      // artifact hop, which must be org-scoped at the DB layer, not filtered
      // afterwards.
      [link(FOREIGN_PARENT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    const returnedIds = collectArtifactIds(result);
    expect(returnedIds).toContain(ASSIGNED_ID);
    expect(returnedIds).not.toContain(FOREIGN_PARENT_ID);
    expect(result.externalParents).toEqual([]);
    // Every artifact read carried the caller's organization.
    for (const call of mockDb.artifact.findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe(ORGANIZATION_ID);
    }
    for (const call of mockDb.artifactLink.findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe(ORGANIZATION_ID);
    }
  });

  it("keeps the assigned artifact when its parent row is missing entirely", async () => {
    seedGraph(
      [artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID })],
      // Dangling link: the parent artifact was deleted.
      [link(ROOT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes.map((node) => node.root.id)).toEqual([ASSIGNED_ID]);
    expect(result.nodes[0]?.children).toEqual([]);
    expect(result.externalParents).toEqual([]);
  });

  it("terminates on a parent-chain cycle without duplicating a node", async () => {
    seedGraph(
      [
        artifact(ROOT_ID, { sortOrder: 100 }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 200 }),
      ],
      // A produces B and B produces A — a user-writable cycle.
      [link(ROOT_ID, ASSIGNED_ID), link(ASSIGNED_ID, ROOT_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.root.id).toBe(ROOT_ID);
    expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
      ASSIGNED_ID,
    ]);
  });

  it("records a cross-project parent as an external parent, deduped by artifact id", async () => {
    seedGraph(
      [
        artifact(ROOT_ID, { projectId: OTHER_PROJECT_ID, name: "shared root" }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 100 }),
        artifact(SECOND_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          sortOrder: 200,
        }),
      ],
      [
        link(ROOT_ID, ASSIGNED_ID),
        // Duplicate edge for the same (child, parent) pair.
        link(ROOT_ID, ASSIGNED_ID),
        link(ROOT_ID, SECOND_ASSIGNED_ID),
      ]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    // The out-of-project parent is reported as an external parent and NOT
    // promoted to a top-level row, matching the per-project tree.
    expect(result.nodes.map((node) => node.root.id)).toEqual([
      ASSIGNED_ID,
      SECOND_ASSIGNED_ID,
    ]);
    expect(
      result.externalParents.map((entry) => [entry.childId, entry.parent.id])
    ).toEqual([
      [ASSIGNED_ID, ROOT_ID],
      [SECOND_ASSIGNED_ID, ROOT_ID],
    ]);
  });

  it("keeps a same-project chain AND the external link when a child declares both parents", async () => {
    // Two declared PRODUCES parents for one child. The external edge is
    // declared FIRST, so a walk that keeps only the earliest loadable edge
    // loses the same-project chain entirely.
    seedGraph(
      [
        artifact(FOREIGN_PARENT_ID, {
          projectId: OTHER_PROJECT_ID,
          name: "parent in another project",
        }),
        artifact(ROOT_ID, { sortOrder: 100, name: "same-project parent" }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 200 }),
      ],
      [
        link(FOREIGN_PARENT_ID, ASSIGNED_ID, {
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        }),
        link(ROOT_ID, ASSIGNED_ID, {
          createdAt: new Date("2026-07-02T00:00:00.000Z"),
        }),
      ]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    // The same-project chain survives...
    expect(result.nodes.map((node) => node.root.id)).toEqual([ROOT_ID]);
    expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
      ASSIGNED_ID,
    ]);
    // ...and the external edge is still reported rather than dropped.
    expect(
      result.externalParents.map((entry) => [entry.childId, entry.parent.id])
    ).toEqual([[ASSIGNED_ID, FOREIGN_PARENT_ID]]);
  });

  it("batches the ancestor walk by depth level instead of per assigned artifact", async () => {
    seedGraph(
      [
        artifact(ROOT_ID, { sortOrder: 50 }),
        artifact(MIDDLE_ID, { sortOrder: 60 }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 100 }),
        artifact(SECOND_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          sortOrder: 200,
        }),
        artifact(THIRD_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          sortOrder: 300,
        }),
      ],
      [
        link(MIDDLE_ID, ASSIGNED_ID),
        link(MIDDLE_ID, SECOND_ASSIGNED_ID),
        link(MIDDLE_ID, THIRD_ASSIGNED_ID),
        link(ROOT_ID, MIDDLE_ID),
      ]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    // Three anchors. A per-artifact walk would issue at least one link query
    // per artifact per level; the batched walk issues one per LEVEL and per
    // DIRECTION, so the count is bounded by depth, not by anchor count.
    const targetIdCalls = mockDb.artifactLink.findMany.mock.calls.filter(
      (call) => call[0].where.targetId !== undefined
    );
    expect(targetIdCalls[0]?.[0].where.targetId).toEqual({
      in: [ASSIGNED_ID, SECOND_ASSIGNED_ID, THIRD_ASSIGNED_ID],
    });
    expect(targetIdCalls.length).toBeLessThanOrEqual(3);
    expect(result.nodes.map((node) => node.root.id)).toEqual([ROOT_ID]);
    expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
      MIDDLE_ID,
      ASSIGNED_ID,
      SECOND_ASSIGNED_ID,
      THIRD_ASSIGNED_ID,
    ]);
  });

  it("does not merge two project-less artifacts into one node just because both have a null projectId", async () => {
    seedGraph(
      [
        artifact(ROOT_ID, { projectId: null, name: "org-level template" }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          projectId: null,
          name: "unparented session",
        }),
      ],
      [link(ROOT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    // "No project" is not a project to group on, so the two must not share a
    // root. The link is still reported, as an external parent.
    expect(result.nodes.map((node) => node.root.id)).toEqual([ASSIGNED_ID]);
    expect(result.nodes[0]?.children).toEqual([]);
    expect(
      result.externalParents.map((entry) => [entry.childId, entry.parent.id])
    ).toEqual([[ASSIGNED_ID, ROOT_ID]]);
  });

  it("treats a project-less parent of a projected artifact as external, not as a root", async () => {
    seedGraph(
      [
        artifact(ROOT_ID, { projectId: null }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID }),
      ],
      [link(ROOT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes.map((node) => node.root.id)).toEqual([ASSIGNED_ID]);
    expect(result.externalParents.map((entry) => entry.parent.id)).toEqual([
      ROOT_ID,
    ]);
  });

  it("reports depth-cap truncation instead of presenting a mid-chain ancestor as the root", async () => {
    const chainIds = Array.from(
      { length: DEEP_CHAIN_LENGTH },
      (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`
    );
    const artifacts = chainIds.map((id, index) =>
      artifact(id, {
        // The deepest id is the assigned leaf; everything above it is an ancestor.
        assigneeId: index === chainIds.length - 1 ? ASSIGNEE_ID : null,
        sortOrder: index,
      })
    );
    // Straight line: chainIds[i] produces chainIds[i + 1]. No cycle, so only the
    // depth bound can terminate the walk.
    const links = chainIds
      .slice(0, -1)
      .map((id, index) => link(id, chainIds[index + 1] as string));
    seedGraph(artifacts, links);

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes).toHaveLength(1);
    // Bounded, not exhausted: the chain is longer than the cap, so the walk
    // must stop short of the true root rather than run the full length.
    const childCount = result.nodes[0]?.children.length ?? 0;
    expect(childCount).toBeLessThan(DEEP_CHAIN_LENGTH - 1);
    expect(childCount).toBeGreaterThan(0);
    // The node it DID pick is not the real root, so the response must say the
    // tree is partial rather than let My Tasks render a false complete tree.
    expect(result.truncation?.reasons).toContain(TreeTruncationReason.DepthCap);
    expect(log.warn).toHaveBeenCalledWith(
      "assigned_artifact_tree_truncated",
      expect.objectContaining({
        reasons: expect.arrayContaining([TreeTruncationReason.DepthCap]),
      })
    );
  });

  it("caps the anchor set and reports it rather than walking an unbounded seed", async () => {
    const anchorIds = Array.from(
      { length: MAX_TREE_ANCHORS_BOUND + 25 },
      (_, index) => `10000000-0000-7000-8000-${String(index).padStart(12, "0")}`
    );
    seedGraph(
      anchorIds.map((id, index) =>
        artifact(id, {
          assigneeId: ASSIGNEE_ID,
          sortOrder: index,
          createdAt: new Date(2026, 0, 1, 0, 0, index),
        })
      ),
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result.nodes).toHaveLength(MAX_TREE_ANCHORS_BOUND);
    expect(result.truncation?.reasons).toContain(
      TreeTruncationReason.AnchorCap
    );
    expect(result.truncation?.anchorsIncluded).toBe(MAX_TREE_ANCHORS_BOUND);
    // A FLOOR, never presented as an exact "of N".
    expect(result.truncation?.anchorsMatchedAtLeast).toBeGreaterThan(
      MAX_TREE_ANCHORS_BOUND
    );
  });

  it("chunks a frontier wider than the bind chunk instead of binding it in one IN", async () => {
    // 300 anchors that each produce 3 children: the DESCENDANT frontier is 900
    // ids, well past the chunk size, which is the shape that would otherwise
    // walk toward PostgreSQL's bind-parameter limit and 500 the whole read.
    const anchorCount = 300;
    const childrenPerAnchor = 3;
    const artifacts: TestArtifact[] = [];
    const links: TestLink[] = [];
    for (let index = 0; index < anchorCount; index++) {
      const anchorId = `20000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
      artifacts.push(
        artifact(anchorId, {
          assigneeId: ASSIGNEE_ID,
          createdAt: new Date(2026, 0, 1, 0, 0, index),
        })
      );
      for (let child = 0; child < childrenPerAnchor; child++) {
        const childId = `30000000-0000-7000-8000-${String(index * childrenPerAnchor + child).padStart(12, "0")}`;
        artifacts.push(artifact(childId));
        links.push(link(anchorId, childId));
      }
    }
    seedGraph(artifacts, links);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    const idPredicateSizes = mockDb.artifact.findMany.mock.calls.map(
      (call) => call[0].where.id?.in?.length ?? 0
    );
    // The 900-id frontier had to be split, and no single predicate exceeded the
    // chunk size.
    expect(idPredicateSizes.length).toBeGreaterThan(1);
    expect(Math.max(...idPredicateSizes)).toBeLessThanOrEqual(500);

    const linkPredicateSizes = mockDb.artifactLink.findMany.mock.calls.map(
      (call) =>
        call[0].where.sourceId?.in.length ??
        call[0].where.targetId?.in.length ??
        0
    );
    expect(Math.max(...linkPredicateSizes)).toBeLessThanOrEqual(500);
  });

  it("returns an empty tree without walking any chain when nothing is assigned", async () => {
    seedGraph([], []);

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID
    );

    expect(result).toEqual({ nodes: [], externalParents: [] });
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
  });
});

function createMockDb() {
  return {
    artifact: { findMany: vi.fn() },
    artifactLink: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  };
}

/** Every bound value the anchor `$queryRaw` carried, flattened. */
function anchorQueryValues(): unknown[] {
  return mockDb.$queryRaw.mock.calls.flatMap((call) =>
    flattenSqlValues(call[0])
  );
}

function flattenSqlValues(node: unknown): unknown[] {
  if (!node || typeof node !== "object") {
    return [node];
  }
  if (!("values" in node)) {
    return [];
  }
  const { values } = node as { values: unknown[] };
  return values.flatMap((value) =>
    value && typeof value === "object" && "values" in value
      ? flattenSqlValues(value)
      : [value]
  );
}

/**
 * Back the mocked Prisma delegates with an in-memory graph that enforces the
 * SAME org scoping a real `where` clause would. A cross-organization row placed
 * in this fixture is therefore excluded by the query, not by the assertion —
 * which is what makes the cross-org test a real security assertion.
 *
 * The anchor read goes through `$queryRaw`, so the fixture reads the bound
 * values: a production query that stopped binding the organization or the
 * assignee returns nothing here and fails the test rather than passing on an
 * assertion-side filter.
 */
function seedGraph(
  artifacts: TestArtifact[],
  links: TestLink[],
  contributorBranchIds: string[] = []
): void {
  mockDb.$queryRaw.mockImplementation((sql: unknown) => {
    const values = flattenSqlValues(sql);
    if (!(values.includes(ORGANIZATION_ID) && values.includes(ASSIGNEE_ID))) {
      return Promise.resolve([]);
    }
    const limit = values.find(
      (value): value is number => typeof value === "number"
    );
    const matched = artifacts
      .filter(
        (row) =>
          row.organizationId === ORGANIZATION_ID &&
          (row.assigneeId === ASSIGNEE_ID ||
            (row.type === ArtifactType.BRANCH &&
              contributorBranchIds.includes(row.id)))
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.id.localeCompare(b.id)
      )
      .slice(0, limit ?? artifacts.length);
    return Promise.resolve(matched.map((row) => ({ id: row.id })));
  });

  mockDb.artifact.findMany.mockImplementation(
    ({ where }: { where: ArtifactWhere }) => {
      const scoped = artifacts.filter(
        (row) => row.organizationId === where.organizationId
      );
      const ids = where.id?.in ?? [];
      return Promise.resolve(scoped.filter((row) => ids.includes(row.id)));
    }
  );

  mockDb.artifactLink.findMany.mockImplementation(
    ({ where }: { where: LinkWhere }) =>
      Promise.resolve(
        links
          .filter(
            (row) =>
              row.organizationId === where.organizationId &&
              row.linkType === where.linkType &&
              (where.targetId
                ? where.targetId.in.includes(row.targetId)
                : (where.sourceId?.in.includes(row.sourceId) ?? false))
          )
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.sourceId.localeCompare(b.sourceId)
          )
      )
  );
}

function artifact(
  id: string,
  overrides: Partial<TestArtifact> = {}
): TestArtifact {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    assigneeId: null,
    type: ArtifactType.DOCUMENT,
    subtype: null,
    name: id,
    sortOrder: null,
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    assignee: null,
    ...overrides,
  };
}

function link(
  sourceId: string,
  targetId: string,
  overrides: Partial<TestLink> = {}
): TestLink {
  return {
    organizationId: ORGANIZATION_ID,
    sourceId,
    targetId,
    linkType: LinkType.Produces,
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    ...overrides,
  };
}

function collectArtifactIds(result: {
  nodes: { root: { id: string }; children: { id: string }[] }[];
  externalParents: { parent: { id: string } }[];
}): string[] {
  const ids: string[] = [];
  for (const node of result.nodes) {
    ids.push(node.root.id, ...node.children.map((child) => child.id));
  }
  for (const entry of result.externalParents) {
    ids.push(entry.parent.id);
  }
  return ids;
}
