import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import type { TreeChild, TreeNode } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";

/**
 * Convert a document to a DocumentRowItem. All document subtypes (PRD, Plan,
 * Feature) share the "document" kind — per-subtype styling and routing come
 * from the row-type registry keyed on `data.type`.
 */
export function toRowItem(doc: DocumentRowData): DocumentRowItem {
  return { kind: "document", data: doc };
}

export function isFeatureDoc(doc: DocumentRowData): boolean {
  return doc.type === DocumentType.Feature;
}

export function isDocumentArtifact(artifact: Artifact): boolean {
  return artifact.type === ArtifactType.Document;
}

export function getItemTitle(item: DocumentRowItem): string {
  if (item.kind === "document") {
    return item.data.title;
  }
  return item.data.name;
}

// ---- Tree-based grouping ----

/** Unified group shape used by the tree grouping path. */
export type DisplayGroup = {
  groupKey: string;
  root: DocumentRowItem;
  children: DocumentRowItem[];
};

function treeEntityToRowItem(
  entity: Artifact,
  documentMap: Map<string, DocumentRowData>
): DocumentRowItem | null {
  switch (entity.type) {
    case ArtifactType.Document: {
      const doc = documentMap.get(entity.id);
      return doc ? toRowItem(doc) : null;
    }
    case ArtifactType.Branch:
      return { kind: "branch", data: entity };
    case ArtifactType.Session:
      return { kind: "session", data: entity };
    // Deployments are deliberately excluded from the documents table — a
    // product decision, not an oversight (FEA-1763). Revisit there if
    // deployments should ever surface in this view.
    case ArtifactType.Deployment:
      return null;
    default: {
      // Exhaustiveness check: a new ArtifactType must be handled explicitly
      // above (rendered or excluded) — it must never silently vanish.
      const unhandled: never = entity.type;
      return unhandled;
    }
  }
}

function buildNestedChildrenFromDFS(
  rootId: string,
  treeChildren: TreeChild[],
  documentMap: Map<string, DocumentRowData>,
  seenIds: Set<string>
): DocumentRowItem[] {
  const itemsById = new Map<string, DocumentRowItem>();
  for (const child of treeChildren) {
    if (itemsById.has(child.id)) {
      continue;
    }
    const childItem = treeEntityToRowItem(child, documentMap);
    if (childItem) {
      childItem.children = [];
      itemsById.set(child.id, childItem);
      seenIds.add(child.id);
    }
  }

  const directChildren: DocumentRowItem[] = [];
  for (const child of treeChildren) {
    const item = itemsById.get(child.id);
    if (!item) {
      continue;
    }
    const parent =
      child.parentId === rootId ? null : itemsById.get(child.parentId);
    if (parent) {
      if (!parent.children) {
        parent.children = [];
      }
      parent.children.push(item);
    } else {
      directChildren.push(item);
    }
  }

  pruneEmptyChildren(directChildren);
  return directChildren;
}

function pruneEmptyChildren(items: DocumentRowItem[]): void {
  for (const item of items) {
    if (!item.children) {
      continue;
    }
    if (item.children.length === 0) {
      item.children = undefined;
    } else {
      pruneEmptyChildren(item.children);
    }
  }
}

export function groupByProjectTree(
  nodes: TreeNode[],
  documents: DocumentRowData[]
): DisplayGroup[] {
  const documentMap = new Map(documents.map((d) => [d.id, d]));
  const seenIds = new Set<string>();
  const groups: DisplayGroup[] = [];

  for (const node of nodes) {
    const root = treeEntityToRowItem(node.root, documentMap);
    if (!root) {
      continue;
    }
    seenIds.add(node.root.id);

    const children = buildNestedChildrenFromDFS(
      node.root.id,
      node.children,
      documentMap,
      seenIds
    );
    groups.push({ groupKey: node.root.id, root, children });
  }

  for (const doc of documents) {
    if (!seenIds.has(doc.id)) {
      groups.push({
        groupKey: doc.id,
        root: toRowItem(doc),
        children: [],
      });
    }
  }

  return groups;
}

export type FilteredDisplayGroups = {
  groups: DisplayGroup[];
  /**
   * Ids of nodes retained only as context (they do not match the filter but
   * have a matching descendant). These must be force-expanded so the matching
   * descendant is actually visible, since tree groups are collapsed by default.
   */
  contextExpandedIds: Set<string>;
};

/**
 * Recursively filter tree items, keeping any item that matches the predicate
 * along with the ancestor chain needed to reach it. A matching item retains its
 * entire subtree; a non-matching item is kept only as context when it has a
 * matching descendant, and its children are pruned to the matching branches.
 * Ids of context-only nodes are collected into `contextExpandedIds`.
 */
function filterTreeItems(
  items: DocumentRowItem[],
  matches: (item: DocumentRowItem) => boolean,
  contextExpandedIds: Set<string>
): DocumentRowItem[] {
  const result: DocumentRowItem[] = [];
  for (const item of items) {
    if (matches(item)) {
      result.push(item);
      continue;
    }
    const filteredChildren = item.children
      ? filterTreeItems(item.children, matches, contextExpandedIds)
      : [];
    if (filteredChildren.length > 0) {
      contextExpandedIds.add(item.data.id);
      result.push({ ...item, children: filteredChildren });
    }
  }
  return result;
}

/**
 * Apply a match predicate to a tree-grouped document list. A group is retained
 * when its root matches (the whole subtree is preserved) or when any descendant
 * matches (the root is kept as context and the subtree is pruned to the matching
 * branches). This ensures sub-items matching the filter remain visible even when
 * their parent does not match. Returns new groups (input is not mutated) plus
 * the set of context-only node ids that should be force-expanded.
 */
export function filterDisplayGroups(
  groups: DisplayGroup[],
  matches: (item: DocumentRowItem) => boolean
): FilteredDisplayGroups {
  const result: DisplayGroup[] = [];
  const contextExpandedIds = new Set<string>();
  for (const group of groups) {
    if (matches(group.root)) {
      result.push(group);
      continue;
    }
    const filteredChildren = filterTreeItems(
      group.children,
      matches,
      contextExpandedIds
    );
    if (filteredChildren.length > 0) {
      contextExpandedIds.add(group.groupKey);
      result.push({ ...group, children: filteredChildren });
    }
  }
  return { groups: result, contextExpandedIds };
}

/**
 * Collect every artifact of one type from the project tree as flat row items
 * (deduplicated; an artifact can appear as a root and as another root's
 * child). Backs the category tabs that list non-document artifacts — e.g.
 * the Branches tab renders `collectArtifactRowItems(nodes, ArtifactType.Branch)`
 * through the standard flat table pipeline (FEA-1763 Phase 2).
 */
export function collectArtifactRowItems(
  nodes: TreeNode[],
  // Narrowed to the non-document artifact types: document rows require the
  // documentMap lookup in `treeEntityToRowItem`, which this collector does
  // not have — passing ArtifactType.Document would silently return nothing.
  type: typeof ArtifactType.Branch | typeof ArtifactType.Session
): DocumentRowItem[] {
  const seen = new Set<string>();
  const items: DocumentRowItem[] = [];
  for (const node of nodes) {
    for (const entity of [node.root, ...node.children]) {
      if (entity.type !== type || seen.has(entity.id)) {
        continue;
      }
      seen.add(entity.id);
      // Empty document map is safe here: only the Document case of
      // `treeEntityToRowItem` reads it, and the `type` param excludes it.
      const item = treeEntityToRowItem(entity, new Map());
      if (item) {
        items.push(item);
      }
    }
  }
  return items;
}
