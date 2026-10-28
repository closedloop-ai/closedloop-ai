import { LinkType } from "@repo/api/src/types/artifact";
import type {
  DetailedTreeChild,
  ProjectTreeDetailsResponse,
  ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { HierarchyAvailability } from "@repo/api/src/types/project-tree";

/** All reachable artifact IDs, only when the hierarchy snapshot is complete. */
export function completeProjectTreeArtifactIds(
  tree: ProjectTreeResponse | null | undefined
): ReadonlySet<string> | null {
  if (!tree) {
    return null;
  }
  if (!tree.hierarchy) {
    if (tree.truncation) {
      return null;
    }
    return collectTreeArtifactIds(tree);
  }
  if (
    !tree.hierarchy.diagnosticsComplete ||
    tree.hierarchy.rootNextCursor ||
    tree.nodes.some(
      (node) =>
        node.hierarchy?.availability !== HierarchyAvailability.Complete ||
        node.children.some(
          (child) =>
            child.hierarchy?.availability !== HierarchyAvailability.Complete
        )
    )
  ) {
    return null;
  }
  return collectTreeArtifactIds(tree);
}

/** Parents whose expanded projection is known to omit at least one direct child. */
export function hierarchyExpansionParentIds(
  tree: ProjectTreeResponse | null | undefined,
  isExpanded: (artifactId: string) => boolean
): string[] {
  if (tree?.hierarchy?.capabilities.childPaging !== true) {
    return [];
  }
  const directChildCounts = new Map<string, number>();
  for (const node of tree.nodes) {
    for (const child of node.children) {
      directChildCounts.set(
        child.parentId,
        (directChildCounts.get(child.parentId) ?? 0) + 1
      );
    }
  }
  const parents: string[] = [];
  for (const node of tree.nodes) {
    collectIncompleteParent(
      parents,
      node.root.id,
      node.hierarchy?.childCount,
      directChildCounts,
      isExpanded
    );
    for (const child of node.children) {
      collectIncompleteParent(
        parents,
        child.id,
        child.hierarchy?.childCount,
        directChildCounts,
        isExpanded
      );
    }
  }
  return parents;
}

/** Merge fully fetched direct-child pages into the canonical rendered tree. */
export function mergeProjectTreeExpansionPages(
  tree: ProjectTreeDetailsResponse,
  pageGroups: readonly (readonly ProjectTreeDetailsResponse[])[]
): ProjectTreeDetailsResponse {
  const childrenById = new Map<string, DetailedTreeChild>();
  const childOrderByParent = new Map<string, string[]>();
  const hierarchyById = new Map(
    tree.nodes.flatMap((node) => [
      [node.root.id, node.hierarchy] as const,
      ...node.children.map((child) => [child.id, child.hierarchy] as const),
    ])
  );
  for (const node of tree.nodes) {
    indexChildren(node.children, childrenById, childOrderByParent);
  }
  for (const pages of pageGroups) {
    const parentId = pages[0]?.hierarchy?.parentArtifactId;
    if (!parentId) {
      continue;
    }
    const directIds: string[] = [];
    for (const page of pages) {
      for (const node of page.nodes) {
        directIds.push(node.root.id);
        childrenById.set(node.root.id, {
          ...node.root,
          depth: 1,
          hierarchy: node.hierarchy,
          linkType: LinkType.Produces,
          parentId,
        });
        indexChildren(node.children, childrenById, childOrderByParent);
      }
    }
    childOrderByParent.set(parentId, [...new Set(directIds)]);
    const continuation = pages.at(-1)?.hierarchy?.nextCursor;
    hierarchyById.set(parentId, {
      availability: continuation
        ? HierarchyAvailability.Partial
        : HierarchyAvailability.Complete,
      childCount: pages.at(-1)?.hierarchy?.childCount ?? directIds.length,
      ...(continuation && { nextCursor: continuation }),
      ...(hierarchyById.get(parentId)?.canMove !== undefined && {
        canMove: hierarchyById.get(parentId)?.canMove,
      }),
      ...(hierarchyById.get(parentId)?.hierarchyPath && {
        hierarchyPath: hierarchyById.get(parentId)?.hierarchyPath,
      }),
    });
  }
  return {
    ...tree,
    nodes: tree.nodes.map((node) => ({
      ...node,
      hierarchy: hierarchyById.get(node.root.id),
      children: flattenMergedChildren(
        node.root.id,
        1,
        childrenById,
        childOrderByParent,
        new Set([node.root.id])
      ),
    })),
  };
}

function indexChildren(
  children: readonly DetailedTreeChild[],
  childrenById: Map<string, DetailedTreeChild>,
  childOrderByParent: Map<string, string[]>
): void {
  for (const child of children) {
    childrenById.set(child.id, child);
    const order = childOrderByParent.get(child.parentId) ?? [];
    if (!order.includes(child.id)) {
      order.push(child.id);
      childOrderByParent.set(child.parentId, order);
    }
  }
}

function flattenMergedChildren(
  parentId: string,
  depth: number,
  childrenById: ReadonlyMap<string, DetailedTreeChild>,
  childOrderByParent: ReadonlyMap<string, readonly string[]>,
  ancestors: ReadonlySet<string>
): DetailedTreeChild[] {
  const flattened: DetailedTreeChild[] = [];
  for (const childId of childOrderByParent.get(parentId) ?? []) {
    const child = childrenById.get(childId);
    if (!child || ancestors.has(childId)) {
      continue;
    }
    flattened.push(
      { ...child, depth, parentId },
      ...flattenMergedChildren(
        childId,
        depth + 1,
        childrenById,
        childOrderByParent,
        new Set([...ancestors, childId])
      )
    );
  }
  return flattened;
}

function collectIncompleteParent(
  parents: string[],
  artifactId: string,
  childCount: number | undefined,
  directChildCounts: ReadonlyMap<string, number>,
  isExpanded: (artifactId: string) => boolean
): void {
  if (
    childCount !== undefined &&
    childCount > (directChildCounts.get(artifactId) ?? 0) &&
    isExpanded(artifactId)
  ) {
    parents.push(artifactId);
  }
}

function collectTreeArtifactIds(
  tree: ProjectTreeResponse
): ReadonlySet<string> {
  return new Set(
    tree.nodes.flatMap((node) => [
      node.root.id,
      ...node.children.map((child) => child.id),
    ])
  );
}
