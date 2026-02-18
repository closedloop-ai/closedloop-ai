"use client";

import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Types
type ClaudeApiKeyInfo = {
  org: { isSet: boolean; lastFour: string | null; setAt?: string | null };
  user: { isSet: boolean; lastFour: string | null; setAt?: string | null };
};

type SetKeyResponse = {
  isSet: boolean;
  lastFour: string | null;
  setAt?: string;
};

// Query key factory
export const claudeApiKeyKeys = {
  all: ["claude-api-keys"] as const,
  info: () => [...claudeApiKeyKeys.all, "info"] as const,
};

/**
 * Fetch org and user Claude API key info (masked).
 */
export function useClaudeApiKeyInfo(
  options?: Omit<UseQueryOptions<ClaudeApiKeyInfo>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: claudeApiKeyKeys.info(),
    queryFn: () => apiClient.get<ClaudeApiKeyInfo>("/settings/api-keys"),
    ...options,
  });
}

/**
 * Set the organization-level Claude API key.
 */
export function useSetOrgClaudeApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (key: string) =>
      apiClient.put<SetKeyResponse>("/settings/api-keys/org", { key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeyKeys.all });
    },
  });
}

/**
 * Remove the organization-level Claude API key.
 */
export function useRemoveOrgClaudeApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<{ deleted: true }>("/settings/api-keys/org"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeyKeys.all });
    },
  });
}

/**
 * Set the user-level Claude API key override.
 */
export function useSetUserClaudeApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (key: string) =>
      apiClient.put<SetKeyResponse>("/settings/api-keys/user", { key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeyKeys.all });
    },
  });
}

/**
 * Remove the user-level Claude API key override.
 */
export function useRemoveUserClaudeApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<{ deleted: true }>("/settings/api-keys/user"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeyKeys.all });
    },
  });
}
