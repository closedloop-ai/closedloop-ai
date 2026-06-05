"use client";

import type { ActivityResponse } from "@repo/api/src/types/activity";
import type { Priority } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  FavoriteResponse,
  ProjectStatus,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/project";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...projectKeys.lists(), filters] as const,
  details: () => [...projectKeys.all, "detail"] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
  activity: (id: string, page: number, pageSize: number) =>
    [...projectKeys.detail(id), "activity", { page, pageSize }] as const,
  recent: (teamId: string) => [...projectKeys.all, "recent", teamId] as const,
  favorites: () => [...projectKeys.all, "favorites"] as const,
  bySlug: (slug: string) => [...projectKeys.all, "by-slug", slug] as const,
};

// Queries
export function useProjects(
  teamId?: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.list({ teamId }),
    queryFn: () => {
      const query = teamId ? `?teamId=${teamId}` : "";
      return apiClient.get<ProjectWithDetails[]>(`/projects${query}`);
    },
    ...options,
  });
}

export function useProjectsByTeam(
  teamId: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.list({ teamId }),
    queryFn: () =>
      apiClient.get<ProjectWithDetails[]>(`/projects?teamId=${teamId}`),
    enabled: !!teamId,
    ...options,
  });
}

export function useRecentProjectsByTeam(
  teamId: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.recent(teamId),
    queryFn: () =>
      apiClient.get<ProjectWithDetails[]>(`/projects?teamId=${teamId}&limit=3`),
    enabled: options?.enabled ?? true,
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

export function useProjectBySlug(
  slug: string,
  options?: Omit<UseQueryOptions<ProjectWithDetails>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.bySlug(slug),
    queryFn: () =>
      apiClient.get<ProjectWithDetails>(`/projects/by-slug/${slug}`),
    enabled: !!slug,
    ...options,
  });
}

export function useProjectActivity(
  projectId: string,
  page = 1,
  pageSize = 20,
  options?: Omit<UseQueryOptions<ActivityResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectKeys.activity(projectId, page, pageSize),
    queryFn: () =>
      apiClient.get<ActivityResponse>(
        `/projects/${projectId}/activity?page=${page}&pageSize=${pageSize}`
      ),
    enabled: !!projectId,
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
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      status,
    }: {
      projectId: string;
      status: ProjectStatus;
    }) => updateProject.mutateAsync({ id: projectId, status }),
  });
}

export function useUploadCodebaseSummary() {
  const queryClient = useQueryClient();
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      markdownContent,
    }: {
      projectId: string;
      markdownContent: string;
    }) =>
      updateProject.mutateAsync({
        id: projectId,
        codebaseSummary: markdownContent,
        lastIndexedAt: new Date(),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: projectKeys.detail(result.id),
      });
      if (result.slug) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.bySlug(result.slug),
        });
      }
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
