import { LinkType } from "@repo/api/src/types/artifact";
import type {
  ArtifactGroupByMode,
  ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import type { AssignedTreeSort } from "@repo/api/src/types/assigned-tree-sort";
import type {
  ExternalParentLink,
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
  TreeTruncation,
} from "@repo/api/src/types/project-tree";
import {
  orderTreeTruncationReasons,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import { ArtifactType } from "@repo/database";
import { log } from "@repo/observability/log";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import {
  type ArtifactWithAssignee,
  applyBranchProductEligibility,
  applyBranchProviderFallbackAvailability,
  applySessionDisplayedStatus,
  compareByCreatedAtThenId,
  compareByStackRank,
  compareParentRankedArtifacts,
  flattenCanonicalSubtree,
  groupChildIdsByParent,
  type ParentEdge,
} from "./artifact-tree-shared";
import {
  MAX_TREE_ANCHORS,
  resolveTreeAnchors,
  type TreeAnchorFilters,
  type TreeAnchors,
} from "./assigned-artifact-tree-anchors";
import {
  collectAncestors,
  collectDescendants,
  loadArtifactsById,
  MAX_CHAIN_DEPTH,
  mergeParentEdges,
} from "./assigned-artifact-tree-graph";
import {
  type PageDescendant,
  resolveManuallyOrderedPageDescendants,
  resolvePageDescendants,
  resolvePageExternalParents,
  resolveRootPage,
} from "./assigned-artifact-tree-root-page";
import { resolveRootSectionPage } from "./assigned-tree-root-sections";
import { sessionDisplayedStatusService } from "./session-displayed-status-service";

/** Structured event name for the truncated-read monitor (root `AGENTS.md`). */
const TRUNCATED_TREE_READ_EVENT = "assigned_artifact_tree_truncated";

export const assignedArtifactTreeService = {
  /**
   * Build the assignee-scoped artifact tree behind
   * `GET /artifacts/assigned-tree` (FEA-1651, parent FEA-908).
   *
   * Replaces the My Tasks client fan-out — one `GET /projects/:id/tree` per
   * project the user is assigned in — with a single org-scoped read.
   *
   * SCOPE. The anchors are the artifacts assigned to `assigneeId` that are
   * neither sessions nor branches (`resolveTreeAnchors`; ISS-12463) — the same
   * rule the client prune applies, not a narrower one.
   *
   * `viewerUserId` is the READER, never the `assigneeId` whose tree is served:
   * the route serves any org member's tree. ISS-12463 removed it with the flag
   * it identified; ISS-10471 needs it back for DATA, because the favorites
   * facet scopes `favorite_artifacts` to the viewer.
   *
   * NARROWING (ISS-10471) is opt-in and applies to the ANCHOR predicate, so a
   * status the caller excluded never spends part of the {@link MAX_TREE_ANCHORS}
   * budget. It does not prune the walks: an ancestor or child pulled in for
   * context keeps its place whatever its own status, because the breadcrumb and
   * the nesting are what make an anchor legible.
   *
   * This is NARROWER than the browser predicate it replaces, which is an
   * accepted change (operator ruling 2026-10-17), not a match:
   * `filterDisplayGroups` keeps a non-matching ancestor whenever any descendant
   * matches, assigned or not, so it surfaces a matching row that is not an
   * anchor. Seeded from assigned anchors only, this read does not.
   *
   * From those anchors the walk goes UP (parent chains, so a row keeps its
   * breadcrumb context) and DOWN (children, so a row keeps its nesting). The
   * DOWNWARD walk is kept because it is what produces PRD to Plan to Issue
   * nesting; a branch it reaches is pruned on the client
   * (`pruneBranchSubtrees`).
   *
   * It deliberately does NOT reproduce the fan-out's full corpus — every
   * artifact in every project the user touches, including other people's —
   * because that is an unbounded server workload. The difference is bounded and
   * declared: see `truncation` on the response.
   *
   * ORG SCOPING is enforced in the `where` clause of EVERY query, including the
   * graph hops — a parent or child chain is exactly how a cross-organization row
   * could otherwise be pulled in. A row outside the caller's organization simply
   * does not come back and the chain ends there; the anchor itself is never
   * dropped because a neighbour was unreachable.
   *
   * BOUNDS. Anchors are capped, both walks are depth-capped, the materialized
   * node count is capped, and every `IN` predicate is chunked below
   * PostgreSQL's bind limit. Whenever a bound binds, the response carries an
   * explicit `truncation` rather than presenting a partial graph as complete.
   */
  async getAssignedArtifactTree(
    assigneeId: string,
    organizationId: string,
    viewerUserId: string,
    filters: TreeAnchorFilters = {}
  ): Promise<ProjectTreeResponse> {
    const graph = await loadAssignedTreeGraph(
      assigneeId,
      organizationId,
      viewerUserId,
      filters
    );
    if (!graph) {
      return { nodes: [], externalParents: [] };
    }
    const tree = buildTree(
      graph.artifactsById,
      graph.parentEdges,
      graph.loadedIds
    );
    return withAssignedTreeTruncation(tree, graph, assigneeId, organizationId);
  },

  async getManuallyOrderedAssignedArtifactTree(
    assigneeId: string,
    organizationId: string,
    viewerUserId: string,
    filters: TreeAnchorFilters = {}
  ): Promise<ProjectTreeResponse> {
    const graph = await loadAssignedTreeGraph(
      assigneeId,
      organizationId,
      viewerUserId,
      filters
    );
    if (!graph) {
      return { nodes: [], externalParents: [] };
    }
    const tree = buildManuallyOrderedTree(
      graph.artifactsById,
      graph.parentEdges,
      graph.loadedIds
    );
    return withAssignedTreeTruncation(tree, graph, assigneeId, organizationId);
  },

  /**
   * ISS-10472: the same tree, paged by ROOT GROUP, derived in SQL.
   *
   * A separate method rather than a branch inside the unpaged one because the
   * derivation is genuinely different — roots come from a recursive climb in
   * Postgres instead of a Node walk over a capped anchor fetch — and a single
   * function carrying both would be two code paths wearing one name. The
   * divergence risk that creates is covered by
   * `__tests__/integration/assigned-tree-root-page.test.ts`, which asserts an
   * over-wide page returns the same roots as the unpaged read.
   *
   * There is no anchor cap here, which is the whole point: the unpaged read
   * stops at `MAX_TREE_ANCHORS` and cannot reach root 501 by any route.
   */
  async getAssignedArtifactTreePage(
    assigneeId: string,
    organizationId: string,
    viewerUserId: string,
    paging: { limit: number; offset: number; sort?: AssignedTreeSort },
    filters: TreeAnchorFilters = {}
  ): Promise<ProjectTreeResponse> {
    const rootPage = await resolveRootPage({
      assigneeId,
      organizationId,
      viewerUserId,
      limit: paging.limit,
      offset: paging.offset,
      filters,
      sort: paging.sort,
    });
    const page = {
      offset: paging.offset,
      limit: paging.limit,
      total: rootPage.total,
    };
    if (rootPage.ids.length === 0) {
      return { nodes: [], externalParents: [], page };
    }

    return await materializePageRoots({
      assigneeId,
      organizationId,
      page,
      rootIds: rootPage.ids,
      rootTotal: rootPage.total,
    });
  },

  async getManuallyOrderedAssignedArtifactTreePage(
    assigneeId: string,
    organizationId: string,
    viewerUserId: string,
    paging: { limit: number; offset: number; sort?: AssignedTreeSort },
    filters: TreeAnchorFilters = {}
  ): Promise<ProjectTreeResponse> {
    const rootPage = await resolveRootPage({
      assigneeId,
      organizationId,
      viewerUserId,
      limit: paging.limit,
      offset: paging.offset,
      filters,
      sort: paging.sort,
    });
    const page = {
      offset: paging.offset,
      limit: paging.limit,
      total: rootPage.total,
    };
    if (rootPage.ids.length === 0) {
      return { nodes: [], externalParents: [], page };
    }
    return await materializeManuallyOrderedPageRoots({
      assigneeId,
      organizationId,
      page,
      rootIds: rootPage.ids,
      rootTotal: rootPage.total,
    });
  },

  /**
   * ISS-10472: the same tree, paged by SECTION for a grouped board.
   *
   * Only the root SELECTION differs from {@link getAssignedArtifactTreePage} —
   * sections packed onto a page instead of a row window — so everything below
   * the roots goes through {@link materializePageRoots}. A second copy of that
   * walk would be a second answer to what a page CONTAINS.
   *
   * `ordering` is resolved by the caller and NAMED on the response rather than
   * requested by the client: ISS-9437 declined letting a list honor an ordering
   * the client states rather than one the server evaluates.
   */
  async getAssignedArtifactTreeSectionPage(
    assigneeId: string,
    organizationId: string,
    viewerUserId: string,
    grouping: {
      groupBy: Exclude<ArtifactGroupByMode, typeof ArtifactGroupByMode.None>;
      ordering: ArtifactSectionOrdering;
      pageIndex: number;
      pageSize: number;
      sort?: AssignedTreeSort;
    },
    filters: TreeAnchorFilters = {}
  ): Promise<ProjectTreeResponse> {
    const sectionPage = await resolveRootSectionPage({
      assigneeId,
      filters,
      groupBy: grouping.groupBy,
      ordering: grouping.ordering,
      organizationId,
      pageIndex: grouping.pageIndex,
      pageSize: grouping.pageSize,
      sort: grouping.sort,
      viewerUserId,
    });
    return await materializePageRoots({
      assigneeId,
      organizationId,
      page: {
        limit: grouping.pageSize,
        // Variable-height pages have no row offset to report, so `offset` is
        // OMITTED and the index travels under its own name — a reader of
        // `offset` must never get a page index from it (marisolashgrove, PR
        // #9026).
        pageIndex: grouping.pageIndex,
        ordering: grouping.ordering,
        rowsBefore: sectionPage.rowsBefore,
        sections: sectionPage.sections.map((section) => ({
          continued: section.continued,
          rootIds: section.ids,
          total: section.total,
        })),
        total: sectionPage.total,
        totalPages: sectionPage.totalPages,
      },
      rootIds: sectionPage.ids,
      rootTotal: sectionPage.total,
    });
  },

  async getManuallyOrderedAssignedArtifactTreeSectionPage(
    assigneeId: string,
    organizationId: string,
    viewerUserId: string,
    grouping: {
      groupBy: Exclude<ArtifactGroupByMode, typeof ArtifactGroupByMode.None>;
      ordering: ArtifactSectionOrdering;
      pageIndex: number;
      pageSize: number;
      sort?: AssignedTreeSort;
    },
    filters: TreeAnchorFilters = {}
  ): Promise<ProjectTreeResponse> {
    const sectionPage = await resolveRootSectionPage({
      assigneeId,
      filters,
      groupBy: grouping.groupBy,
      ordering: grouping.ordering,
      organizationId,
      pageIndex: grouping.pageIndex,
      pageSize: grouping.pageSize,
      sort: grouping.sort,
      viewerUserId,
    });
    return await materializeManuallyOrderedPageRoots({
      assigneeId,
      organizationId,
      page: {
        limit: grouping.pageSize,
        pageIndex: grouping.pageIndex,
        ordering: grouping.ordering,
        rowsBefore: sectionPage.rowsBefore,
        sections: sectionPage.sections.map((section) => ({
          continued: section.continued,
          rootIds: section.ids,
          total: section.total,
        })),
        total: sectionPage.total,
        totalPages: sectionPage.totalPages,
      },
      rootIds: sectionPage.ids,
      rootTotal: sectionPage.total,
    });
  },
};

async function loadAssignedTreeGraph(
  assigneeId: string,
  organizationId: string,
  viewerUserId: string,
  filters: TreeAnchorFilters
) {
  const anchors = await resolveTreeAnchors(
    assigneeId,
    organizationId,
    viewerUserId,
    filters
  );
  if (anchors.ids.length === 0) {
    return null;
  }
  const artifactsById = new Map<string, ArtifactWithAssignee>();
  const { loadedIds } = await loadArtifactsById(
    organizationId,
    anchors.ids,
    artifactsById
  );
  const [up, down] = await Promise.all([
    collectAncestors(organizationId, artifactsById, loadedIds),
    collectDescendants(organizationId, artifactsById, loadedIds),
  ]);
  const parentEdges = new Map<string, ParentEdge[]>();
  mergeParentEdges(parentEdges, up.parentEdges);
  mergeParentEdges(parentEdges, down.parentEdges);
  await enrichLoadedArtifacts(organizationId, artifactsById);
  return {
    anchors,
    artifactsById,
    loadedIds,
    parentEdges,
    walkReasons: [...up.reasons, ...down.reasons],
  };
}

function withAssignedTreeTruncation(
  tree: ProjectTreeResponse,
  graph: NonNullable<Awaited<ReturnType<typeof loadAssignedTreeGraph>>>,
  assigneeId: string,
  organizationId: string
): ProjectTreeResponse {
  const truncation = resolveTruncation(graph.anchors, graph.walkReasons);
  if (!truncation) {
    return tree;
  }
  log.warn(TRUNCATED_TREE_READ_EVENT, {
    assigneeId,
    organizationId,
    anchorsIncluded: truncation.anchorsIncluded,
    anchorsMatchedAtLeast: truncation.anchorsMatchedAtLeast,
    reasons: truncation.reasons,
  });
  return { ...tree, truncation };
}

/**
 * Everything below a page's roots: the downward walk, the cross-project parent
 * edges, hydration, and the node-budget report.
 *
 * Shared by the row-paged and section-paged reads because the only thing that
 * differs between them is WHICH roots the page holds. `rootTotal` feeds
 * `anchorsMatchedAtLeast`, which is exact here — this read counts rather than
 * probing for overflow.
 */
async function materializePageRoots(input: {
  assigneeId: string;
  organizationId: string;
  page: NonNullable<ProjectTreeResponse["page"]>;
  rootIds: string[];
  rootTotal: number;
}): Promise<ProjectTreeResponse> {
  if (input.rootIds.length === 0) {
    return { externalParents: [], nodes: [], page: input.page };
  }
  const descendants = await resolvePageDescendants({
    organizationId: input.organizationId,
    rootIds: input.rootIds,
  });
  return hydratePageRoots(input, descendants);
}

async function materializeManuallyOrderedPageRoots(input: {
  assigneeId: string;
  organizationId: string;
  page: NonNullable<ProjectTreeResponse["page"]>;
  rootIds: string[];
  rootTotal: number;
}): Promise<ProjectTreeResponse> {
  if (input.rootIds.length === 0) {
    return { externalParents: [], nodes: [], page: input.page };
  }
  const descendants = await resolveManuallyOrderedPageDescendants({
    organizationId: input.organizationId,
    rootIds: input.rootIds,
  });
  return hydratePageRoots(input, descendants);
}

async function hydratePageRoots(
  input: {
    assigneeId: string;
    organizationId: string;
    page: NonNullable<ProjectTreeResponse["page"]>;
    rootIds: string[];
    rootTotal: number;
  },
  descendants: PageDescendant[]
): Promise<ProjectTreeResponse> {
  const { assigneeId, organizationId, page, rootIds, rootTotal } = input;
  const nodeIds = [...rootIds, ...descendants.map((row) => row.id)];
  const externalEdges = await resolvePageExternalParents({
    organizationId,
    nodeIds,
  });

  const artifactsById = new Map<string, ArtifactWithAssignee>();
  // The external parents are loaded too: `ExternalParentLink` carries the
  // parent ARTIFACT, not its id, so omitting them here would drop the link
  // rather than report it.
  const { hitNodeBudget } = await loadArtifactsById(
    organizationId,
    [...nodeIds, ...externalEdges.map((edge) => edge.parentId)],
    artifactsById
  );
  await enrichLoadedArtifacts(organizationId, artifactsById);

  const nodes = assemblePagedNodes(rootIds, descendants, artifactsById);
  const externalParents = externalEdges.flatMap((edge) => {
    const parent = artifactsById.get(edge.parentId);
    return parent
      ? [{ childId: edge.childId, parent, linkType: edge.linkType }]
      : [];
  });
  if (!hitNodeBudget) {
    return { externalParents, nodes, page };
  }

  // `MAX_TREE_NODES` is applied PER PAGE, and when it binds the response says
  // so rather than serving a silently short tree.
  const truncation: TreeTruncation = {
    anchorsIncluded: rootIds.length,
    anchorsMatchedAtLeast: rootTotal,
    reasons: [TreeTruncationReason.NodeBudget],
  };
  log.warn(TRUNCATED_TREE_READ_EVENT, {
    anchorsIncluded: truncation.anchorsIncluded,
    anchorsMatchedAtLeast: truncation.anchorsMatchedAtLeast,
    assigneeId,
    organizationId,
    reasons: truncation.reasons,
    status: "degraded",
  });
  return { externalParents, nodes, page, truncation };
}

/**
 * Group the flat depth-first descendant list under its roots.
 *
 * Root order is `rootIds`, the order the page was SLICED in — stack rank by
 * default, or the column ISS-12636's sort requested — so this never re-sorts.
 * Re-sorting would be the bug: a render order other than the slice order skips
 * and repeats rows across a page boundary, which is the defect PRD-743 exists
 * to remove.
 */
function assemblePagedNodes(
  rootIds: string[],
  descendants: PageDescendant[],
  artifactsById: Map<string, ArtifactWithAssignee>
): TreeNode[] {
  const childrenByRoot = new Map<string, TreeChild[]>();
  for (const row of descendants) {
    const artifact = artifactsById.get(row.id);
    if (!artifact) {
      continue;
    }
    const children = childrenByRoot.get(row.rootId) ?? [];
    children.push({
      ...artifact,
      depth: row.depth,
      linkType: LinkType.Produces,
      parentId: row.parentId,
    });
    childrenByRoot.set(row.rootId, children);
  }
  return rootIds.flatMap((rootId) => {
    const root = artifactsById.get(rootId);
    return root ? [{ root, children: childrenByRoot.get(rootId) ?? [] }] : [];
  });
}

/**
 * Assemble the loaded subgraph into `ProjectTreeResponse`.
 *
 * Every artifact gets at most ONE canonical internal parent — the earliest
 * declared same-project PRODUCES edge that does not close a cycle — and EVERY
 * other declared parent edge that crosses a project boundary is preserved as an
 * `externalParents` entry. Keeping only the first loadable edge (the previous
 * behaviour) meant an external parent sorting first hid a valid same-project
 * chain, and an internal parent sorting first dropped the external link
 * entirely (whitlockk, PR #4461).
 */
function buildTree(
  artifactsById: Map<string, ArtifactWithAssignee>,
  parentEdges: Map<string, ParentEdge[]>,
  anchorIds: string[]
): ProjectTreeResponse {
  const { canonicalParents, externalParents } = classifyParentEdges(
    artifactsById,
    parentEdges
  );
  return assembleUnpagedTree(
    artifactsById,
    canonicalParents,
    externalParents,
    anchorIds,
    groupChildren(canonicalParents, artifactsById)
  );
}

function buildManuallyOrderedTree(
  artifactsById: Map<string, ArtifactWithAssignee>,
  parentEdges: Map<string, ParentEdge[]>,
  anchorIds: string[]
): ProjectTreeResponse {
  const { canonicalParents, externalParents } = classifyParentEdges(
    artifactsById,
    parentEdges
  );
  return assembleUnpagedTree(
    artifactsById,
    canonicalParents,
    externalParents,
    anchorIds,
    groupManuallyOrderedChildren(canonicalParents, artifactsById)
  );
}

function assembleUnpagedTree(
  artifactsById: Map<string, ArtifactWithAssignee>,
  canonicalParents: Map<string, ParentEdge>,
  externalParents: ExternalParentLink[],
  anchorIds: string[],
  childIdsByParent: Map<string, string[]>
): ProjectTreeResponse {
  const inScopeRootIds = resolveInScopeRootIds(anchorIds, canonicalParents);
  const nodes: TreeNode[] = [];
  const sortedArtifacts = Array.from(artifactsById.values()).sort(
    compareByCreatedAtThenId
  );
  for (const artifact of sortedArtifacts) {
    if (canonicalParents.has(artifact.id) || !inScopeRootIds.has(artifact.id)) {
      continue;
    }
    nodes.push({
      root: artifact,
      children: flattenCanonicalSubtree(
        artifact.id,
        artifactsById,
        childIdsByParent,
        canonicalParents
      ),
    });
  }
  nodes.sort(compareByStackRank);

  return { nodes, externalParents };
}

/**
 * Split every declared parent edge into ONE canonical same-project parent per
 * child plus every cross-project edge, deduped by `(child id, parent id)` —
 * stable record identity, never a name or label, so two artifacts that happen
 * to share a title stay distinct.
 */
function classifyParentEdges(
  artifactsById: Map<string, ArtifactWithAssignee>,
  parentEdges: Map<string, ParentEdge[]>
): {
  canonicalParents: Map<string, ParentEdge>;
  externalParents: ExternalParentLink[];
} {
  const canonicalParents = new Map<string, ParentEdge>();
  const externalParents: ExternalParentLink[] = [];
  const seenExternalKeys = new Set<string>();

  for (const artifact of artifactsById.values()) {
    for (const edge of parentEdges.get(artifact.id) ?? []) {
      const parent = artifactsById.get(edge.parentId);
      if (!parent) {
        continue;
      }
      if (sharesProject(parent.projectId, artifact.projectId)) {
        if (edge.suppressed === true) {
          continue;
        }
        adoptCanonicalParent(canonicalParents, artifact.id, edge);
        continue;
      }
      const key = `${artifact.id}:${parent.id}`;
      if (seenExternalKeys.has(key)) {
        continue;
      }
      seenExternalKeys.add(key);
      externalParents.push({
        childId: artifact.id,
        parent,
        linkType: edge.linkType,
      });
    }
  }
  return { canonicalParents, externalParents };
}

/** Keep the first same-project edge that does not close a cycle. */
function adoptCanonicalParent(
  canonicalParents: Map<string, ParentEdge>,
  childId: string,
  edge: ParentEdge
): void {
  const current = canonicalParents.get(childId);
  if (current && !(edge.canonical === true && current.canonical !== true)) {
    return;
  }
  if (createsCycle(childId, edge.parentId, canonicalParents)) {
    return;
  }
  canonicalParents.set(childId, edge);
}

/**
 * Two artifacts share a project only when both name the SAME, non-null project.
 *
 * `Artifact.projectId` is nullable for every type (FEA-1749) — org-level
 * templates and unparented sessions/branches really do carry `null`. Unlike the
 * per-project tree, which is always queried with one concrete project id and can
 * never observe two nulls, this read spans the whole organization, so a plain
 * `parent.projectId !== artifact.projectId` would evaluate `null !== null` as
 * false and merge two unrelated project-less artifacts into one node. Grouping
 * here is keyed by project, and "no project" is not a project to key on, so a
 * null on either side breaks the chain and the parent is reported as an external
 * parent instead — the link is still surfaced, just never as a shared root.
 */
function sharesProject(
  parentProjectId: string | null,
  childProjectId: string | null
): boolean {
  return parentProjectId !== null && parentProjectId === childProjectId;
}

/**
 * Whether adopting `parentId` as `childId`'s canonical parent would close a
 * cycle. `artifact_links` is user-writable, so A→B→A is representable; a cycle
 * would leave every member parented and therefore rootless, silently dropping
 * the whole component from the response.
 */
function createsCycle(
  childId: string,
  parentId: string,
  canonicalParents: Map<string, ParentEdge>
): boolean {
  let cursor: string | undefined = parentId;
  for (let step = 0; step < MAX_CHAIN_DEPTH && cursor; step++) {
    if (cursor === childId) {
      return true;
    }
    cursor = canonicalParents.get(cursor)?.parentId;
  }
  return false;
}

/**
 * The roots of the components that actually contain the user's work.
 *
 * An artifact reached only as a CROSS-PROJECT parent has no canonical parent of
 * its own, so treating "no canonical parent" as "is a root" would promote it to
 * a top-level row — the per-project tree reports such a parent in
 * `externalParents` and never as a node, and this read must match. Walking up
 * from each anchor yields exactly the component roots that carry an anchor.
 */
function resolveInScopeRootIds(
  anchorIds: string[],
  canonicalParents: Map<string, ParentEdge>
): Set<string> {
  const rootIds = new Set<string>();
  for (const anchorId of anchorIds) {
    let cursor = anchorId;
    for (let step = 0; step < MAX_CHAIN_DEPTH; step++) {
      const parentId = canonicalParents.get(cursor)?.parentId;
      if (!parentId) {
        break;
      }
      cursor = parentId;
    }
    rootIds.add(cursor);
  }
  return rootIds;
}

/**
 * Child ids grouped under their canonical parent in canonical link order.
 */
function groupChildren(
  canonicalParents: Map<string, ParentEdge>,
  artifactsById: ReadonlyMap<string, ArtifactWithAssignee>
): Map<string, string[]> {
  const childIdsByParent = groupChildIdsByParent(canonicalParents);
  for (const childIds of childIdsByParent.values()) {
    childIds.sort((leftId, rightId) => {
      const left = artifactsById.get(leftId);
      const right = artifactsById.get(rightId);
      if (!(left && right)) {
        return leftId.localeCompare(rightId);
      }
      return compareByCreatedAtThenId(left, right);
    });
  }
  return childIdsByParent;
}

function groupManuallyOrderedChildren(
  canonicalParents: Map<string, ParentEdge>,
  artifactsById: ReadonlyMap<string, ArtifactWithAssignee>
): Map<string, string[]> {
  const childIdsByParent = groupChildIdsByParent(canonicalParents);
  for (const childIds of childIdsByParent.values()) {
    childIds.sort((leftId, rightId) => {
      const left = artifactsById.get(leftId);
      const right = artifactsById.get(rightId);
      return left && right
        ? compareParentRankedArtifacts(left, right, canonicalParents)
        : leftId.localeCompare(rightId);
    });
  }
  return childIdsByParent;
}

/**
 * The explicit partial-read contract, or `null` when the read was complete.
 * Reasons are deduped and emitted in a stable order so the field is comparable
 * across requests.
 */
function resolveTruncation(
  anchors: TreeAnchors,
  walkReasons: TreeTruncationReason[]
): TreeTruncation | null {
  const reasons = new Set<TreeTruncationReason>(walkReasons);
  if (anchors.matchedAtLeast > MAX_TREE_ANCHORS) {
    reasons.add(TreeTruncationReason.AnchorCap);
  }
  if (reasons.size === 0) {
    return null;
  }
  return {
    anchorsIncluded: anchors.ids.length,
    anchorsMatchedAtLeast: anchors.matchedAtLeast,
    reasons: orderTreeTruncationReasons(reasons),
  };
}

/**
 * Apply the per-type enrichment both reads owe their rows.
 *
 * Extracted so the ROOT-PAGED read (ISS-10472) cannot quietly serve rows
 * missing fields the unpaged read supplies: a branch's product eligibility and
 * provider fallback, and a session's displayed status. The two paths assemble
 * the tree differently, so this is the one place where they must not.
 */
async function enrichLoadedArtifacts(
  organizationId: string,
  artifactsById: Map<string, ArtifactWithAssignee>
): Promise<void> {
  const branchIds = Array.from(artifactsById.values())
    .filter((artifact) => artifact.type === ArtifactType.BRANCH)
    .map((artifact) => artifact.id);
  const sessionIds = Array.from(artifactsById.values())
    .filter((artifact) => artifact.type === ArtifactType.SESSION)
    .map((artifact) => artifact.id);
  const [eligibilityById, branchIdsWithFallback, displayedSessionStatusById] =
    await Promise.all([
      branchProductEligibilityService.findByIds(organizationId, branchIds),
      branchProviderFallbackService.findByIds(organizationId, branchIds),
      sessionDisplayedStatusService.findByIds(organizationId, sessionIds),
    ]);
  applyBranchProductEligibility(artifactsById, eligibilityById);
  applyBranchProviderFallbackAvailability(artifactsById, branchIdsWithFallback);
  applySessionDisplayedStatus(artifactsById, displayedSessionStatusById);
}
