"use client";

import type {
  GoogleDisconnectResponse,
  GoogleIntegrationStatus,
  ImportGoogleDocsInput,
  ImportGoogleDocsResponse,
} from "@repo/api/src/types/google";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/api/src/types/long-running-api-timeout";
import {
  type UseMutationOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

// Query keys
export const googleKeys = {
  all: ["google"] as const,
  status: () => [...googleKeys.all, "status"] as const,
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

/**
 * The only caller, `GoogleDriveCard`, reports every rejected disconnect with its
 * own toast (ISS-10316). The shared client's default toast would be a second
 * message for the same failure.
 */
const SUPPRESS_DEFAULT_ERROR_TOAST = {
  suppressDefaultErrorToast: true,
} as const;

export function useDisconnectGoogle(
  options?: UseMutationOptions<GoogleDisconnectResponse>
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: SUPPRESS_DEFAULT_ERROR_TOAST,
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
      // Long-running by design: the route imports every doc in the selected
      // Drive folder (one fetch + one artifact create each) before responding,
      // so it needs more than the default client deadline.
      apiClient.post<ImportGoogleDocsResponse>(
        "/integrations/google/import",
        input,
        { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
      ),
    // ISS-5013: invalidate on SETTLED, not only on success — the same reason as
    // the pack-import mutations in `agents/hooks/use-catalog.ts`. The route
    // creates one artifact per Drive doc as it goes, so a client deadline can
    // abandon a request whose documents already landed. On `onSuccess` alone the
    // documents list would keep its pre-import population beside a toast about
    // that same import — two claims about one folder, one of them false.
    // `onSettled` does not displace the shared default error toast the way an
    // `onError` override would.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    ...options,
  });
}
