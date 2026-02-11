"use client";

import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Types
type ApiKeyInfo = {
  org: { isSet: boolean; lastFour: string | null };
  user: { isSet: boolean; lastFour: string | null };
};

type SetKeyResponse = { isSet: boolean; lastFour: string | null };

// Query key factory
export const apiKeyKeys = {
  all: ["api-keys"] as const,
  info: () => [...apiKeyKeys.all, "info"] as const,
};

/**
 * Fetch org and user API key info (masked).
 */
export function useApiKeyInfo(
  options?: Omit<UseQueryOptions<ApiKeyInfo>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: apiKeyKeys.info(),
    queryFn: () => apiClient.get<ApiKeyInfo>("/settings/api-keys"),
    ...options,
  });
}

/**
 * Set the organization-level Claude API key.
 */
export function useSetOrgApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (key: string) =>
      apiClient.put<SetKeyResponse>("/settings/api-keys/org", { key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

/**
 * Remove the organization-level Claude API key.
 */
export function useRemoveOrgApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<{ deleted: true }>("/settings/api-keys/org"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

/**
 * Set the user-level Claude API key override.
 */
export function useSetUserApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (key: string) =>
      apiClient.put<SetKeyResponse>("/settings/api-keys/user", { key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

/**
 * Remove the user-level Claude API key override.
 */
export function useRemoveUserApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<{ deleted: true }>("/settings/api-keys/user"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}
