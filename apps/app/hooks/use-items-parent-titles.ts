"use client";

import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type {
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { projectTreeKeys } from "@/hooks/queries/use-project-tree";
import { useApiClient } from "@/hooks/use-api-client";
import { getArtifactRoute } from "@/lib/document-navigation";

type ParentEntry = { title: string; href: string | null };

function getProjectId(item: DocumentRowItem): string | undefined {
  if (item.kind === "project") {
    return item.data.id;
  }
  if (item.kind === "branch") {
    return item.data.projectId;
  }
  return item.data.project?.id;
}

function isDocumentArtifact(artifact: Artifact): boolean {
  return artifact.type === ArtifactType.Document;
}

/**
 * Build depth-aware parent entries for a single tree node.
 * Uses the depth field on each child to identify the immediate parent,
 * not just the root.
 */
function addNodeParentEntries(
  node: TreeNode,
  map: Map<string, ParentEntry>
): void {
  const parentStack: ParentEntry[] = [
    { title: node.root.name, href: getArtifactRoute(node.root) },
  ];
  for (const child of node.children) {
    const depth = child.depth;
    if (depth < parentStack.length) {
      parentStack.length = depth;
    }
    const immediateParent = parentStack[depth - 1];
    if (immediateParent) {
      map.set(child.id, immediateParent);
    }
    parentStack[depth] = {
      title: child.name,
      href: getArtifactRoute(child),
    };
  }
}

/** Merge a single project tree response into the parent map. */
function mergeTreeIntoParentMap(
  treeData: ProjectTreeResponse,
  map: Map<string, ParentEntry>
): void {
  for (const node of treeData.nodes) {
    addNodeParentEntries(node, map);
  }
  for (const entry of treeData.externalParents) {
    if (map.has(entry.childId) || !isDocumentArtifact(entry.parent)) {
      continue;
    }
    map.set(entry.childId, {
      title: entry.parent.name,
      href: getArtifactRoute(entry.parent),
    });
  }
}

/**
 * Fetches project trees for all projects represented in `items`, then returns
 * a map from child entity ID to its immediate parent entity title.
 *
 * Uses depth-aware mapping so depth-2+ items get their immediate parent,
 * not the root. Cross-project parents fill in for items whose parent lives
 * outside this project.
 *
 * Used by team-level flat tables (Features, Plans, My Tasks) to populate the
 * Parent column when items span multiple projects.
 */
export function useItemsParentTitles(
  items: DocumentRowItem[]
): Map<string, ParentEntry> {
  const apiClient = useApiClient();

  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      const pid = getProjectId(item);
      if (pid) {
        ids.add(pid);
      }
    }
    return Array.from(ids);
  }, [items]);

  const treeQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: projectTreeKeys.detail(projectId),
      queryFn: () =>
        apiClient.get<ProjectTreeResponse>(`/projects/${projectId}/tree`),
    })),
  });

  const parentTitles = new Map<string, ParentEntry>();
  for (const query of treeQueries) {
    if (query.data) {
      mergeTreeIntoParentMap(query.data, parentTitles);
    }
  }
  return parentTitles;
}
