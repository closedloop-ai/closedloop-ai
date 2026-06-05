"use client";

import { getRoutePrefixForType } from "@repo/api/src/types/artifact";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ArtifactRowItem } from "@/components/artifact-table/artifact-row";
import { projectTreeKeys } from "@/hooks/queries/use-project-tree";
import { useApiClient } from "@/hooks/use-api-client";

function getProjectId(item: ArtifactRowItem): string | undefined {
  if (item.kind === "project") {
    return item.data.id;
  }
  return item.data.project?.id;
}

/**
 * Fetches project trees for all projects represented in `items`, then returns
 * a map from child entity ID to its parent entity title.
 *
 * Used by team-level flat tables (Features, Plans, My Tasks) to populate the
 * Parent column when items span multiple projects.
 */
export function useItemsParentTitles(
  items: ArtifactRowItem[]
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
      let parentHref: string | null = null;
      if (node.root.entityType === EntityType.Artifact) {
        const routePrefix = getRoutePrefixForType(node.root.type);
        if (routePrefix) {
          parentHref = `/${routePrefix}/${node.root.slug}`;
        }
      }
      for (const child of node.children) {
        parentTitles.set(child.id, {
          title: node.root.title,
          href: parentHref,
        });
      }
    }
  }
  return parentTitles;
}
