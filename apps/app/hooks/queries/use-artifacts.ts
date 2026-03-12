"use client";

import type {
  Artifact,
  ArtifactDetail,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  FindArtifactsOptions,
  GenerationStatus,
  MergeArtifactsInput,
  PullRequestInfo,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import type { ArtifactVersion } from "@repo/api/src/types/artifact-version";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import { useIsLoopsEnabled } from "@/hooks/queries/use-compute-mode";
import { useApiClient } from "@/hooks/use-api-client";
import { dashboardKeys } from "./use-dashboard-stats";
import { invalidateEntityLinkQueries } from "./use-entity-links";
import { executionLogKeys } from "./use-execution-log";
import { judgesKeys } from "./use-judges";
import { projectKeys } from "./use-projects";

/** Summary fields returned by the versions list endpoint (no content). */
type ArtifactVersionSummary = Omit<ArtifactVersion, "content">;

// Query keys
export const artifactKeys = {
  all: ["artifacts"] as const,
  lists: () => [...artifactKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...artifactKeys.lists(), filters] as const,
  details: () => [...artifactKeys.all, "detail"] as const,
  detail: (id: string) => [...artifactKeys.details(), id] as const,
  bySlugs: () => [...artifactKeys.all, "by-slug"] as const,
  bySlug: (slug: string) => [...artifactKeys.all, "by-slug", slug] as const,
  versions: (id: string) => [...artifactKeys.detail(id), "versions"] as const,
  version: (id: string, version: number) =>
    [...artifactKeys.versions(id), version] as const,
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
        if (value !== undefined) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useArtifactsByProject(
  projectId: string,
  options?: Omit<
    UseQueryOptions<ArtifactWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.list({ projectId }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("projectId", projectId);
      return apiClient.get<ArtifactWithWorkstream[]>(
        `/artifacts?${params.toString()}`
      );
    },
    ...options,
  });
}

/**
 * Fetch a single artifact by ID, including its content via currentVersion.
 * Pass an optional version number to fetch a specific version's content;
 * omit to get the latest version.
 */
export function useArtifact(
  id: string,
  version?: number,
  options?: Omit<UseQueryOptions<ArtifactDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: version
      ? artifactKeys.version(id, version)
      : artifactKeys.detail(id),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<ArtifactDetail>(`/artifacts/${id}${versionParam}`);
    },
    enabled: !!id,
    ...options,
  });
}

/**
 * Fetch a single artifact by slug, including its content via currentVersion.
 * Pass an optional version number to fetch a specific version's content;
 * omit to get the latest version.
 */
export function useArtifactBySlug(
  slug: string,
  version?: number,
  options?: Omit<UseQueryOptions<ArtifactDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: version
      ? [...artifactKeys.bySlug(slug), version]
      : artifactKeys.bySlug(slug),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<ArtifactDetail>(
        `/artifacts/by-slug/${slug}${versionParam}`
      );
    },
    enabled: !!slug,
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
    invalidateCache: () => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.versions(artifactId),
      });
      // Invalidate all bySlug queries. We only have the artifact ID, not the slug.
      queryClient.invalidateQueries({
        queryKey: artifactKeys.bySlugs(),
      });
    },
  };
}

/** List all versions for an artifact (summary only, no content). */
export function useArtifactVersions(
  artifactId: string,
  options?: Omit<
    UseQueryOptions<ArtifactVersionSummary[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.versions(artifactId),
    queryFn: () =>
      apiClient.get<ArtifactVersionSummary[]>(
        `/artifacts/${artifactId}/versions`
      ),
    enabled: !!artifactId,
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
    onSuccess: (data, input) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(input.id),
      });
      // Also invalidate the slug-based lookup so detail pages loaded by slug pick up the change
      queryClient.invalidateQueries({
        queryKey: artifactKeys.bySlug(data.slug),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      if (input.projectId) {
        queryClient.invalidateQueries({ queryKey: projectKeys.all });
      }
      invalidateEntityLinkQueries(queryClient, input.id, EntityType.Artifact);
    },
  });
}

export function useDeleteArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/artifacts/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      invalidateEntityLinkQueries(queryClient, id, EntityType.Artifact);
    },
  });
}

