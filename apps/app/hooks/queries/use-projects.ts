"use client";

import type { ActivityResponse } from "@repo/api/src/types/activity";
import type {
  CreateProjectInput,
  ProjectPriority,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
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
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: projectKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
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
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

export function useUpdateProjectOwner() {
  const updateProject = useUpdateProject();

  return useMutation({
    mutationFn: ({
      projectId,
      ownerId,
    }: {
      projectId: string;
      ownerId: string | null;
    }) => updateProject.mutateAsync({ id: projectId, ownerId }),
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
      priority: ProjectPriority;
    }) => updateProject.mutateAsync({ id: projectId, priority }),
  });
}

export function useUploadCodebaseSummary() {
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
  });
}
