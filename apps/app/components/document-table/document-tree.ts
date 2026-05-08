import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import type { TreeChild, TreeNode } from "@repo/api/src/types/project-tree";
import type { WorkstreamState } from "@repo/api/src/types/workstream";
import type { DocumentRowItem } from "@/components/document-table/document-row";

/**
 * Convert a document to a DocumentRowItem. Feature-typed documents render
 * with the "feature" kind so row-level components can style / route them
 * differently from other document types.
 */
export function toRowItem(doc: DocumentWithWorkstream): DocumentRowItem {
  return doc.type === DocumentType.Feature
    ? { kind: "feature", data: doc }
    : { kind: "artifact", data: doc };
}

export function isFeatureDoc(doc: DocumentWithWorkstream): boolean {
  return doc.type === DocumentType.Feature;
}

export function isDocumentArtifact(artifact: Artifact): boolean {
  return artifact.type === ArtifactType.Document;
}

// ---- Workstream grouping ----

type WorkstreamGroup = {
  id: string | null;
  groupKey: string;
  title: string;
  state: WorkstreamState | null;
  items: DocumentRowItem[];
};

const TYPE_ORDER: Record<DocumentType, number> = {
  [DocumentType.Prd]: 0,
  [DocumentType.Feature]: 1,
  [DocumentType.ImplementationPlan]: 2,
  [DocumentType.Template]: 3,
};

const UNASSIGNED_KEY_PREFIX = "unassigned:" as const;

function getItemTypeOrder(item: DocumentRowItem): number {
  if (item.kind === "project" || item.kind === "branch") {
    return 99;
  }
  return TYPE_ORDER[item.data.type] ?? 99;
}

export function getItemTitle(item: DocumentRowItem): string {
  if (item.kind === "project" || item.kind === "branch") {
    return item.data.name;
  }
  return item.data.title;
}

function sortItemsByType(items: DocumentRowItem[]): DocumentRowItem[] {
  return [...items].sort((a, b) => getItemTypeOrder(a) - getItemTypeOrder(b));
}

function deriveGroupTitle(
  workstreamTitle: string | null | undefined,
  items: DocumentRowItem[]
): string {
  if (workstreamTitle) {
    return workstreamTitle;
  }
  const prd = items.find(
    (i) =>
      i.kind !== "project" &&
      i.kind !== "branch" &&
      i.data.type === DocumentType.Prd
  );
  if (prd && prd.kind !== "project" && prd.kind !== "branch") {
    return prd.data.title;
  }
  return "Unassigned";
}

function buildUnassignedKey(doc: DocumentWithWorkstream): string {
  return doc.type === DocumentType.Prd
    ? `${UNASSIGNED_KEY_PREFIX}${doc.id}`
    : `${UNASSIGNED_KEY_PREFIX}shared`;
}

export function groupByWorkstream(
  documents: DocumentWithWorkstream[]
): WorkstreamGroup[] {
  const groups = new Map<string, WorkstreamGroup>();
  const workstreamTitles = new Map<string, string | null | undefined>();

  for (const doc of documents) {
    const key = doc.workstreamId ?? buildUnassignedKey(doc);

    if (!groups.has(key)) {
      groups.set(key, {
        id: doc.workstreamId,
        groupKey: key,
        title: "",
        state: doc.workstream?.state ?? null,
        items: [],
      });
      workstreamTitles.set(key, doc.workstream?.title);
    }
    groups.get(key)?.items.push(toRowItem(doc));
  }

  for (const [key, group] of groups) {
    group.title = deriveGroupTitle(workstreamTitles.get(key), group.items);
    group.items = sortItemsByType(group.items);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.id === null && b.id === null) {
      return a.title.localeCompare(b.title);
    }
    if (a.id === null) {
      return 1;
    }
    if (b.id === null) {
      return -1;
    }
    return a.title.localeCompare(b.title);
  });
}

// ---- Tree-based grouping ----

/** Unified group shape used by both workstream and tree grouping paths. */
export type DisplayGroup = {
  groupKey: string;
  root: DocumentRowItem;
  children: DocumentRowItem[];
};

/** Convert workstream groups (fallback path) to the unified DisplayGroup shape. */
export function toDisplayGroups(wsGroups: WorkstreamGroup[]): DisplayGroup[] {
  const result: DisplayGroup[] = [];
  for (const g of wsGroups) {
    const [root, ...children] = g.items;
    if (root) {
      result.push({ groupKey: g.groupKey, root, children });
    }
  }
  return result;
}

function treeEntityToRowItem(
  entity: Artifact,
  documentMap: Map<string, DocumentWithWorkstream>
): DocumentRowItem | null {
  if (isDocumentArtifact(entity)) {
    const doc = documentMap.get(entity.id);
    return doc ? toRowItem(doc) : null;
  }
  if (
    entity.type === ArtifactType.PullRequest ||
    entity.type === ArtifactType.Deployment
  ) {
    return { kind: "branch", data: entity };
  }
  return null;
}

function buildNestedChildrenFromDFS(
  rootId: string,
  treeChildren: TreeChild[],
  documentMap: Map<string, DocumentWithWorkstream>,
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
  documents: DocumentWithWorkstream[]
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
