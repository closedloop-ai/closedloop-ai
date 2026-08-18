"use client";

import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

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
export const claudeApiKeys = {
  all: ["claude-api-keys"] as const,
  info: () => [...claudeApiKeys.all, "info"] as const,
};

/**
 * Masked org/user Claude API key presence. Exported because surfaces outside
 * this hook (the pre-loop Cloud gate) read the same endpoint through their own
 * API client, and must not re-declare the path.
 */
export const CLAUDE_API_KEY_INFO_PATH = "/settings/api-keys";

/**
 * Fetch org and user Claude API key info (masked).
 */
export function useClaudeApiKeyInfo(
  options?: Omit<UseQueryOptions<ClaudeApiKeyInfo>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: claudeApiKeys.info(),
    queryFn: () => apiClient.get<ClaudeApiKeyInfo>(CLAUDE_API_KEY_INFO_PATH),
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
      apiClient.put<SetKeyResponse>(`${CLAUDE_API_KEY_INFO_PATH}/org`, { key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeys.all });
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
      apiClient.delete<{ deleted: true }>(`${CLAUDE_API_KEY_INFO_PATH}/org`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeys.all });
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
      apiClient.put<SetKeyResponse>(`${CLAUDE_API_KEY_INFO_PATH}/user`, {
        key,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeys.all });
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
      apiClient.delete<{ deleted: true }>(`${CLAUDE_API_KEY_INFO_PATH}/user`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: claudeApiKeys.all });
    },
  });
}
