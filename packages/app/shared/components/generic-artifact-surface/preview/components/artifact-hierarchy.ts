import type { GenericArtifact } from "../fixtures";

export type ArtifactHierarchyNode = {
  artifact: GenericArtifact;
  children: ArtifactHierarchyNode[];
};

export type VisibleArtifactHierarchyRow = {
  artifact: GenericArtifact;
  depth: number;
  hasChildren: boolean;
};

export type VisibleArtifactRootGroup = {
  root: GenericArtifact;
  artifacts: GenericArtifact[];
};

export type FilteredArtifactHierarchy = {
  ancestorIds: Set<string>;
  artifacts: GenericArtifact[];
};

export type ArtifactHierarchyDropPlacement = "after" | "before" | "inside";

export type ArtifactHierarchyMoveResult = {
  artifacts: GenericArtifact[];
  changed: boolean;
  descendantCount: number;
  error?: "cycle" | "depth" | "missing" | "same-artifact";
  nextParentId: string | null;
  previousParentId: string | null;
};

export type ArtifactProjectMoveResult = {
  descendantCount: number;
  movedArtifacts: GenericArtifact[];
  parentClearedCount: number;
  remainingArtifacts: GenericArtifact[];
};

/** Keep the existing subtree move message consistent across both hierarchy writers. */
export function formatArtifactHierarchyMoveMessage(
  descendantCount: number
): string {
  return descendantCount > 0
    ? `Moved with ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`
    : "Moved";
}

/**
 * Builds a stable forest from the caller's artifact order. Missing parents and
 * cycle-only components become roots so malformed prototype data stays visible.
 */
export function buildArtifactHierarchyForest(
  artifacts: readonly GenericArtifact[]
): ArtifactHierarchyNode[] {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const childrenByParentId = new Map<string, GenericArtifact[]>();
  const rootArtifacts: GenericArtifact[] = [];

  for (const artifact of artifacts) {
    const parentId = artifact.parentArtifactId;
    if (!(parentId && parentId !== artifact.id && artifactIds.has(parentId))) {
      rootArtifacts.push(artifact);
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(artifact);
    childrenByParentId.set(parentId, children);
  }

  const visited = new Set<string>();
  const buildNode = (
    artifact: GenericArtifact,
    ancestors: ReadonlySet<string>
  ): ArtifactHierarchyNode => {
    visited.add(artifact.id);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(artifact.id);
    const children = (childrenByParentId.get(artifact.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => buildNode(child, nextAncestors));
    return { artifact, children };
  };

  const forest = rootArtifacts.map((artifact) =>
    buildNode(artifact, new Set())
  );
  for (const artifact of artifacts) {
    if (!visited.has(artifact.id)) {
      forest.push(buildNode(artifact, new Set()));
    }
  }
  return forest;
}

export function flattenVisibleArtifactHierarchy(
  forest: readonly ArtifactHierarchyNode[],
  expandedArtifactIds: ReadonlySet<string>,
  maxVisibleLevels: number
): VisibleArtifactHierarchyRow[] {
  const rows: VisibleArtifactHierarchyRow[] = [];
  const maxDepth = Math.max(0, maxVisibleLevels - 1);

  const appendNode = (node: ArtifactHierarchyNode, depth: number) => {
    const hasChildren = depth < maxDepth && node.children.length > 0;
    rows.push({ artifact: node.artifact, depth, hasChildren });
    if (!(hasChildren && expandedArtifactIds.has(node.artifact.id))) {
      return;
    }
    for (const child of node.children) {
      appendNode(child, depth + 1);
    }
  };

  for (const node of forest) {
    appendNode(node, 0);
  }
  return rows;
}

export function artifactParentIds(
  artifacts: readonly GenericArtifact[]
): Set<string> {
  return new Set(
    artifacts.flatMap((artifact) =>
      artifact.parentArtifactId ? [artifact.parentArtifactId] : []
    )
  );
}

/**
 * Preserves the user's expansion choices across a hierarchy move. Nodes that
 * no longer have children lose their dormant expansion state, while an
 * explicit inside drop opens only its direct destination parent.
 */
export function expansionAfterArtifactHierarchyMove(
  artifacts: readonly GenericArtifact[],
  expandedArtifactIds: ReadonlySet<string>,
  insideTargetId?: string
): Set<string> {
  const parentIds = artifactParentIds(artifacts);
  const next = new Set(
    [...expandedArtifactIds].filter((artifactId) => parentIds.has(artifactId))
  );
  if (insideTargetId && parentIds.has(insideTargetId)) {
    next.add(insideTargetId);
  }
  return next;
}

/**
 * Collapses a multi-selection to independently movable subtree roots. A child
 * whose ancestor is selected is already represented by that ancestor and must
 * not be moved or counted twice in one drag transaction.
 */
export function normalizeArtifactHierarchySelection(
  artifacts: readonly GenericArtifact[],
  selectedArtifactIds: ReadonlySet<string>
): string[] {
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact])
  );
  return artifacts.flatMap((artifact) => {
    if (!selectedArtifactIds.has(artifact.id)) {
      return [];
    }
    const visited = new Set<string>([artifact.id]);
    let parentId = artifact.parentArtifactId;
    while (parentId && !visited.has(parentId)) {
      if (selectedArtifactIds.has(parentId)) {
        return [];
      }
      visited.add(parentId);
      parentId = artifactsById.get(parentId)?.parentArtifactId;
    }
    return [artifact.id];
  });
}

