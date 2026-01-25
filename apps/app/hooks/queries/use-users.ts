"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const userKeys = {
  all: ["users"] as const,
  lists: () => [...userKeys.all, "list"] as const,
  organizationUsers: () => [...userKeys.lists(), "organization"] as const,
};

// Queries
export function useOrganizationUsers(
  options?: Omit<UseQueryOptions<ApiResult<User[]>>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.organizationUsers(),
    queryFn: () => apiClient.get<User[]>("/users"),
    ...options,
  });
}
