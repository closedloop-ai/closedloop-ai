import { LinkType } from "@repo/api/src/types/artifact";
import type {
  ExternalParentLink,
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
  TreeTruncation,
} from "@repo/api/src/types/project-tree";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { log } from "@repo/observability/log";
import {
  type ArtifactWithAssignee,
  compareByStackRank,
} from "./artifact-tree-shared";
import {
  MAX_TREE_ANCHORS,
  resolveTreeAnchors,
  type TreeAnchors,
} from "./assigned-artifact-tree-anchors";
import {
  collectAncestors,
  collectDescendants,
  loadArtifactsById,
  MAX_CHAIN_DEPTH,
  mergeParentEdges,
  type ParentEdge,
} from "./assigned-artifact-tree-graph";

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
   * SCOPE. The anchors are BOTH task streams the page is built from: artifacts
   * assigned to `assigneeId`, AND branches the user has commit authorship on.
   * The fan-out asked each project tree for `contributorUserId`, so an
   * assignee-only scope would empty the Branches stream and tell a branch-only
   * user their queue is clear. From those anchors the walk goes UP (parent
   * chains, so a row keeps its breadcrumb context) and DOWN (children, so a
   * branch still expands to its sessions).
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
    organizationId: string
  ): Promise<ProjectTreeResponse> {
    const anchors = await resolveTreeAnchors(assigneeId, organizationId);
    if (anchors.ids.length === 0) {
      return { nodes: [], externalParents: [] };
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

    const tree = buildTree(artifactsById, parentEdges, loadedIds);
    const truncation = resolveTruncation(anchors, [
      ...up.reasons,
      ...down.reasons,
    ]);
    if (!truncation) {
      return tree;
    }

    // Server runtime, so this routes to the existing structured-log monitor
    // rather than being coerced away silently (root `AGENTS.md`).
    log.warn(TRUNCATED_TREE_READ_EVENT, {
      assigneeId,
      organizationId,
      anchorsIncluded: truncation.anchorsIncluded,
      anchorsMatchedAtLeast: truncation.anchorsMatchedAtLeast,
      reasons: truncation.reasons,
    });
    return { ...tree, truncation };
  },
};

/**
 * Assemble the loaded subgraph into `ProjectTreeResponse`.
 *
 * Every artifact gets at most ONE canonical internal parent — the earliest
 * declared same-project PRODUCES edge that does not close a cycle — and EVERY
 * other declared parent edge that crosses a project boundary is preserved as an
 * `externalParents` entry. Keeping only the first loadable edge (the previous
 * behaviour) meant an external parent sorting first hid a valid same-project
 * chain, and an internal parent sorting first dropped the external link
 * entirely (wongk, PR #4461).
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

  const childIdsByParent = groupChildren(artifactsById, canonicalParents);
  const inScopeRootIds = resolveInScopeRootIds(anchorIds, canonicalParents);
  const nodes: TreeNode[] = [];
  for (const artifact of sortArtifacts(Array.from(artifactsById.values()))) {
    if (canonicalParents.has(artifact.id) || !inScopeRootIds.has(artifact.id)) {
      continue;
    }
    nodes.push({
      root: artifact,
      children: flattenChildren(
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
  if (canonicalParents.has(childId)) {
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

/** Child ids grouped under their canonical parent, each group sorted stably. */
function groupChildren(
  artifactsById: Map<string, ArtifactWithAssignee>,
  canonicalParents: Map<string, ParentEdge>
): Map<string, string[]> {
  const childIdsByParent = new Map<string, string[]>();
  for (const [childId, edge] of canonicalParents) {
    const siblings = childIdsByParent.get(edge.parentId);
    if (siblings) {
      siblings.push(childId);
      continue;
    }
    childIdsByParent.set(edge.parentId, [childId]);
  }
  for (const [parentId, childIds] of childIdsByParent) {
    const artifacts = childIds
      .map((id) => artifactsById.get(id))
      .filter((artifact): artifact is ArtifactWithAssignee =>
        Boolean(artifact)
      );
    childIdsByParent.set(
      parentId,
      sortArtifacts(artifacts).map((artifact) => artifact.id)
    );
  }
  return childIdsByParent;
}

/** Depth-first flatten of one root's subtree, matching `TreeNode.children`. */
function flattenChildren(
  rootId: string,
  artifactsById: Map<string, ArtifactWithAssignee>,
  childIdsByParent: Map<string, string[]>,
  canonicalParents: Map<string, ParentEdge>
): TreeChild[] {
  const children: TreeChild[] = [];
  const visited = new Set<string>([rootId]);
  const stack: Array<{ id: string; depth: number }> = [];
  pushChildren(stack, childIdsByParent.get(rootId), 1);

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || visited.has(next.id)) {
      continue;
    }
    visited.add(next.id);
    const artifact = artifactsById.get(next.id);
    const edge = canonicalParents.get(next.id);
    if (!(artifact && edge)) {
      continue;
    }
    children.push({
      ...artifact,
      linkType: edge.linkType ?? LinkType.Produces,
      depth: next.depth,
      parentId: edge.parentId,
    });
    pushChildren(stack, childIdsByParent.get(next.id), next.depth + 1);
  }
  return children;
}

/** Push a sorted sibling list so the LIFO stack still pops it in order. */
function pushChildren(
  stack: Array<{ id: string; depth: number }>,
  childIds: string[] | undefined,
  depth: number
): void {
  if (!childIds) {
    return;
  }
  for (let index = childIds.length - 1; index >= 0; index--) {
    const id = childIds[index];
    if (id) {
      stack.push({ id, depth });
    }
  }
}

/** Deterministic sibling/root ordering: oldest first, id as the tiebreak. */
function sortArtifacts(
  artifacts: ArtifactWithAssignee[]
): ArtifactWithAssignee[] {
  return [...artifacts].sort((a, b) => {
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }
    return a.id.localeCompare(b.id);
  });
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
  const ordered = [
    TreeTruncationReason.AnchorCap,
    TreeTruncationReason.DepthCap,
    TreeTruncationReason.NodeBudget,
  ].filter((reason) => reasons.has(reason));

  return {
    anchorsIncluded: anchors.ids.length,
    anchorsMatchedAtLeast: anchors.matchedAtLeast,
    reasons: ordered,
  };
}
