import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
} from "@repo/api/src/types/artifact";

export type FlattenedArtifactRow = {
  endpoint: ArtifactLinkWithEndpoints["target"];
  linkId: string;
  depth: number;
};

type ChildEntry = {
  endpoint: ArtifactLinkWithEndpoints["target"];
  linkId: string;
};

/**
 * Flat ArtifactLinkWithEndpoints list (from a Tree query starting at `rootId`)
 * → depth-tagged, DFS-ordered rows for rendering. Walks parent→child edges
 * via sourceId/targetId, skipping self-links, cycles, and duplicate edges.
 * Depth is 1-based so direct children of the root render flush-left. Only
 * Document-typed targets are included; PR/deployment endpoints are skipped
 * because the Associated Artifacts section renders documents.
 */
export function flattenAssociatedArtifacts(
  rootId: string,
  resolvedLinks: ArtifactLinkWithEndpoints[]
): FlattenedArtifactRow[] {
  const childrenByParent = indexChildrenByParent(resolvedLinks);
  const rows: FlattenedArtifactRow[] = [];
  walk(rootId, 1, new Set([rootId]), childrenByParent, rows);
  return rows;
}

function indexChildrenByParent(
  resolvedLinks: ArtifactLinkWithEndpoints[]
): Map<string, ChildEntry[]> {
  const map = new Map<string, ChildEntry[]>();
  for (const link of resolvedLinks) {
    if (link.target.type !== ArtifactType.Document) {
      continue;
    }
    const endpoint = link.target;
    const existing = map.get(link.sourceId) ?? [];
    if (!existing.some((entry) => entry.endpoint.id === endpoint.id)) {
      existing.push({ endpoint, linkId: link.id });
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
    if (visited.has(entry.endpoint.id)) {
      continue;
    }
    rows.push({ endpoint: entry.endpoint, linkId: entry.linkId, depth });
    const nextVisited = new Set(visited);
    nextVisited.add(entry.endpoint.id);
    walk(entry.endpoint.id, depth + 1, nextVisited, childrenByParent, rows);
  }
}
