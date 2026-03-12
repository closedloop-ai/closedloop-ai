"use client";

import type {
  UpdateUserInput,
  User,
  UserProfileStats,
} from "@repo/api/src/types/user";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const userKeys = {
  all: ["users"] as const,
  lists: () => [...userKeys.all, "list"] as const,
  organizationUsers: () => [...userKeys.lists(), "organization"] as const,
  currentUser: () => [...userKeys.all, "current"] as const,
  detail: (userId: string) => [...userKeys.all, "detail", userId] as const,
  stats: (userId: string) => [...userKeys.all, "stats", userId] as const,
};

// Queries
export function useCurrentUser(
  options?: Omit<UseQueryOptions<User>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.currentUser(),
    queryFn: () => apiClient.get<User>("/me"),
    staleTime: 5 * 60 * 1000, // 5 minutes - user info doesn't change frequently
    ...options,
  });
}

export function useOrganizationUsers(
  options?: Omit<UseQueryOptions<User[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.organizationUsers(),
    queryFn: () => apiClient.get<User[]>("/users"),
    ...options,
  });
}

export function useUser(
  userId: string,
  options?: Omit<UseQueryOptions<User>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.detail(userId),
    queryFn: () => apiClient.get<User>(`/users/${userId}`),
    enabled: !!userId,
    ...options,
  });
}

export function useUserStats(
  userId: string,
  options?: Omit<UseQueryOptions<UserProfileStats>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.stats(userId),
    queryFn: () => apiClient.get<UserProfileStats>(`/users/${userId}/stats`),
    staleTime: 5 * 60 * 1000,
    enabled: !!userId,
    ...options,
  });
}

// Mutations
export function useUpdateUser() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateUserInput) => {
      const { id, ...body } = input;
      return apiClient.put<User>(`/users/${id}`, body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: userKeys.organizationUsers() });
      queryClient.invalidateQueries({ queryKey: userKeys.currentUser() });
      queryClient.invalidateQueries({ queryKey: userKeys.detail(input.id) });
    },
  });
}