/** Create a new version for an artifact via the versions endpoint. */
export function useCreateArtifactVersion(artifactId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (content: string) =>
      apiClient.post<Artifact>(`/artifacts/${artifactId}/versions`, {
        content,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.versions(artifactId),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      // Invalidate slug-based lookups so useArtifactBySlug picks up the new version
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "artifacts" && query.queryKey[1] === "by-slug",
      });
    },
  });
}

export function useRegenerateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body?: { reverseSynthesisLink?: string };
    }) => apiClient.post<Artifact>(`/artifacts/${id}/regenerate`, body ?? {}),
    onSuccess: (_, { id }) => {
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
 * Used for implementation plans generated from a PRD.
 *
 * When the organization's compute mode is set to "LOOPS", triggers plan generation via
 * the run-loop endpoint (ECS Loops) instead of the regenerate endpoint (GitHub Actions).
 */
export function useCreateAndGenerateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const { isLoopsEnabled: useLoops, isLoading: isComputeModeLoading } =
    useIsLoopsEnabled();

  // Use a ref so the mutationFn always reads the latest value,
  // not the value captured at the render when the mutation was created.
  const useLoopsRef = useRef(useLoops);
  useLoopsRef.current = useLoops;

  const mutation = useMutation({
    mutationFn: async (input: CreateArtifactInput) => {
      const artifact = await apiClient.post<Artifact>("/artifacts", input);

      // Then trigger generation via Loops or GitHub Actions
      try {
        if (useLoopsRef.current) {
          await apiClient.post(`/artifacts/${artifact.id}/run-loop`, {
            command: "plan",
          });
          return artifact;
        }
        const regenerated = await apiClient.post<Artifact>(
          `/artifacts/${artifact.id}/regenerate`,
          {}
        );
        return regenerated;
      } catch {
        // Return original artifact if generation fails - user can still navigate to it
        return artifact;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.generationStatus(data.id),
      });
    },
  });

  return { ...mutation, isComputeModeLoading };
}

/**
 * Create an artifact and immediately generate PRD content inline using Sonnet.
 * Used for the "Save & Generate" button in the PRD creation modal.
 *
 * Returns `{ artifact, generationError }` — the artifact is always returned
 * (even if inline generation fails) so the caller can navigate to it.
 */
export function useCreateAndInlineGeneratePRD() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async ({
      input,
      reverseSynthesisLink,
    }: {
      input: CreateArtifactInput;
      reverseSynthesisLink?: string;
    }) => {
      const artifact = await apiClient.post<Artifact>("/artifacts", input);

      let generationError: string | null = null;
      try {
        await apiClient.post("/ai/prd/generate", {
          artifactId: artifact.id,
          reverseSynthesisLink,
        });
      } catch (err) {
        generationError =
          err instanceof Error
            ? err.message
            : "Unknown error during generation";
      }

      return { artifact, generationError };
    },
    onSuccess: ({ artifact }) => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifact.id),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.versions(artifact.id),
      });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}

/**
 * Generate PRD content inline for an existing artifact using Sonnet.
 * Used for the "Quick PRD" button on the PRD editor detail page.
 */
export function useInlineGeneratePRD() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async ({
      artifactId,
      reverseSynthesisLink,
    }: {
      artifactId: string;
      reverseSynthesisLink?: string;
    }) => {
      await apiClient.post("/ai/prd/generate", {
        artifactId,
        reverseSynthesisLink,
      });
      return { artifactId };
    },
    onSuccess: (_, { artifactId }) => {
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.versions(artifactId),
      });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
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
 * Merge two artifacts into one, keeping the primary and deleting the secondary.
 */
export function useMergeArtifacts() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      primaryArtifactId,
      secondaryArtifactId,
    }: MergeArtifactsInput) =>
      apiClient.post<Artifact>("/artifacts/merge", {
        primaryArtifactId,
        secondaryArtifactId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
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

/**
 * Fetch the preview deployment URL for an artifact's workstream.
 * Returns null if no preview deployment exists.
 */
export function usePreviewDeployment(
  artifactId: string,
  options?: Omit<UseQueryOptions<ExternalLink | null>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.previewDeployment(artifactId),
    queryFn: () =>
      apiClient.get<ExternalLink | null>(
        `/artifacts/${artifactId}/preview-deployment`
      ),
    enabled: !!artifactId,
    ...options,
  });
}
