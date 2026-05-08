"use client";

import type {
  GoogleDisconnectResponse,
  GoogleIntegrationStatus,
  ImportGoogleDocsInput,
  ImportGoogleDocsResponse,
} from "@repo/api/src/types/google";
import {
  type UseMutationOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const GDRIVE_FOLDER_ID_REGEX = /^[a-zA-Z0-9_-]{28,40}$/;

// Query keys
export const googleKeys = {
  all: ["google"] as const,
  status: () => [...googleKeys.all, "status"] as const,
  folderFiles: (folderId: string) =>
    [...googleKeys.all, "folderFiles", folderId] as const,
};

// Queries
export function useGoogleIntegrationStatus(
  options?: Omit<
    UseQueryOptions<GoogleIntegrationStatus>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: googleKeys.status(),
    queryFn: () =>
      apiClient.get<GoogleIntegrationStatus>("/integrations/google"),
    ...options,
  });
}

// Mutations
export function useDisconnectGoogle(
  options?: UseMutationOptions<GoogleDisconnectResponse>
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<GoogleDisconnectResponse>("/integrations/google"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: googleKeys.status() });
    },
    ...options,
  });
}

export function useImportGoogleDocs(
  options?: UseMutationOptions<
    ImportGoogleDocsResponse,
    Error,
    ImportGoogleDocsInput
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input) =>
      apiClient.post<ImportGoogleDocsResponse>(
        "/integrations/google/import",
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    ...options,
  });
}

export function useGDriveFolderFiles(
  folderId: string,
  options?: Omit<
    UseQueryOptions<{ id: string; name: string }[]>,
    "queryKey" | "queryFn" | "enabled"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: googleKeys.folderFiles(folderId),
    queryFn: () =>
      apiClient.get<{ id: string; name: string }[]>(
        `/integrations/google/files?folderId=${encodeURIComponent(folderId)}`
      ),
    enabled: folderId.length > 0 && GDRIVE_FOLDER_ID_REGEX.test(folderId),
    staleTime: 30 * 1000,
    ...options,
  });
}

/**
 * Get the Google OAuth URL for connecting.
 * Returns the app's OAuth route directly (no API call needed).
 * The OAuth flow is handled entirely by the app, which then sends
 * tokens to the API for storage.
 */
export function getGoogleOAuthUrl(): string {
  return "/api/integrations/google";
}
