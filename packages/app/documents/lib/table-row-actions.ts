import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { toRowItem } from "@repo/app/documents/components/table/document-tree";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";

/**
 * Pure helpers behind the documents-table row actions — move, bulk move,
 * bulk delete, and merge candidate resolution (FEA-1763 / PLN-874 Phase 3).
 * Extracted from the page-private `documents-view.tsx`.
 */

export type MovableEntity = { id: string; projectId?: string | null };

export type MoveResolution =
  | { kind: "bulk"; entities: MovableEntity[] }
  | { kind: "single"; entity: MovableEntity }
  | { kind: "none" };

/**
 * Resolve a move action for a single item. If the item is the root of a tree
 * with children, all entities (root + children) move together; the root's
 * projectId scopes the destination filter. Otherwise a single document/feature
 * is moved.
 */
export function computeMoveEntities(
  item: DocumentRowItem,
  treeData: ProjectTreeResponse | null | undefined
): MoveResolution {
  if (!isDocumentRowItem(item)) {
    return { kind: "none" };
  }
  const descendantIds = collectDescendantIds(item.data.id, treeData ?? null);
  if (descendantIds.length > 0) {
    const entities: MovableEntity[] = [
      { id: item.data.id, projectId: item.data.projectId },
      ...descendantIds.map((id) => ({ id })),
    ];
    return { kind: "bulk", entities };
  }
  return {
    kind: "single",
    entity: { id: item.data.id, projectId: item.data.projectId },
  };
}

/**
 * Walk the tree starting at `rootId` and return every transitive descendant
 * id. Works whether `rootId` is a TreeNode root or any nested child — uses
 * the flat children list's `parentId` chain to traverse the subtree.
 */
function collectDescendantIds(
  rootId: string,
  treeData: ProjectTreeResponse | null
): string[] {
  if (!treeData) {
    return [];
  }
  const node = treeData.nodes.find(
    (n) => n.root.id === rootId || n.children.some((c) => c.id === rootId)
  );
  if (!node) {
    return [];
  }
  const descendants: string[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const child of node.children) {
      if (child.parentId === parentId) {
        descendants.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return descendants;
}

export function collectBulkMoveEntities(
  selectedIds: Set<string>,
  documents: DocumentRowData[]
): MovableEntity[] {
  const entities: MovableEntity[] = [];
  for (const id of selectedIds) {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      entities.push({ id: doc.id, projectId: doc.projectId });
    }
  }
  return entities;
}

export async function runBulkDelete(
  pendingIds: Set<string>,
  documents: DocumentRowData[],
  performDelete: (item: DocumentRowItem) => Promise<boolean>
): Promise<boolean> {
  const itemsToDelete: DocumentRowItem[] = [];
  let hasMissing = false;
  for (const id of pendingIds) {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      itemsToDelete.push(toRowItem(doc));
    } else {
      hasMissing = true;
    }
  }
  const results = await Promise.all(itemsToDelete.map(performDelete));
  return !hasMissing && results.every(Boolean);
}

/**
 * Returns the pair of documents to merge when exactly two documents are
 * selected. Returns null otherwise. The merge service rejects Templates
 * server-side (`Cannot merge TEMPLATE artifacts`); other type combinations
 * including Features are allowed.
 */
export function findMergeCandidates(
  selectedIds: Set<string>,
  documents: DocumentRowData[]
): [DocumentRowData, DocumentRowData] | null {
  if (selectedIds.size !== 2) {
    return null;
  }
  const ids = Array.from(selectedIds);
  const d1 = documents.find((d) => d.id === ids[0]);
  const d2 = documents.find((d) => d.id === ids[1]);
  if (d1 && d2) {
    return [d1, d2];
  }
  return null;
}
