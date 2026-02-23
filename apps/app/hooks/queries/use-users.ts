"use client";

import type { UpdateUserInput, User } from "@repo/api/src/types/organization";
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

// Mutations
export function useUpdateUser() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateUserInput) => {
      const { id, ...body } = input;
      return apiClient.put<User>(`/users/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.organizationUsers() });
      queryClient.invalidateQueries({ queryKey: userKeys.currentUser() });
    },
  });
}
