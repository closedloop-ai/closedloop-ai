"use client";

import {
  PENSERO_INTEGRATION_PATH,
  type PenseroCredentialInfoResponse,
  type RemovePenseroCredentialResponse,
  type SetPenseroCredentialRequest,
} from "@repo/api/src/types/pensero-integration";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Client access to the per-org Pensero credential (ISS-8007).
 *
 * There is deliberately NO hook that reads the token back. The server never
 * returns it, so no client type here has a field for it: a credential is
 * write-and-replace, and the UI knows only whether one is set, its last-four
 * fingerprint, and when it was written.
 *
 * The request and response SHAPES are imported from
 * `@repo/api/src/types/pensero-integration`, the same module the route types its
 * handlers with, rather than restated here. A second structurally identical
 * declaration typechecks on its own, so a field the route adds or renames would
 * stay green on this side until a render read `undefined` (#6030, codex P1).
 */

export const penseroIntegrationKeys = {
  all: ["pensero-integration"] as const,
  info: () => [...penseroIntegrationKeys.all, "info"] as const,
};

/**
 * Why both mutations below set `suppressDefaultErrorToast` (#6030, whitlockk and
 * codex P2).
 *
 * The shared `QueryClient` (`shared/query/query-client.ts`) toasts every
 * rejected mutation by default, and the Pensero card ALSO reports failures —
 * deliberately, because the server's own message ("must be an absolute https://
 * URL", "must look like tk_…:sk_…") is the actionable sentence and
 * `getFriendlyError` replaces it with generic copy. Without this flag the admin
 * gets both toasts for one failure. Suppressing here rather than dropping the
 * card's handler keeps the specific message; the card covers every reachable
 * rejection on both mutations, which is the condition `packages/app/AGENTS.md`
 * attaches to setting this flag.
 */
const SUPPRESS_DEFAULT_ERROR_TOAST = {
  suppressDefaultErrorToast: true,
} as const;

/** Presence + fingerprint of the org's Pensero credential. */
export function usePenseroIntegrationInfo(
  options?: Omit<
    UseQueryOptions<PenseroCredentialInfoResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: penseroIntegrationKeys.info(),
    queryFn: () =>
      apiClient.get<PenseroCredentialInfoResponse>(PENSERO_INTEGRATION_PATH),
    ...options,
  });
}

/** Create or replace the org's Pensero credential. Admin only, server-enforced. */
export function useSetPenseroCredential() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: SUPPRESS_DEFAULT_ERROR_TOAST,
    mutationFn: (input: SetPenseroCredentialRequest) =>
      apiClient.put<PenseroCredentialInfoResponse>(
        PENSERO_INTEGRATION_PATH,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: penseroIntegrationKeys.all });
    },
  });
}

/** Remove the org's Pensero credential. Admin only, server-enforced. */
export function useRemovePenseroCredential() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: SUPPRESS_DEFAULT_ERROR_TOAST,
    mutationFn: () =>
      apiClient.delete<RemovePenseroCredentialResponse>(
        PENSERO_INTEGRATION_PATH
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: penseroIntegrationKeys.all });
    },
  });
}
