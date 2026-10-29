import { type Artifact, LinkType } from "./artifact";
import type { PlaceProjectArtifactsRequest } from "./project-artifact-placement";
import { ProjectArtifactPlacementPosition } from "./project-artifact-placement";
import type { ProjectTreeResponse, TreeChild } from "./project-tree";

type PlacementIntent = Pick<
  PlaceProjectArtifactsRequest,
  "destinationProjectId" | "position" | "sourceArtifactIds" | "targetArtifactId"
>;

type PlacementNode = {
  artifact: Artifact;
  children: PlacementNode[];
  linkType: LinkType;
  parent: PlacementNode | null;
};

/** Apply one stable-id hierarchy placement to the bounded project-tree cache. */
export function applyPlacementToProjectTree(
  tree: ProjectTreeResponse,
  input: PlacementIntent,
  currentProjectId?: string
): ProjectTreeResponse {
  const roots = buildPlacementForest(tree);
  const nodesById = indexPlacementForest(roots);
  const sourceNodes = independentSourceNodes(
    input.sourceArtifactIds,
    nodesById
  );
  if (sourceNodes.length === 0) {
    return tree;
  }
  const movedIds = new Set<string>();
  for (const source of sourceNodes) {
    collectNodeIds(source, movedIds);
  }
  if (
    currentProjectId !== undefined &&
    currentProjectId !== input.destinationProjectId
  ) {
    for (const source of sourceNodes) {
      detachNode(roots, source);
    }
    return { ...tree, nodes: serializePlacementForest(roots) };
  }
  if (input.targetArtifactId && movedIds.has(input.targetArtifactId)) {
    return tree;
  }
  if (
    input.position !== ProjectArtifactPlacementPosition.Root &&
    !(input.targetArtifactId && nodesById.has(input.targetArtifactId))
  ) {
    return tree;
  }

  for (const source of sourceNodes) {
    detachNode(roots, source);
  }
  const destination = resolveDestination(
    roots,
    nodesById,
    input.position,
    input.targetArtifactId
  );
  if (!destination) {
    return tree;
  }
  destination.siblings.splice(destination.index, 0, ...sourceNodes);
  for (const source of sourceNodes) {
    source.parent = destination.parent;
    source.linkType = LinkType.Produces;
  }
  return { ...tree, nodes: serializePlacementForest(roots) };
}

/** Apply a cross-project move to both cached trees without dropping the destination copy. */
export function applyPlacementAcrossProjectTrees(
  sourceTree: ProjectTreeResponse,
  destinationTree: ProjectTreeResponse,
  input: PlacementIntent
): { source: ProjectTreeResponse; destination: ProjectTreeResponse } {
  const sourceRoots = buildPlacementForest(sourceTree);
  const sourceNodes = independentSourceNodes(
    input.sourceArtifactIds,
    indexPlacementForest(sourceRoots)
  );
  if (sourceNodes.length === 0) {
    return { source: sourceTree, destination: destinationTree };
  }
  const destinationRoots = buildPlacementForest(destinationTree);
  const destinationNodes = indexPlacementForest(destinationRoots);
  const destination = resolveDestination(
    destinationRoots,
    destinationNodes,
    input.position,
    input.targetArtifactId
  );
  if (!destination) {
    return { source: sourceTree, destination: destinationTree };
  }
  for (const source of sourceNodes) {
    detachNode(sourceRoots, source);
    moveNodeToProject(source, input.destinationProjectId);
  }
  destination.siblings.splice(destination.index, 0, ...sourceNodes);
  for (const source of sourceNodes) {
    source.parent = destination.parent;
    source.linkType = LinkType.Produces;
  }
  return {
    source: { ...sourceTree, nodes: serializePlacementForest(sourceRoots) },
    destination: {
      ...destinationTree,
      nodes: serializePlacementForest(destinationRoots),
    },
  };
}

function buildPlacementForest(tree: ProjectTreeResponse): PlacementNode[] {
  return tree.nodes.map((treeNode) => {
    const root: PlacementNode = {
      artifact: treeNode.root,
      children: [],
      linkType: LinkType.Produces,
      parent: null,
    };
    const local = new Map<string, PlacementNode>([[root.artifact.id, root]]);
    for (const child of treeNode.children) {
      local.set(child.id, {
        artifact: child,
        children: [],
        linkType: child.linkType,
        parent: null,
      });
    }
    for (const child of treeNode.children) {
      const node = local.get(child.id);
      const parent = local.get(child.parentId);
      if (node && parent) {
        node.parent = parent;
        parent.children.push(node);
      }
    }
    return root;
  });
}

function indexPlacementForest(
  roots: PlacementNode[]
): Map<string, PlacementNode> {
  const result = new Map<string, PlacementNode>();
  const visit = (node: PlacementNode) => {
    result.set(node.artifact.id, node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return result;
}

function independentSourceNodes(
  sourceIds: string[],
  nodesById: ReadonlyMap<string, PlacementNode>
): PlacementNode[] {
  const selected = new Set(sourceIds);
  return sourceIds.flatMap((id) => {
    const node = nodesById.get(id);
    if (!node) {
      return [];
    }
    let parent = node.parent;
    while (parent) {
      if (selected.has(parent.artifact.id)) {
        return [];
      }
      parent = parent.parent;
    }
    return [node];
  });
}

function collectNodeIds(node: PlacementNode, result: Set<string>): void {
  result.add(node.artifact.id);
  for (const child of node.children) {
    collectNodeIds(child, result);
  }
}

function moveNodeToProject(node: PlacementNode, projectId: string): void {
  node.artifact = { ...node.artifact, projectId };
  for (const child of node.children) {
    moveNodeToProject(child, projectId);
  }
}

function detachNode(roots: PlacementNode[], node: PlacementNode): void {
  const siblings = node.parent?.children ?? roots;
  const index = siblings.indexOf(node);
  if (index >= 0) {
    siblings.splice(index, 1);
  }
}

function resolveDestination(
  roots: PlacementNode[],
  nodesById: ReadonlyMap<string, PlacementNode>,
  position: PlaceProjectArtifactsRequest["position"],
  targetArtifactId: string | undefined
): {
  siblings: PlacementNode[];
  index: number;
  parent: PlacementNode | null;
} | null {
  if (position === ProjectArtifactPlacementPosition.Root) {
    return { siblings: roots, index: roots.length, parent: null };
  }
  if (!targetArtifactId) {
    return null;
  }
  const target = nodesById.get(targetArtifactId);
  if (!target) {
    return null;
  }
  if (position === ProjectArtifactPlacementPosition.Inside) {
    return { siblings: target.children, index: 0, parent: target };
  }
  const siblings = target.parent?.children ?? roots;
  const targetIndex = siblings.indexOf(target);
  if (targetIndex < 0) {
    return null;
  }
  return {
    siblings,
    index:
      position === ProjectArtifactPlacementPosition.After
        ? targetIndex + 1
        : targetIndex,
    parent: target.parent,
  };
}

function serializePlacementForest(
  roots: PlacementNode[]
): ProjectTreeResponse["nodes"] {
  return roots.map((root) => ({
    root: root.artifact,
    children: serializeChildren(root),
  }));
}

function serializeChildren(root: PlacementNode): TreeChild[] {
  const children: TreeChild[] = [];
  const visit = (parent: PlacementNode, depth: number) => {
    for (const child of parent.children) {
      children.push({
        ...child.artifact,
        depth,
        linkType: child.linkType,
        parentId: parent.artifact.id,
      });
      visit(child, depth + 1);
    }
  };
  visit(root, 1);
  return children;
}
