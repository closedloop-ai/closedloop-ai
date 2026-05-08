"use client";

import type {
  ExternalParentLink,
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import { useQueries } from "@tanstack/react-query";
import { projectTreeKeys } from "@/hooks/queries/use-project-tree";
import { useApiClient } from "@/hooks/use-api-client";

/**
 * Fetch project trees for each given project ID and merge them into a single
 * `ProjectTreeResponse`-shaped object so consumers (e.g. cross-project tables)
 * can reuse logic that expects a single tree response.
 *
 * Tree node IDs are entity IDs and are unique across projects, so the merge is
 * a straightforward concatenation. `externalParents` from any project are
 * preserved.
 *
 * @param projectIds - Project IDs to fetch trees for.
 * @param options.enabled - When false, no fetches are issued and `data` is null.
 *   Defaults to true. Use this to defer fetching until the consumer panel is
 *   actually visible (per `apps/app/CLAUDE.md` on-mount fetch convention).
 */
export function useMergedProjectTrees(
  projectIds: string[],
  options?: { enabled?: boolean }
): {
  data: ProjectTreeResponse | null;
  isLoading: boolean;
} {
  const apiClient = useApiClient();
  const enabled = options?.enabled !== false;

  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: projectTreeKeys.detail(projectId),
      queryFn: () =>
        apiClient.get<ProjectTreeResponse>(`/projects/${projectId}/tree`),
      enabled,
    })),
    combine: (results) => ({
      data: enabled
        ? mergeProjectTrees(
            projectIds.length,
            results.map((r) => r.data)
          )
        : null,
      isLoading: enabled && results.some((r) => r.isLoading),
    }),
  });
}

function mergeProjectTrees(
  projectIdCount: number,
  treeResults: (ProjectTreeResponse | undefined)[]
): ProjectTreeResponse | null {
  if (projectIdCount === 0) {
    return { nodes: [], externalParents: [] };
  }
  const nodes: TreeNode[] = [];
  const externalParents: ExternalParentLink[] = [];
  let anyLoaded = false;
  for (const tree of treeResults) {
    if (!tree) {
      continue;
    }
    anyLoaded = true;
    nodes.push(...tree.nodes);
    externalParents.push(...tree.externalParents);
  }
  return anyLoaded ? { nodes, externalParents } : null;
}
