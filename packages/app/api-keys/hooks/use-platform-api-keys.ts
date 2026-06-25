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
import { useApiClient } from "../../shared/api/use-api-client";

export const platformApiKeys = {
  all: ["platform-api-keys"] as const,
  lists: () => [...platformApiKeys.all, "list"] as const,
};

export function usePlatformApiKeys(
  options?: Omit<UseQueryOptions<ApiKey[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: platformApiKeys.lists(),
    queryFn: () => apiClient.get<ApiKey[]>("/api-keys"),
    ...options,
  });
}

export function useCreatePlatformApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      apiClient.post<CreateApiKeyResponse>("/api-keys", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformApiKeys.lists() });
    },
  });
}

export function useRevokePlatformApiKey() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformApiKeys.lists() });
    },
  });
}
