"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import {
  type CreateDocumentInput,
  type Document,
  type DocumentDetail,
  type DocumentWithWorkstream,
  type FindDocumentsOptions,
  type GenerationStatus,
  isActiveGenerationStatus,
  type MergeDocumentsInput,
  type PullRequestInfo,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import type { DocumentVersion } from "@repo/api/src/types/document-version";
import {
  type AdditionalRepoRef,
  type LoopCommand,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type UseQueryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { getErrorMessage } from "@/lib/api-error";
import { postRunLoop } from "@/lib/run-loop-launcher";
import { handleRunLoopResponse } from "@/lib/run-loop-response";
import { invalidateArtifactLinkQueries } from "./use-artifact-links";
import { dashboardKeys } from "./use-dashboard-stats";
import { projectTreeKeys } from "./use-project-tree";
import { projectKeys, useProjectsByTeam } from "./use-projects";

/** Summary fields returned by the versions list endpoint (no content). */
type DocumentVersionSummary = Omit<DocumentVersion, "content">;

export type CreateAndGenerateDocumentResult = {
  artifact: Document;
  status: "launched" | "pending_target_selection";
};

export type GeneratePrdLaunchResult =
  | {
      artifact: Document;
      status: "launched";
    }
  | {
      additionalRepos?: AdditionalRepoRef[];
      artifact: Document;
      availableTargets: ComputeTargetConflictBody["availableTargets"];
      status: "pending_target_selection";
    };

// Query keys
export const documentKeys = {
  all: ["documents"] as const,
  lists: () => [...documentKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...documentKeys.lists(), filters] as const,
  details: () => [...documentKeys.all, "detail"] as const,
  detail: (id: string) => [...documentKeys.details(), id] as const,
  bySlugs: () => [...documentKeys.all, "by-slug"] as const,
  bySlug: (slug: string) => [...documentKeys.all, "by-slug", slug] as const,
  versions: (id: string) => [...documentKeys.detail(id), "versions"] as const,
  version: (id: string, version: number) =>
    [...documentKeys.versions(id), version] as const,
  generationStatus: (id: string) =>
    [...documentKeys.detail(id), "generation-status"] as const,
  previewDeployment: (id: string) =>
    [...documentKeys.detail(id), "preview-deployment"] as const,
  related: (id: string) => [...documentKeys.detail(id), "related"] as const,
  inheritedAdditionalRepos: (id: string, command: LoopCommand) =>
    [
      ...documentKeys.detail(id),
      "inherited-additional-repos",
      command,
    ] as const,
};

// Queries
export function useDocuments(
  searchParams: FindDocumentsOptions,
  options?: Omit<
    UseQueryOptions<DocumentWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentKeys.list(searchParams),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<DocumentWithWorkstream[]>(
        `/documents?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useDocumentsByProject(
  projectId: string,
  options?: Omit<
    UseQueryOptions<DocumentWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentKeys.list({ projectId }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("projectId", projectId);
      return apiClient.get<DocumentWithWorkstream[]>(
        `/documents?${params.toString()}`
      );
    },
    ...options,
  });
}

/**
 * Fetch all artifacts of a given type across every project in a team.
 * Fans out one query per project using useQueries and flattens the results.
 */
export function useDocumentsByTeam(
  teamId: string,
  type?: string,
  options?: { enabled?: boolean }
) {
  const apiClient = useApiClient();
  const enabled = (options?.enabled ?? true) && !!teamId;
  const { data: projects = [], isLoading: loadingProjects } = useProjectsByTeam(
    teamId,
    { enabled }
  );

  const documentQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: documentKeys.list({
        projectId: project.id,
        ...(type ? { type } : {}),
      }),
      queryFn: () => {
        const params = new URLSearchParams({ projectId: project.id });
        if (type) {
          params.set("type", type);
        }
        return apiClient.get<DocumentWithWorkstream[]>(
          `/documents?${params.toString()}`
        );
      },
      enabled,
    })),
  });

  return {
    data: documentQueries.flatMap((q) => q.data ?? []),
    isLoading: loadingProjects || documentQueries.some((q) => q.isLoading),
  };
}

/**
 * Fetch a single artifact by ID, including its content via currentVersion.
 * Pass an optional version number to fetch a specific version's content;
 * omit to get the latest version.
 */
export function useDocument(
  id: string | null,
  version?: number,
  options?: Omit<UseQueryOptions<DocumentDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: version
      ? documentKeys.version(id!, version)
      : documentKeys.detail(id!),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<DocumentDetail>(`/documents/${id}${versionParam}`);
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
export function useDocumentBySlug(
  slug: string,
  version?: number,
  options?: Omit<UseQueryOptions<DocumentDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: version
      ? [...documentKeys.bySlug(slug), version]
      : documentKeys.bySlug(slug),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<DocumentDetail>(
        `/documents/by-slug/${slug}${versionParam}`
      );
    },
    enabled: !!slug,
    ...options,
  });
}

const GENERATION_POLL_INTERVAL = 5000;

export function useDocumentGenerationStatus(
  documentId: string,
  options?: Omit<UseQueryOptions<GenerationStatus>, "queryKey" | "queryFn"> & {
    polling?: boolean;
  }
) {
  const { polling, ...queryOptions } = options ?? {};
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return {
    ...useQuery<GenerationStatus>({
      queryKey: documentKeys.generationStatus(documentId),
      queryFn: () =>
        apiClient.get<GenerationStatus>(
          `/documents/${documentId}/generation-status`
        ),
      enabled: !!documentId,
      refetchInterval: polling
        ? (query) => {
            const status = query.state.data?.status;
            if (
              status &&
              (isActiveGenerationStatus(status) || status === "FAILURE")
            ) {
              return GENERATION_POLL_INTERVAL;
            }
            return false;
          }
        : undefined,
      ...queryOptions,
    }),
    invalidateCache: () => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(documentId),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.versions(documentId),
      });
      // Invalidate all bySlug queries. We only have the artifact ID, not the slug.
      queryClient.invalidateQueries({
        queryKey: documentKeys.bySlugs(),
      });
    },
  };
}

/** List all versions for an artifact (summary only, no content). */
export function useDocumentVersions(
  documentId: string,
  options?: Omit<
    UseQueryOptions<DocumentVersionSummary[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentKeys.versions(documentId),
    queryFn: () =>
      apiClient.get<DocumentVersionSummary[]>(
        `/documents/${documentId}/versions`
      ),
    enabled: !!documentId,
    ...options,
  });
}

// Mutations
export function useCreateDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateDocumentInput) =>
      apiClient.post<Document>("/documents", input),
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      queryClient.invalidateQueries({
        queryKey: projectTreeKeys.detail(input.projectId),
      });
    },
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateDocumentInput) => {
      const { id, ...body } = input;
      return apiClient.put<Document>(`/documents/${id}`, body);
    },
    onSuccess: (data, input) => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(input.id),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.bySlug(data.slug),
      });
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      if (input.projectId) {
        queryClient.invalidateQueries({ queryKey: projectKeys.all });
      }
      invalidateArtifactLinkQueries(queryClient, input.id);
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/documents/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      invalidateArtifactLinkQueries(queryClient, id);
    },
  });
}

/** Create a new version for an artifact via the versions endpoint. */
export function useCreateDocumentVersion(documentId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      content,
      resetRoom,
    }: {
      content: string;
      resetRoom?: boolean;
    }) => {
      const params = new URLSearchParams();
      if (resetRoom !== undefined) {
        params.set("reset-room", resetRoom.toString());
      }
      return apiClient.post<DocumentDetail>(
        `/documents/${documentId}/versions?${params.toString()}`,
        {
          content,
        }
      );
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(documentId),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.bySlug(result.slug),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.versions(documentId),
      });
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
    },
  });
}

/**
 * Create an artifact and immediately trigger generation workflow via Loops.
 * Used for implementation plans generated from a PRD.
 *
 * Always triggers plan generation via the run-loop endpoint (ECS Loops).
 * Compute target resolution is handled server-side.
 */
export function useCreateAndGenerateDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
    pendingArtifact: Document;
    pendingDocumentId: string;
    additionalRepos?: AdditionalRepoRef[];
  } | null>(null);

  const mutation = useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: async ({
      input,
      additionalRepos,
      computeTargetId,
    }: {
      input: CreateDocumentInput;
      additionalRepos?: AdditionalRepoRef[];
      computeTargetId?: string | null;
    }): Promise<CreateAndGenerateDocumentResult> => {
      let artifact: Document;
      try {
        artifact = await apiClient.post<Document>("/documents", input);
      } catch (error) {
        toast.error(getErrorMessage(error));
        throw error;
      }

      // Trigger generation via Loops — compute target resolved server-side
      try {
        await postRunLoop(apiClient, {
          documentId: artifact.id,
          command: RunLoopCommand.Plan,
          ...(computeTargetId === undefined ? {} : { computeTargetId }),
          ...(additionalRepos?.length ? { additionalRepos } : {}),
        });
        return { artifact, status: "launched" };
      } catch (error) {
        let isPendingTargetSelection = false;
        handleRunLoopResponse(error, {
          onMultipleTargets: (conflict) => {
            isPendingTargetSelection = true;
            setMultiTargetState({
              availableTargets: conflict.availableTargets,
              pendingArtifact: artifact,
              pendingDocumentId: artifact.id,
              additionalRepos,
            });
          },
          onBackendMismatch: () => {
            // Backend mismatch modal handled in T-3.4
          },
          onSuccess: () => {
            // unreachable: catch only receives thrown errors
          },
        });
        if (isPendingTargetSelection) {
          return { artifact, status: "pending_target_selection" };
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: documentKeys.bySlugs() });
      queryClient.invalidateQueries({
        queryKey: documentKeys.generationStatus(data.artifact.id),
      });
      if (data.artifact.projectId) {
        queryClient.invalidateQueries({
          queryKey: projectTreeKeys.detail(data.artifact.projectId),
        });
      }
    },
  });

  const selectTarget = useCallback(
    async (targetId: string) => {
      if (!multiTargetState) {
        return;
      }
      const { pendingArtifact, pendingDocumentId, additionalRepos } =
        multiTargetState;
      setMultiTargetState(null);
      try {
        await postRunLoop(apiClient, {
          documentId: pendingDocumentId,
          command: RunLoopCommand.Plan,
          computeTargetId: targetId,
          ...(additionalRepos?.length ? { additionalRepos } : {}),
        });
        queryClient.invalidateQueries({
          queryKey: documentKeys.generationStatus(pendingDocumentId),
        });
        return { artifact: pendingArtifact, status: "launched" } as const;
      } catch (retryError) {
        toast.error(
          retryError instanceof Error
            ? retryError.message
            : "Failed to start plan generation"
        );
        return undefined;
      }
    },
    [multiTargetState, apiClient, queryClient]
  );

  const clearTargetSelection = useCallback(() => {
    setMultiTargetState(null);
  }, []);

  return { ...mutation, clearTargetSelection, multiTargetState, selectTarget };
}

/**
 * Launches PRD generation for a newly-created artifact through a dedicated
 * mutation so component call sites can use mutate callbacks instead of
 * `mutateAsync` try/catch flows.
 */
export function useGeneratePrdLaunch() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: async ({
      additionalRepos,
      artifact,
      computeTargetId,
    }: {
      additionalRepos?: AdditionalRepoRef[];
      artifact: Document;
      computeTargetId?: string | null;
    }): Promise<GeneratePrdLaunchResult> => {
      try {
        await postRunLoop(apiClient, {
          documentId: artifact.id,
          command: RunLoopCommand.GeneratePrd,
          ...(computeTargetId === undefined ? {} : { computeTargetId }),
          ...(additionalRepos?.length ? { additionalRepos } : {}),
        });
        return { artifact, status: "launched" };
      } catch (error) {
        let availableTargets:
          | ComputeTargetConflictBody["availableTargets"]
          | undefined;

        handleRunLoopResponse(error, {
          onMultipleTargets: (conflict) => {
            availableTargets = conflict.availableTargets;
          },
          onBackendMismatch: () => {
            toast.error(getErrorMessage(error));
          },
          onSuccess: () => {
            // unreachable: catch only receives thrown errors
          },
        });

        if (availableTargets) {
          return {
            additionalRepos,
            artifact,
            availableTargets,
            status: "pending_target_selection",
          };
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.generationStatus(data.artifact.id),
      });
      queryClient.invalidateQueries({ queryKey: ["loops"] });
    },
  });
}

/**
 * Dismiss the currently displayed generation status (shared across users).
 */
export function useDismissDocumentGenerationStatus() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      documentId,
      runKey,
    }: {
      documentId: string;
      runKey: string | null;
    }) =>
      apiClient.put<GenerationStatus>(
        `/documents/${documentId}/generation-status/dismiss`,
        { runKey }
      ),
    onSuccess: (status, { documentId }) => {
      queryClient.setQueryData(
        documentKeys.generationStatus(documentId),
        status
      );
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(documentId),
      });
      queryClient.invalidateQueries({ queryKey: documentKeys.bySlugs() });
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
    },
    onError: () => {
      toast.error("Failed to dismiss generation status");
    },
  });
}

/**
 * Fetch the pull requests associated with an artifact.
 */
export function useDocumentPullRequest(
  documentId: string,
  options?: Omit<UseQueryOptions<PullRequestInfo[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: [...documentKeys.detail(documentId), "pull-request"] as const,
    queryFn: () =>
      apiClient.get<PullRequestInfo[]>(`/documents/${documentId}/pull-request`),
    enabled: !!documentId,
    ...options,
  });
}

/**
 * Move multiple artifacts to a different project.
 */
export function useBatchMoveDocuments() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      documentIds,
      targetProjectId,
    }: {
      documentIds: string[];
      targetProjectId: string;
    }) =>
      apiClient.post<string[]>("/documents/batch-move", {
        documentIds,
        targetProjectId,
      }),
    onSuccess: (_, { targetProjectId }) => {
      // Invalidate all artifact lists to refresh source and target project views
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: documentKeys.bySlugs() });
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
export function useMergeDocuments() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      primaryDocumentId,
      secondaryDocumentId,
    }: MergeDocumentsInput) =>
      apiClient.post<Document>("/documents/merge", {
        primaryDocumentId,
        secondaryDocumentId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}
