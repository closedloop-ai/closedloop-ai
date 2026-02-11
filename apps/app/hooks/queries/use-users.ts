"use client";

import type { User } from "@repo/api/src/types/organization";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
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