/**
 * Extracts complete selected subtrees for a cross-project move. Independently
 * moved children become roots in the destination; descendants preserve their
 * internal relationships and every moved artifact receives the new project.
 */
export function moveArtifactHierarchySelectionToProject(
  artifacts: readonly GenericArtifact[],
  sourceArtifactIds: readonly string[],
  destinationProject: string
): ArtifactProjectMoveResult {
  const normalizedSourceIds = normalizeArtifactHierarchySelection(
    artifacts,
    new Set(sourceArtifactIds)
  );
  const forest = buildArtifactHierarchyForest(artifacts);
  const movedIds = new Set<string>();
  for (const sourceId of normalizedSourceIds) {
    const source = findHierarchyLocation(forest, sourceId);
    if (!source) {
      continue;
    }
    for (const artifactId of hierarchyNodeIds(source.node)) {
      movedIds.add(artifactId);
    }
  }
  const sourceIdSet = new Set(normalizedSourceIds);
  const movedArtifacts = artifacts.flatMap((artifact) => {
    if (!movedIds.has(artifact.id)) {
      return [];
    }
    return [
      {
        ...artifact,
        parentArtifactId: sourceIdSet.has(artifact.id)
          ? null
          : artifact.parentArtifactId,
        project: destinationProject,
      },
    ];
  });
  return {
    descendantCount: Math.max(
      0,
      movedArtifacts.length - normalizedSourceIds.length
    ),
    movedArtifacts,
    parentClearedCount: normalizedSourceIds.filter((sourceId) =>
      Boolean(
        artifacts.find((artifact) => artifact.id === sourceId)?.parentArtifactId
      )
    ).length,
    remainingArtifacts: artifacts.filter(
      (artifact) => !movedIds.has(artifact.id)
    ),
  };
}

/** Keeps each visible root and its descendants together as one grouping unit. */
export function groupVisibleHierarchyRowsByRoot(
  rows: readonly VisibleArtifactHierarchyRow[]
): VisibleArtifactRootGroup[] {
  const groups: VisibleArtifactRootGroup[] = [];
  let current: VisibleArtifactRootGroup | undefined;
  for (const row of rows) {
    if (row.depth === 0 || !current) {
      current = { artifacts: [row.artifact], root: row.artifact };
      groups.push(current);
      continue;
    }
    current.artifacts.push(row.artifact);
  }
  return groups;
}

