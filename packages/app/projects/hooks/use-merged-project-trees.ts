"use client";

import type {
  ExternalParentLink,
  ProjectTreeQueryFilters,
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import { useQueries } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { projectTreeKeys, projectTreePath } from "./use-project-tree";

type MergedProjectTreesOptions = {
  enabled?: boolean;
  filters?: ProjectTreeQueryFilters;
};

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
 *   actually visible (per `apps/app/AGENTS.md` on-mount fetch convention).
 */
export function useMergedProjectTrees(
  projectIds: string[],
  options?: MergedProjectTreesOptions
): {
  data: ProjectTreeResponse | null;
  isLoading: boolean;
  /**
   * True when ANY of the per-project tree reads failed. Surfaced so consumers
   * (e.g. the My Tasks board, ISS-4466) can reflect a degraded tree stream in
   * their error/empty state instead of silently omitting the failed project's
   * branch/session rows from an "honest" total.
   */
  isError: boolean;
  /**
   * Re-run every per-project read this hook is driving. Exposed so a consumer's
   * "Try again" can retry the tree stream it actually failed on.
   */
  refetch: () => void;
} {
  const apiClient = useApiClient();
  const enabled = options?.enabled !== false;
  const filters = options?.filters;

  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: projectTreeKeys.detail(projectId, filters),
      queryFn: () =>
        apiClient.get<ProjectTreeResponse>(projectTreePath(projectId, filters)),
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
      isError: enabled && results.some((r) => r.isError),
      refetch: () => {
        for (const result of results) {
          result.refetch().catch(() => {
            // The retried query records its own error state; this catch only
            // stops the refetch rejection surfacing as an unhandled rejection.
          });
        }
      },
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
