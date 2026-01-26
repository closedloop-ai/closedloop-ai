"use client";

import type {
  Artifact,
  ArtifactWithWorkstream,
  CreateArtifactInput,
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
};

type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
};

// Queries
export function useArtifacts(
  workstreamId: string,
  type?: string,
  latestOnly = true,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.list({ workstreamId, type, latestOnly }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("workstreamId", workstreamId);
      if (type) {
        params.set("type", type);
      }
      params.set("latestOnly", String(latestOnly));
      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useArtifactsByType(
  type: string,
  latestOnly = true,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.list({ type, latestOnly }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("type", type);
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

  return useQuery({
    queryKey: artifactKeys.generationStatus(artifactId),
    queryFn: () =>
      apiClient.get<GenerationStatus>(
        `/artifacts/${artifactId}/generation-status`
      ),
    enabled: !!artifactId,
    ...options,
  });
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
      params.set("type", artifact.type);
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
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(id),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
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
    },
  });
}

export function useDuplicateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<Artifact>(`/artifacts/${id}/duplicate`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
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
    },
  });
}

export function onRegenerateArtifactSuccess(id: string) {
  const queryClient = useQueryClient();
  queryClient.invalidateQueries({ queryKey: artifactKeys.detail(id) });
  queryClient.invalidateQueries({
    queryKey: artifactKeys.generationStatus(id),
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
    },
  });
}

export function onRequestPlanChangesSuccess(artifactId: string) {
  const queryClient = useQueryClient();
  queryClient.invalidateQueries({ queryKey: artifactKeys.detail(artifactId) });
  queryClient.invalidateQueries({
    queryKey: artifactKeys.generationStatus(artifactId),
  });
}

/**
 * Create an artifact and immediately trigger generation workflow.
 * Used for implementation plans that need to be generated from a PRD.
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}