/**
 * Retains direct matches plus every ancestor required to show their lineage.
 * Nonmatching sibling branches and descendants are omitted.
 */
export function retainArtifactMatchesWithAncestors(
  artifacts: readonly GenericArtifact[],
  matchedArtifactIds: ReadonlySet<string>
): FilteredArtifactHierarchy {
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact])
  );
  const includedIds = new Set(matchedArtifactIds);
  const ancestorIds = new Set<string>();

  for (const matchedId of matchedArtifactIds) {
    const visited = new Set<string>([matchedId]);
    let parentId = artifactsById.get(matchedId)?.parentArtifactId;
    while (parentId && !visited.has(parentId)) {
      const parent = artifactsById.get(parentId);
      if (!parent) {
        break;
      }
      visited.add(parentId);
      includedIds.add(parentId);
      ancestorIds.add(parentId);
      parentId = parent.parentArtifactId;
    }
  }

  return {
    ancestorIds,
    artifacts: artifacts.filter((artifact) => includedIds.has(artifact.id)),
  };
}

/** Sorts logical root units without disturbing sibling order inside a subtree. */
export function sortArtifactHierarchyRoots(
  forest: readonly ArtifactHierarchyNode[],
  compare: (left: GenericArtifact, right: GenericArtifact) => number
): ArtifactHierarchyNode[] {
  return [...forest].sort((left, right) =>
    compare(left.artifact, right.artifact)
  );
}

type MutableHierarchyLocation = {
  depth: number;
  index: number;
  node: ArtifactHierarchyNode;
  parentId: string | null;
  siblings: ArtifactHierarchyNode[];
};

function findHierarchyLocation(
  forest: ArtifactHierarchyNode[],
  artifactId: string
): MutableHierarchyLocation | undefined {
  const visit = (
    siblings: ArtifactHierarchyNode[],
    parentId: string | null,
    depth: number
  ): MutableHierarchyLocation | undefined => {
    for (const [index, node] of siblings.entries()) {
      if (node.artifact.id === artifactId) {
        return { depth, index, node, parentId, siblings };
      }
      const child = visit(node.children, node.artifact.id, depth + 1);
      if (child) {
        return child;
      }
    }
    return undefined;
  };
  return visit(forest, null, 0);
}

function hierarchyNodeHeight(node: ArtifactHierarchyNode): number {
  return (
    1 +
    node.children.reduce(
      (height, child) => Math.max(height, hierarchyNodeHeight(child)),
      0
    )
  );
}

function hierarchyNodeIds(node: ArtifactHierarchyNode): Set<string> {
  const ids = new Set<string>();
  const visit = (candidate: ArtifactHierarchyNode) => {
    ids.add(candidate.artifact.id);
    for (const child of candidate.children) {
      visit(child);
    }
  };
  visit(node);
  return ids;
}

function flattenHierarchyForest(
  forest: readonly ArtifactHierarchyNode[]
): GenericArtifact[] {
  const artifacts: GenericArtifact[] = [];
  const visit = (node: ArtifactHierarchyNode) => {
    artifacts.push(node.artifact);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of forest) {
    visit(node);
  }
  return artifacts;
}

/**
 * Moves one complete subtree before, after, or inside another artifact. The
 * flat artifact array remains a stable depth-first representation while the
 * structural parent id changes only on the moved subtree root.
 */
