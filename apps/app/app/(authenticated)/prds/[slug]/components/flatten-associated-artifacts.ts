import type { Document } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType } from "@repo/api/src/types/entity-link";

export type FlattenedArtifactRow = {
  document: Document;
  linkId: string;
  depth: number;
};

type ChildEntry = { document: Document; linkId: string };

/**
 * Flat LinkedEntity list (from a Tree query starting at `rootId`) → depth-
 * tagged, DFS-ordered rows for rendering. Walks parent→child edges via
 * sourceId/targetId, skipping self-links, cycles, and duplicate edges.
 * Depth is 1-based so direct children of the root render flush-left.
 */
export function flattenAssociatedArtifacts(
  rootId: string,
  linkedEntities: LinkedEntity[]
): FlattenedArtifactRow[] {
  const childrenByParent = indexChildrenByParent(linkedEntities);
  const rows: FlattenedArtifactRow[] = [];
  walk(rootId, 1, new Set([rootId]), childrenByParent, rows);
  return rows;
}

function indexChildrenByParent(
  linkedEntities: LinkedEntity[]
): Map<string, ChildEntry[]> {
  const map = new Map<string, ChildEntry[]>();
  for (const link of linkedEntities) {
    if (
      link.resolvedEntity?.type !== EntityType.Document ||
      link.targetType !== EntityType.Document
    ) {
      continue;
    }
    const document = link.resolvedEntity.entity;
    const existing = map.get(link.sourceId) ?? [];
    if (!existing.some((entry) => entry.document.id === document.id)) {
      existing.push({ document, linkId: link.id });
    }
    map.set(link.sourceId, existing);
  }
  return map;
}

function walk(
  parentId: string,
  depth: number,
  visited: Set<string>,
  childrenByParent: Map<string, ChildEntry[]>,
  rows: FlattenedArtifactRow[]
): void {
  const directChildren = childrenByParent.get(parentId) ?? [];
  for (const entry of directChildren) {
    if (visited.has(entry.document.id)) {
      continue;
    }
    rows.push({ document: entry.document, linkId: entry.linkId, depth });
    const nextVisited = new Set(visited);
    nextVisited.add(entry.document.id);
    walk(entry.document.id, depth + 1, nextVisited, childrenByParent, rows);
  }
}
