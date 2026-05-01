"use client";

import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { projectTreeKeys } from "@/hooks/queries/use-project-tree";
import { useApiClient } from "@/hooks/use-api-client";
import { getArtifactRoute } from "@/lib/document-navigation";

function getProjectId(item: DocumentRowItem): string | undefined {
  if (item.kind === "project") {
    return item.data.id;
  }
  return item.data.project?.id;
}

/**
 * Fetches project trees for all projects represented in `items`, then returns
 * a map from child entity ID to its parent entity title.
 *
 * In-project tree parents take precedence; cross-project parents (returned in
 * `treeData.externalParents`) fill in for items whose parent lives elsewhere.
 *
 * Used by team-level flat tables (Features, Plans, My Tasks) to populate the
 * Parent column when items span multiple projects.
 */
export function useItemsParentTitles(
  items: DocumentRowItem[]
): Map<string, { title: string; href: string | null }> {
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

  const parentTitles = new Map<
    string,
    { title: string; href: string | null }
  >();
  for (const query of treeQueries) {
    if (!query.data) {
      continue;
    }
    for (const node of query.data.nodes) {
      const parentHref = getArtifactRoute(node.root);
      for (const child of node.children) {
        parentTitles.set(child.id, {
          title: node.root.name,
          href: parentHref,
        });
      }
    }
    for (const entry of query.data.externalParents) {
      if (parentTitles.has(entry.childId)) {
        continue;
      }
      if (!isDocumentArtifact(entry.parent)) {
        continue;
      }
      parentTitles.set(entry.childId, {
        title: entry.parent.name,
        href: getArtifactRoute(entry.parent),
      });
    }
  }
  return parentTitles;
}

function isDocumentArtifact(artifact: Artifact): boolean {
  return artifact.type === ArtifactType.Document;
}