export function moveArtifactHierarchySubtree(
  artifacts: readonly GenericArtifact[],
  sourceArtifactId: string,
  targetArtifactId: string,
  placement: ArtifactHierarchyDropPlacement,
  maxLevels: number
): ArtifactHierarchyMoveResult {
  const unchanged = (
    error: ArtifactHierarchyMoveResult["error"],
    previousParentId: string | null = null
  ): ArtifactHierarchyMoveResult => ({
    artifacts: [...artifacts],
    changed: false,
    descendantCount: 0,
    error,
    nextParentId: previousParentId,
    previousParentId,
  });
  if (sourceArtifactId === targetArtifactId) {
    return unchanged("same-artifact");
  }

  const forest = buildArtifactHierarchyForest(artifacts);
  const source = findHierarchyLocation(forest, sourceArtifactId);
  const target = findHierarchyLocation(forest, targetArtifactId);
  if (!(source && target)) {
    return unchanged("missing", source?.parentId ?? null);
  }

  const sourceIds = hierarchyNodeIds(source.node);
  const destinationParentId =
    placement === "inside" ? target.node.artifact.id : target.parentId;
  if (
    sourceIds.has(targetArtifactId) ||
    (destinationParentId && sourceIds.has(destinationParentId))
  ) {
    return unchanged("cycle", source.parentId);
  }

  const destinationDepth =
    placement === "inside" ? target.depth + 1 : target.depth;
  if (destinationDepth + hierarchyNodeHeight(source.node) > maxLevels) {
    return unchanged("depth", source.parentId);
  }

  const previousOrder = artifacts.map((artifact) => artifact.id).join("/");
  const previousParentId = source.parentId;
  const [sourceNode] = source.siblings.splice(source.index, 1);
  if (!sourceNode) {
    return unchanged("missing", previousParentId);
  }

  const refreshedTarget = findHierarchyLocation(forest, targetArtifactId);
  if (!refreshedTarget) {
    return unchanged("missing", previousParentId);
  }
  if (placement === "inside") {
    refreshedTarget.node.children.unshift(sourceNode);
  } else {
    refreshedTarget.siblings.splice(
      refreshedTarget.index + (placement === "after" ? 1 : 0),
      0,
      sourceNode
    );
  }
  sourceNode.artifact = {
    ...sourceNode.artifact,
    parentArtifactId: destinationParentId,
  };

  const nextArtifacts = flattenHierarchyForest(forest);
  const nextOrder = nextArtifacts.map((artifact) => artifact.id).join("/");
  return {
    artifacts: nextArtifacts,
    changed:
      previousOrder !== nextOrder || previousParentId !== destinationParentId,
    descendantCount: Math.max(0, sourceIds.size - 1),
    nextParentId: destinationParentId,
    previousParentId,
  };
}

/**
 * Read-only eligibility check used while a pointer is moving. Invalid hierarchy
 * destinations are intentionally silent and simply do not become drop targets.
 */
export function canMoveArtifactHierarchySubtree(
  artifacts: readonly GenericArtifact[],
  sourceArtifactId: string,
  targetArtifactId: string,
  placement: ArtifactHierarchyDropPlacement,
  maxLevels: number
): boolean {
  const result = moveArtifactHierarchySubtree(
    artifacts,
    sourceArtifactId,
    targetArtifactId,
    placement,
    maxLevels
  );
  return result.error == null && result.changed;
}

/** Validates a normalized multi-selection as one atomic move transaction. */
export function canMoveArtifactHierarchySelection(
  artifacts: readonly GenericArtifact[],
  sourceArtifactIds: readonly string[],
  targetArtifactId: string,
  placement: ArtifactHierarchyDropPlacement,
  maxLevels: number
): boolean {
  if (
    sourceArtifactIds.length === 0 ||
    sourceArtifactIds.includes(targetArtifactId)
  ) {
    return false;
  }
  let nextArtifacts = [...artifacts];
  let changed = false;
  const moveOrder =
    placement === "after"
      ? [...sourceArtifactIds].reverse()
      : sourceArtifactIds;
  for (const sourceArtifactId of moveOrder) {
    const result = moveArtifactHierarchySubtree(
      nextArtifacts,
      sourceArtifactId,
      targetArtifactId,
      placement,
      maxLevels
    );
    if (result.error) {
      return false;
    }
    changed ||= result.changed;
    nextArtifacts = result.artifacts;
  }
  return changed;
}
