"use client";

import type {
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

// Query keys
export const organizationKeys = {
  all: ["organizations"] as const,
  lists: () => [...organizationKeys.all, "list"] as const,
  details: () => [...organizationKeys.all, "detail"] as const,
  detail: (id: string) => [...organizationKeys.details(), id] as const,
};

// Queries
export function useOrganizations(
  options?: Omit<UseQueryOptions<Organization[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: organizationKeys.lists(),
    queryFn: () => apiClient.get<Organization[]>("/organizations"),
    ...options,
  });
}

export function useOrganization(
  id: string,
  options?: Omit<UseQueryOptions<Organization>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: organizationKeys.detail(id),
    queryFn: () => apiClient.get<Organization>(`/organizations/${id}`),
    enabled: !!id,
    ...options,
  });
}

// Mutations
export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => {
      const { id, ...data } = input;
      return apiClient.put<Organization>(`/organizations/${id}`, data);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: organizationKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: organizationKeys.lists() });
    },
  });
}
