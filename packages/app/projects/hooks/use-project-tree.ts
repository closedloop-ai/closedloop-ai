"use client";

import {
  type MoveArtifactRequest,
  type MoveArtifactResponse,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import {
  PROJECT_TREE_INCLUDE_PARAM,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import {
  type QueryKey,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

export const projectTreeKeys = {
  all: ["project-tree"] as const,
  detail: (projectId: string) => [...projectTreeKeys.all, projectId] as const,
  /**
   * Detailed-tree variant (`?include=details`, PLN-874). Nested under
   * `detail` so every existing detail-prefix invalidation (and the
   * optimistic stack-rank update) covers it automatically.
   */
  withDetails: (projectId: string) =>
    [...projectTreeKeys.detail(projectId), "with-details"] as const,
};

export function useProjectTree(
  projectId: string,
  options?: Omit<UseQueryOptions<ProjectTreeResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectTreeKeys.detail(projectId),
    queryFn: () =>
      apiClient.get<ProjectTreeResponse>(`/projects/${projectId}/tree`),
    enabled: !!projectId,
    ...options,
  });
}

/**
 * Mutation hook backing the project page's stack-rank reorder UI (PRD-421).
 * Calls `POST /projects/:id/artifacts/move`, the single-item primitive used
 * by drag-drop, keyboard reorder, and the row-menu Move-to-top / Move-to-
 * bottom actions.
 *
 * Optimistic update: applies the new root ordering to the cached
 * `ProjectTreeResponse.nodes` array immediately, rolls back if the server
 * rejects the move, and re-fetches `projectTreeKeys.detail(projectId)` on
 * settle so the canonical sortOrder values from the server win. The update
 * targets every cache entry under the project's detail-key prefix, so both
 * the plain tree and the with-details variant reorder together.
 *
 * Children are untouched — stack rank is a root-only concept per PRD-421.
 */
export function useMoveArtifact(projectId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<
    MoveArtifactResponse,
    Error,
    MoveArtifactRequest,
    { previous: [QueryKey, ProjectTreeResponse | undefined][] }
  >({
    mutationFn: (body) =>
      apiClient.post<MoveArtifactResponse>(
        `/projects/${projectId}/artifacts/move`,
        body
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({
        queryKey: projectTreeKeys.detail(projectId),
      });
      const previous = queryClient.getQueriesData<ProjectTreeResponse>({
        queryKey: projectTreeKeys.detail(projectId),
      });
      queryClient.setQueriesData<ProjectTreeResponse>(
        { queryKey: projectTreeKeys.detail(projectId) },
        (old) =>
          old ? { ...old, nodes: applyMoveToTree(old.nodes, input) } : old
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      for (const [queryKey, data] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: projectTreeKeys.detail(projectId),
      });
    },
  });
}

/**
 * Pure helper for the optimistic cache update: returns a new nodes array with
 * the moved artifact spliced into the requested slot. Exported for unit tests
 * so the cache logic can be verified without spinning up a QueryClient.
 */
export function applyMoveToTree(
  nodes: ProjectTreeResponse["nodes"],
  input: MoveArtifactRequest
): ProjectTreeResponse["nodes"] {
  const targetIndex = nodes.findIndex((n) => n.root.id === input.artifactId);
  if (targetIndex < 0) {
    return nodes;
  }
  const target = nodes[targetIndex];
  if (!target) {
    return nodes;
  }
  const withoutTarget = nodes.filter((_, i) => i !== targetIndex);

  if (input.position === MovePosition.Top) {
    return [target, ...withoutTarget];
  }
  if (input.position === MovePosition.Bottom) {
    return [...withoutTarget, target];
  }
  if (!input.referenceArtifactId) {
    return nodes;
  }
  const refIndex = withoutTarget.findIndex(
    (n) => n.root.id === input.referenceArtifactId
  );
  if (refIndex < 0) {
    return nodes;
  }
  const insertIndex =
    input.position === MovePosition.Before ? refIndex : refIndex + 1;
  return [
    ...withoutTarget.slice(0, insertIndex),
    target,
    ...withoutTarget.slice(insertIndex),
  ];
}

/**
 * Project tree with artifact-level view details (tags, generation status)
 * enriched onto every node (PLN-874). The project page's documents table
 * renders from this one query instead of pairing `useProjectTree` with a
 * separate `/documents?projectId=` fetch.
 */
export function useProjectTreeWithDetails(
  projectId: string,
  options?: Omit<
    UseQueryOptions<ProjectTreeDetailsResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectTreeKeys.withDetails(projectId),
    queryFn: () =>
      apiClient.get<ProjectTreeDetailsResponse>(
        `/projects/${projectId}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}`
      ),
    enabled: !!projectId,
    ...options,
  });
}
