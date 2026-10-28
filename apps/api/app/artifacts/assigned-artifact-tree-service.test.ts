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

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: vi.fn() },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  branchProviderFallbackService: { findByIds: vi.fn() },
}));

import { LinkType } from "@repo/api/src/types/artifact";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { ArtifactType } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  ASSIGNED_ID,
  ASSIGNEE_ID,
  BRANCH_ID,
  DEEP_CHAIN_LENGTH,
  DEPLOYMENT_ID,
  FOREIGN_PARENT_ID,
  MAX_TREE_ANCHORS_BOUND,
  MIDDLE_ID,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  ROOT_ID,
  SECOND_ASSIGNED_ID,
  THIRD_ASSIGNED_ID,
  VIEWER_USER_ID,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.ids";
import {
  type AssignedTreeHarness,
  artifact,
  collectArtifactIds,
  createAssignedTreeHarness,
  link,
  type TestArtifact,
  type TestLink,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.test-harness";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { assignedArtifactTreeService } from "./assigned-artifact-tree-service";

let harness: AssignedTreeHarness;

describe("assignedArtifactTreeService.getAssignedArtifactTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness = createAssignedTreeHarness();
    vi.mocked(branchProductEligibilityService.findByIds).mockResolvedValue(
      new Map()
    );
    vi.mocked(branchProviderFallbackService.findByIds).mockResolvedValue(
      new Set()
    );
  });

  it("returns a merged org-scoped tree in a single service call, keyed by the assigned artifact's project", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { sortOrder: 100 }),
        artifact(MIDDLE_ID, { sortOrder: 200 }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 300 }),
      ],
      [link(ROOT_ID, MIDDLE_ID), link(MIDDLE_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    expect(harness.anchorQueryValues()).toEqual(
      expect.arrayContaining([ORGANIZATION_ID, ASSIGNEE_ID])
    );
  });

  it("nests the children of an anchor so an assigned issue still expands", async () => {
    harness.seedGraph(
      [
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 100 }),
        // Someone else's plan, produced by the issue the user owns. An
        // ancestors-only walk turns the issue row into a childless leaf.
        artifact(SECOND_ASSIGNED_ID, { assigneeId: null, sortOrder: 200 }),
      ],
      [link(ASSIGNED_ID, SECOND_ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(result.nodes.map((node) => node.root.id)).toEqual([ASSIGNED_ID]);
    expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
      SECOND_ASSIGNED_ID,
    ]);
    expect(result.nodes[0]?.children.map((child) => child.depth)).toEqual([1]);
  });

  it("AC-007 orders assigned-tree siblings by the same rank comparator", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 0 }),
        artifact(ASSIGNED_ID, { assigneeId: null, sortOrder: 2000 }),
        artifact(SECOND_ASSIGNED_ID, { assigneeId: null, sortOrder: 1000 }),
      ],
      [
        link(ROOT_ID, ASSIGNED_ID, { sortOrder: 2000 }),
        link(ROOT_ID, SECOND_ASSIGNED_ID, { sortOrder: 1000 }),
      ]
    );

    const unflagged = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );
    expect(unflagged.nodes[0]?.children.map(({ id }) => id)).toEqual([
      ASSIGNED_ID,
      SECOND_ASSIGNED_ID,
    ]);

    const result =
      await assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTree(
        ASSIGNEE_ID,
        ORGANIZATION_ID,
        VIEWER_USER_ID,
        {}
      );

    expect(result.nodes[0]?.children.map(({ id }) => id)).toEqual([
      SECOND_ASSIGNED_ID,
      ASSIGNED_ID,
    ]);
  });

  it("orders unplaced assigned-tree children oldest first with stable ties under manual ordering", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID }),
        artifact(ASSIGNED_ID, {
          createdAt: new Date("2026-07-05T00:00:00.000Z"),
        }),
        artifact(SECOND_ASSIGNED_ID, {
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        }),
        artifact(THIRD_ASSIGNED_ID, {
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        }),
        artifact(MIDDLE_ID, {
          createdAt: new Date("2026-07-06T00:00:00.000Z"),
        }),
      ],
      [
        link(ROOT_ID, ASSIGNED_ID),
        link(ROOT_ID, THIRD_ASSIGNED_ID),
        link(ROOT_ID, MIDDLE_ID, { sortOrder: 1000 }),
        link(ROOT_ID, SECOND_ASSIGNED_ID),
      ]
    );

    const result =
      await assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTree(
        ASSIGNEE_ID,
        ORGANIZATION_ID,
        VIEWER_USER_ID,
        {}
      );

    expect(result.nodes[0]?.children.map(({ id }) => id)).toEqual([
      MIDDLE_ID,
      SECOND_ASSIGNED_ID,
      THIRD_ASSIGNED_ID,
      ASSIGNED_ID,
    ]);
  });

  it("does NOT return a cross-organization artifact reached through a parent chain", async () => {
    harness.seedGraph(
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
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    const returnedIds = collectArtifactIds(result);
    expect(returnedIds).toContain(ASSIGNED_ID);
    expect(returnedIds).not.toContain(FOREIGN_PARENT_ID);
    expect(result.externalParents).toEqual([]);
    // Every artifact read carried the caller's organization.
    for (const call of harness.mockDb.artifact.findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe(ORGANIZATION_ID);
    }
    for (const call of harness.mockDb.artifactLink.findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe(ORGANIZATION_ID);
    }
  });

  it("keeps the assigned artifact when its parent row is missing entirely", async () => {
    harness.seedGraph(
      [artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID })],
      // Dangling link: the parent artifact was deleted.
      [link(ROOT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(result.nodes.map((node) => node.root.id)).toEqual([ASSIGNED_ID]);
    expect(result.nodes[0]?.children).toEqual([]);
    expect(result.externalParents).toEqual([]);
  });

  it("terminates on a parent-chain cycle without duplicating a node", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { sortOrder: 100 }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, sortOrder: 200 }),
      ],
      // A produces B and B produces A — a user-writable cycle.
      [link(ROOT_ID, ASSIGNED_ID), link(ASSIGNED_ID, ROOT_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.root.id).toBe(ROOT_ID);
    expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
      ASSIGNED_ID,
    ]);
  });

  it("records a cross-project parent as an external parent, deduped by artifact id", async () => {
    harness.seedGraph(
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
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    harness.seedGraph(
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
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    harness.seedGraph(
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
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    // Three anchors. A per-artifact walk would issue at least one link query
    // per artifact per level; the batched walk issues one per LEVEL and per
    // DIRECTION, so the count is bounded by depth, not by anchor count.
    const targetIdCalls =
      harness.mockDb.artifactLink.findMany.mock.calls.filter(
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
    harness.seedGraph(
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
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    harness.seedGraph(
      [
        artifact(ROOT_ID, { projectId: null }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID }),
      ],
      [link(ROOT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    harness.seedGraph(artifacts, links);

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    harness.seedGraph(
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
      ORGANIZATION_ID,
      VIEWER_USER_ID
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
    harness.seedGraph(artifacts, links);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    const idPredicateSizes = harness.mockDb.artifact.findMany.mock.calls.map(
      (call) => call[0].where.id?.in?.length ?? 0
    );
    // The 900-id frontier had to be split, and no single predicate exceeded the
    // chunk size.
    expect(idPredicateSizes.length).toBeGreaterThan(1);
    expect(Math.max(...idPredicateSizes)).toBeLessThanOrEqual(500);

    const linkPredicateSizes =
      harness.mockDb.artifactLink.findMany.mock.calls.map(
        (call) =>
          call[0].where.sourceId?.in.length ??
          call[0].where.targetId?.in.length ??
          0
      );
    expect(Math.max(...linkPredicateSizes)).toBeLessThanOrEqual(500);
  });

  // ISS-12463: branches are not tasks. The assertions are on the QUERY, not
  // only the fixture: the fixture would report the same empty result for a
  // predicate that still paid for a contributor `EXISTS`.
  it("excludes BRANCH and issues no contributor EXISTS", async () => {
    harness.seedGraph(
      [
        artifact(BRANCH_ID, {
          type: ArtifactType.BRANCH,
          assigneeId: ASSIGNEE_ID,
          sortOrder: 100,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(harness.anchorQueryText()).not.toContain("EXISTS");
    // BRANCH is still BOUND — as the excluded type, not the admitted one — so
    // the value assertion alone cannot tell the arms apart and the operator is
    // pinned in the text.
    expect(harness.anchorTypeComparisons().excluded).toEqual([
      ArtifactType.BRANCH,
      ArtifactType.SESSION,
    ]);
    // SESSION is inlined, never bound: a bound enum cast cannot prove the
    // partial index's `type <> 'SESSION'` predicate, so binding it would put
    // the scan back on every session the assignee owns.
    expect(harness.anchorQueryValues()).not.toContain(ArtifactType.SESSION);
    expect(harness.anchorQueryValues()).toEqual(
      expect.arrayContaining([
        ORGANIZATION_ID,
        ASSIGNEE_ID,
        ArtifactType.BRANCH,
      ])
    );
    expect(result.nodes).toEqual([]);
  });

  // marisolashgrove, PR #7953: `pruneBranchSubtrees` drops BRANCH and nothing
  // else, so an anchor predicate narrower than that puts the two reads meant to
  // produce the same board on different rules. A DOCUMENT-only predicate passes
  // every other case in this file and fails only this one.
  it("still anchors an assigned non-document", async () => {
    harness.seedGraph(
      [
        artifact(DEPLOYMENT_ID, {
          type: ArtifactType.DEPLOYMENT,
          assigneeId: ASSIGNEE_ID,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(collectArtifactIds(result)).toContain(DEPLOYMENT_ID);
  });

  it("returns an empty tree without walking any chain when nothing is assigned", async () => {
    harness.seedGraph([], []);

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(result).toEqual({ nodes: [], externalParents: [] });
    expect(harness.mockDb.artifactLink.findMany).not.toHaveBeenCalled();
    expect(harness.mockDb.artifact.findMany).not.toHaveBeenCalled();
  });
});
