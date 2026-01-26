"use client";

import type {
  Team,
  TeamMember,
  TeamRole,
  TeamWithCounts,
} from "@repo/api/src/types/teams";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const teamKeys = {
  all: ["teams"] as const,
  lists: () => [...teamKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...teamKeys.lists(), filters] as const,
  details: () => [...teamKeys.all, "detail"] as const,
  detail: (id: string) => [...teamKeys.details(), id] as const,
  members: (teamId: string) => [...teamKeys.detail(teamId), "members"] as const,
};

// Queries
export function useTeams(
  options?: Omit<UseQueryOptions<TeamWithCounts[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: teamKeys.lists(),
    queryFn: () => apiClient.get<TeamWithCounts[]>("/teams"),
    ...options,
  });
}

export function useTeam(
  id: string,
  options?: Omit<UseQueryOptions<TeamWithCounts>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: teamKeys.detail(id),
    queryFn: () => apiClient.get<TeamWithCounts>(`/teams/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useTeamMembers(
  teamId: string,
  options?: Omit<UseQueryOptions<TeamMember[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: teamKeys.members(teamId),
    queryFn: () => apiClient.get<TeamMember[]>(`/teams/${teamId}/members`),
    enabled: !!teamId,
    ...options,
  });
}

// Mutations
export function useCreateTeam() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: { name: string; slug?: string }) =>
      apiClient.post<TeamWithCounts>("/teams", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { name?: string; slug?: string };
    }) => apiClient.put<Team>(`/teams/${id}`, input),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({
        queryKey: teamKeys.detail(id),
      });
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/teams/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

// Team Member Mutations
export function useAddTeamMember() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      teamId,
      userId,
      role,
    }: {
      teamId: string;
      userId: string;
      role?: TeamRole;
    }) =>
      apiClient.post<TeamMember>(`/teams/${teamId}/members`, { userId, role }),
    onSuccess: (_, { teamId }) => {
      queryClient.invalidateQueries({
        queryKey: teamKeys.members(teamId),
      });
      queryClient.invalidateQueries({
        queryKey: teamKeys.detail(teamId),
      });
    },
  });
}

export function useUpdateTeamMemberRole() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      teamId,
      userId,
      role,
    }: {
      teamId: string;
      userId: string;
      role: TeamRole;
    }) =>
      apiClient.put<TeamMember>(`/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: (_, { teamId }) => {
      queryClient.invalidateQueries({
        queryKey: teamKeys.members(teamId),
      });
      queryClient.invalidateQueries({
        queryKey: teamKeys.detail(teamId),
      });
    },
  });
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      apiClient.delete<{ deleted: true }>(`/teams/${teamId}/members/${userId}`),
    onSuccess: (_, { teamId }) => {
      queryClient.invalidateQueries({
        queryKey: teamKeys.members(teamId),
      });
      queryClient.invalidateQueries({
        queryKey: teamKeys.detail(teamId),
      });
    },
  });
}
