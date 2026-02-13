"use client";

import type {
  Artifact,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  FindArtifactsOptions,
  GenerationStatus,
  PreviewDeployment,
  PullRequestInfo,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { ApiError } from "@/lib/api-error";
import { dashboardKeys } from "./use-dashboard-stats";
import { executionLogKeys } from "./use-execution-log";
import { judgesKeys } from "./use-judges";
import { projectKeys } from "./use-projects";

// Query keys
export const artifactKeys = {
  all: ["artifacts"] as const,
  lists: () => [...artifactKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...artifactKeys.lists(), filters] as const,
  details: () => [...artifactKeys.all, "detail"] as const,
  detail: (id: string) => [...artifactKeys.details(), id] as const,
  versions: (id: string) => [...artifactKeys.detail(id), "versions"] as const,
  generationStatus: (id: string) =>
    [...artifactKeys.detail(id), "generation-status"] as const,
  previewDeployment: (id: string) =>
    [...artifactKeys.detail(id), "preview-deployment"] as const,
  related: (id: string) => [...artifactKeys.detail(id), "related"] as const,
};

// Queries
export function useArtifacts(
  searchParams: FindArtifactsOptions,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.list(searchParams),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        params.set(key, value.toString());
      }
      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useArtifactsBySubtype(
  subtype: string,
  latestOnly = true,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.list({ subtype, latestOnly }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("subtype", subtype);
      params.set("latestOnly", String(latestOnly));
      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useArtifactsByProject(
  projectId: string,
  latestOnly = true,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.list({ projectId, latestOnly }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("projectId", projectId);
      params.set("latestOnly", String(latestOnly));
      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useArtifact(
  id: string,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.detail(id),
    queryFn: () => apiClient.get<ArtifactWithWorkstream>(`/artifacts/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useArtifactGenerationStatus(
  artifactId: string,
  options?: Omit<UseQueryOptions<GenerationStatus>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return {
    ...useQuery({
      queryKey: artifactKeys.generationStatus(artifactId),
      queryFn: () =>
        apiClient.get<GenerationStatus>(
          `/artifacts/${artifactId}/generation-status`
        ),
      enabled: !!artifactId,
      ...options,
    }),
    // Once the artifact is generated, we need to invalidate the cache so that the new
    // artifact is fetched.
    invalidateCache: () => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifactId),
      });
    },
  };
}

export function useArtifactVersions(
  id: string,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.versions(id),
    queryFn: async () => {
      // First fetch the artifact to get its documentSlug
      const artifact = await apiClient.get<ArtifactWithWorkstream>(
        `/artifacts/${id}`
      );

      if (
        artifact.documentSlug === null ||
        artifact.documentSlug === undefined
      ) {
        throw new ApiError("Artifact does not have a documentSlug", 400);
      }

      const params = new URLSearchParams();
      if (artifact.subtype) {
        params.set("subtype", artifact.subtype);
      }
      params.set("documentSlug", artifact.documentSlug);
      params.set("latestOnly", "false");

      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    enabled: !!id,
    ...options,
  });
}

// Mutations
export function useCreateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateArtifactInput) =>
      apiClient.post<Artifact>("/artifacts", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}

export function useUpdateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateArtifactInput) => {
      const { id, ...body } = input;
      return apiClient.put<Artifact>(`/artifacts/${id}`, body);
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(input.id),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      if (input.projectId) {
        queryClient.invalidateQueries({ queryKey: projectKeys.all });
      }
    },
  });
}

export function useDeleteArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/artifacts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}

export function useCreateNewVersion() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      apiClient.post<Artifact>(`/artifacts/${id}/new-version`, { content }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.versions(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}

export function useRegenerateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<Artifact>(`/artifacts/${id}/regenerate`, {}),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.detail(id) });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.generationStatus(id),
      });
      queryClient.invalidateQueries({
        queryKey: executionLogKeys.detail(id),
      });
      queryClient.invalidateQueries({
        queryKey: judgesKeys.detail(id),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}

export function useRequestPlanChanges() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      artifactId,
      changes,
    }: {
      artifactId: string;
      changes: string;
    }) =>
      apiClient.post<{ success: true; message: string; artifactId: string }>(
        `/artifacts/${artifactId}/request-changes`,
        { changes }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(variables.artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.generationStatus(variables.artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: executionLogKeys.detail(variables.artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: judgesKeys.detail(variables.artifactId),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}

/**
 * Create an artifact and immediately trigger generation workflow.
 * Used for implementation plans generated from a PRD or Issue.
 */
export function useCreateAndGenerateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async (input: CreateArtifactInput) => {
      // First create the artifact
      const artifact = await apiClient.post<Artifact>("/artifacts", input);

      // Then trigger regeneration (which dispatches to GitHub)
      try {
        const regenerated = await apiClient.post<Artifact>(
          `/artifacts/${artifact.id}/regenerate`,
          {}
        );
        return regenerated;
      } catch {
        // Return original artifact if regeneration fails - user can still navigate to it
        return artifact;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      if (data.parentId) {
        queryClient.invalidateQueries({
          queryKey: artifactKeys.detail(data.parentId),
        });
      }
      queryClient.invalidateQueries({
        queryKey: artifactKeys.generationStatus(data.id),
      });
    },
  });
}

type ExecuteResult = {
  success: true;
  correlationId: string;
};

/**
 * Execute an approved implementation plan.
 * Triggers the symphony-dispatch workflow with command="execute" to generate code and create a PR.
 */
export function useExecuteImplementationPlan() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (artifactId: string) =>
      apiClient.post<ExecuteResult>(`/artifacts/${artifactId}/execute`, {}),
    onSuccess: (_, artifactId) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.generationStatus(artifactId),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}

/**
 * Fetch the pull request associated with an artifact's workstream.
 */
export function useArtifactPullRequest(
  artifactId: string,
  options?: Omit<
    UseQueryOptions<PullRequestInfo | null>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: [...artifactKeys.detail(artifactId), "pull-request"] as const,
    queryFn: () =>
      apiClient.get<PullRequestInfo | null>(
        `/artifacts/${artifactId}/pull-request`
      ),
    enabled: !!artifactId,
    ...options,
  });
}

/**
 * Fetch the preview deployment for an artifact.
 */
export function useArtifactPreviewDeployment(
  artifactId: string,
  options?: Omit<
    UseQueryOptions<PreviewDeployment | null>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.previewDeployment(artifactId),
    queryFn: () =>
      apiClient.get<PreviewDeployment | null>(
        `/artifacts/${artifactId}/preview-deployment`
      ),
    enabled: !!artifactId,
    ...options,
  });
}

/**
 * Refresh preview deployment status by fetching latest from GitHub.
 */
export function useRefreshPreviewDeployment(
  artifactId: string,
  options?: { showToast?: boolean }
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const _showToast = options?.showToast ?? true;

  return useMutation({
    mutationFn: () =>
      apiClient.post<PreviewDeployment | null>(
        `/artifacts/${artifactId}/preview-deployment`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.previewDeployment(artifactId),
      });
    },
  });
}

/**
 * Reorder artifacts by setting sortOrder values.
 * Accepts an array of artifact IDs in the desired order.
 */
export function useReorderArtifacts() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (artifactIds: string[]) =>
      apiClient.post<string[]>("/artifacts/reorder", { artifactIds }),
    onMutate: async (artifactIds) => {
      // Cancel outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: artifactKeys.lists() });

      // Snapshot previous values for rollback
      const previousLists = queryClient.getQueriesData({
        queryKey: artifactKeys.lists(),
      });

      // Optimistically update all artifact list queries
      queryClient.setQueriesData(
        { queryKey: artifactKeys.lists() },
        (old: ArtifactWithWorkstream[] | undefined) => {
          if (!old) {
            return old;
          }

          // Create a map of new positions
          const positionMap = new Map(
            artifactIds.map((id, index) => [id, index])
          );

          // Sort artifacts by new order
          return [...old].sort((a, b) => {
            const posA = positionMap.get(a.id);
            const posB = positionMap.get(b.id);

            // Keep artifacts not in reorder list at the end
            if (posA === undefined && posB === undefined) {
              return 0;
            }
            if (posA === undefined) {
              return 1;
            }
            if (posB === undefined) {
              return -1;
            }

            return posA - posB;
          });
        }
      );

      return { previousLists };
    },
    onError: (_err, _variables, context) => {
      // Rollback on error
      if (context?.previousLists) {
        for (const [queryKey, data] of context.previousLists) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSuccess: () => {
      // Invalidate to fetch fresh data from server
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}

/**
 * Move multiple artifacts to a different project.
 * Used for drag-and-drop cross-project move.
 */
export function useBatchMoveArtifacts() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      artifactIds,
      targetProjectId,
    }: {
      artifactIds: string[];
      targetProjectId: string;
    }) =>
      apiClient.post<string[]>("/artifacts/batch-move", {
        artifactIds,
        targetProjectId,
      }),
    onSuccess: (_, { targetProjectId }) => {
      // Invalidate all artifact lists to refresh source and target project views
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      // Invalidate project lists to update artifact counts
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      // Invalidate target project detail to reflect new artifacts
      queryClient.invalidateQueries({
        queryKey: projectKeys.detail(targetProjectId),
      });
    },
  });
}

/**
 * Fetch related artifacts (parent/child chain) for an artifact.
 * Used to show "move all related artifacts?" confirmation dialog.
 */
export function useRelatedArtifacts(
  artifactId: string,
  options?: { enabled?: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.related(artifactId),
    queryFn: () => apiClient.get<string[]>(`/artifacts/${artifactId}/related`),
    enabled: options?.enabled ?? !!artifactId,
  });
}
