"use client";

import type { Priority } from "@repo/api/src/types/common";
import {
  type CreateProjectInput,
  type FavoriteResponse,
  ProjectStatus,
  type ProjectWithDetails,
  type UpdateProjectInput,
} from "@repo/api/src/types/project";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import { projectKeys } from "./project-keys";

export type ProjectListFilters = {
  status?: ProjectStatus[];
  excludeStatus?: ProjectStatus[];
};

// Queries
export function useProjects(
  teamId?: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails[]>, "queryKey" | "queryFn">,
  filters?: ProjectListFilters
) {
  const apiClient = useApiClient();
  const normalizedFilters = normalizeProjectListFilters(filters);

  return useQuery({
    queryKey: projectKeys.list({ teamId, ...normalizedFilters }),
    queryFn: () => {
      const query = buildProjectListQuery(teamId, normalizedFilters);
      return apiClient.get<ProjectWithDetails[]>(`/projects${query}`);
    },
    ...options,
  });
}

export function useProjectsByTeam(
  teamId: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails[]>, "queryKey" | "queryFn">,
  filters?: ProjectListFilters
) {
  const apiClient = useApiClient();
  const normalizedFilters = normalizeProjectListFilters(filters);

  return useQuery({
    queryKey: projectKeys.list({ teamId, ...normalizedFilters }),
    queryFn: () => {
      const query = buildProjectListQuery(teamId, normalizedFilters);
      return apiClient.get<ProjectWithDetails[]>(`/projects${query}`);
    },
    enabled: !!teamId,
    ...options,
  });
}

export function useProject(
  id: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: () => apiClient.get<ProjectWithDetails>(`/projects/${id}`),
    enabled: !!id,
    ...options,
  });
}

// Mutations
export function useCreateProject() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      apiClient.post<ProjectWithDetails>("/projects", {
        ...input,
        targetDate: input.targetDate?.toISOString(),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      if (result.teams.length) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.recent(result.teams[0].id),
        });
      }
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateProjectInput) => {
      const { id, targetDate, lastIndexedAt, ...data } = input;
      return apiClient.put<ProjectWithDetails>(`/projects/${id}`, {
        ...data,
        ...(targetDate !== undefined && {
          targetDate: targetDate?.toISOString(),
        }),
        ...(lastIndexedAt !== undefined && {
          lastIndexedAt: lastIndexedAt?.toISOString(),
        }),
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: projectKeys.detail(result.id),
      });
      if (result.slug) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.bySlug(result.slug),
        });
      }
      if (result.teams.length) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.recent(result.teams[0].id),
        });
      }
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useUpdateProjectAssignee() {
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      assigneeId,
    }: {
      projectId: string;
      assigneeId: string | null;
    }) => updateProject.mutateAsync({ id: projectId, assigneeId }),
  });
}

export function useUpdateProjectTargetDate() {
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      targetDate,
    }: {
      projectId: string;
      targetDate: Date | null;
    }) => updateProject.mutateAsync({ id: projectId, targetDate }),
  });
}

export function useUpdateProjectPriority() {
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      priority,
    }: {
      projectId: string;
      priority: Priority;
    }) => updateProject.mutateAsync({ id: projectId, priority }),
  });
}

export function useUpdateProjectStatus() {
  const queryClient = useQueryClient();
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      status,
    }: {
      projectId: string;
      status: ProjectStatus;
    }) => updateProject.mutateAsync({ id: projectId, status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.favorites() });
    },
  });
}

// Favorites

export function useFavoriteProjects(
  options?: Omit<UseQueryOptions<ProjectWithDetails[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.favorites(),
    queryFn: () => apiClient.get<ProjectWithDetails[]>("/projects/favorites"),
    ...options,
  });
}

export function useIsFavorite(projectId: string): boolean {
  const { data: favorites } = useFavoriteProjects();
  return favorites?.some((f) => f.id === projectId) ?? false;
}

export function useFavoriteProject() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (projectId: string) =>
      apiClient.post<FavoriteResponse>(`/projects/${projectId}/favorite`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.favorites() });
    },
  });
}

export function useUnfavoriteProject() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (projectId: string) =>
      apiClient.delete<FavoriteResponse>(`/projects/${projectId}/favorite`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.favorites() });
    },
  });
}

export function useToggleFavorite() {
  const favorite = useFavoriteProject();
  const unfavorite = useUnfavoriteProject();

  return useMutation({
    mutationFn: ({
      projectId,
      isFavorite,
    }: {
      projectId: string;
      isFavorite: boolean;
    }) => {
      if (isFavorite) {
        return unfavorite.mutateAsync(projectId);
      }
      return favorite.mutateAsync(projectId);
    },
  });
}

function normalizeProjectListFilters(
  filters?: ProjectListFilters
): ProjectListFilters {
  return {
    ...(filters?.status
      ? { status: normalizeProjectStatuses(filters.status) }
      : {}),
    ...(filters?.excludeStatus
      ? { excludeStatus: normalizeProjectStatuses(filters.excludeStatus) }
      : {}),
  };
}

type ProjectStatusHandlerOptions = {
  /** Called after a successful archive (e.g. to redirect). */
  onArchived?: (projectId: string) => void;
  /** Show an Undo toast action when unarchiving. Defaults to false. */
  showUndoOnUnarchive?: boolean;
};

/**
 * Shared handler for archive/unarchive project status mutations with
 * consistent toast + undo behaviour across pages.
 */
export function useProjectStatusHandler(
  options: ProjectStatusHandlerOptions = {}
) {
  const mutation = useUpdateProjectStatus();

  const handleUpdateStatus = useCallback(
    (
      projectId: string,
      status: ProjectStatus,
      previousStatus: ProjectStatus
    ) => {
      mutation.mutate(
        { projectId, status },
        {
          onSuccess: () => {
            if (status === ProjectStatus.Archived) {
              toast.success("Project archived", {
                action: {
                  label: "Undo",
                  onClick: () => {
                    mutation.mutate({
                      projectId,
                      status: previousStatus,
                    });
                  },
                },
              });
              options.onArchived?.(projectId);
              return;
            }

            if (options.showUndoOnUnarchive) {
              toast.success("Project unarchived", {
                action: {
                  label: "Undo",
                  onClick: () => {
                    mutation.mutate({
                      projectId,
                      status: ProjectStatus.Archived,
                    });
                  },
                },
              });
            } else {
              toast.success("Project unarchived");
            }
          },
        }
      );
    },
    [mutation, options]
  );

  return { handleUpdateStatus, isPending: mutation.isPending };
}

function normalizeProjectStatuses(statuses: ProjectStatus[]): ProjectStatus[] {
  return [...new Set(statuses)].sort();
}

function buildProjectListQuery(teamId?: string, filters?: ProjectListFilters) {
  const searchParams = new URLSearchParams();
  if (teamId) {
    searchParams.set("teamId", teamId);
  }
  if (filters?.status?.length) {
    searchParams.set("status", filters.status.join(","));
  }
  if (filters?.excludeStatus?.length) {
    searchParams.set("excludeStatus", filters.excludeStatus.join(","));
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}
