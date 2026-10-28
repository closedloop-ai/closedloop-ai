"use client";

import type {
  ApiKey,
  CreateApiKeyInput,
  CreateApiKeyResponse,
} from "@repo/api/src/types/api-key";
import {
  type UseMutationOptions,
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

/**
 * Why both mutations below suppress the shared client's default error toast
 * (#6392, codex P1).
 *
 * `makeQueryClient`'s `mutations.onError` toasts every rejected mutation.
 * Every caller of these two reports the outcome itself, so without this flag
 * one failure produced two toasts. The legacy Settings panel passes its own
 * `onError` toast for both, and the v2 panel passes one for revoke
 * (ISS-11410). v2 create does NOT: its failure toast still comes from the
 * `catch` in `settings/v2/panels/create-api-key-dialog.tsx`, which stays on the
 * `no-local-error-toast` allowlist. Removing that catch toast without moving it
 * into an `onError` here would make a failed create silent. On revoke the pair
 * CONTRADICTED each other: the generic "Operation failed" landed first and the
 * stale-resource recovery ("That key was already revoked") landed second, so a
 * user was told their action both failed and succeeded.
 *
 * Suppressing here rather than dropping the callers' handlers is what keeps the
 * 404-means-already-revoked recovery reachable at all, and it keeps the create
 * failure on its deliberately fixed string — the create response is the one
 * place a plaintext secret exists, so that copy is not derived from the
 * attempt. Both callers of both mutations cover every reachable rejection,
 * which is the condition `packages/app/AGENTS.md` attaches to setting this flag.
 */
const SUPPRESS_DEFAULT_ERROR_TOAST = {
  suppressDefaultErrorToast: true,
} as const;

export function useCreatePlatformApiKey(
  options?: Pick<
    UseMutationOptions<CreateApiKeyResponse, Error, CreateApiKeyInput>,
    "onError"
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: SUPPRESS_DEFAULT_ERROR_TOAST,
    mutationFn: (input: CreateApiKeyInput) =>
      apiClient.post<CreateApiKeyResponse>("/api-keys", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformApiKeys.lists() });
    },
    ...options,
  });
}

export function useRevokePlatformApiKey(
  options?: Pick<
    UseMutationOptions<{ deleted: true }, Error, string>,
    "onError"
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: SUPPRESS_DEFAULT_ERROR_TOAST,
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformApiKeys.lists() });
    },
    ...options,
  });
}
