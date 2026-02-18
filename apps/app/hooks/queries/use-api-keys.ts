"use client";

import type {
  ApiKey,
  CreateApiKeyInput,
  CreateApiKeyResponse,
} from "@repo/api/src/types/api-key";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const apiKeyKeys = {
  all: ["api-keys"] as const,
  lists: () => [...apiKeyKeys.all, "list"] as const,
};

export function useApiKeys(
  options?: Omit<UseQueryOptions<ApiKey[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: apiKeyKeys.lists(),
    queryFn: () => apiClient.get<ApiKey[]>("/api-keys"),
    ...options,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      apiClient.post<CreateApiKeyResponse>("/api-keys", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.lists() });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.lists() });
    },
  });
}
