"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, getFriendlyError } from "../api/api-error";

export type ErrorToastAction = { label: string; onClick: () => void };

/**
 * Render the standard error toast for a failed mutation. The generic toast
 * primitive shared across surfaces (FEA-1510): the default mutation handler
 * calls it, and domain code calls it from its own mutation `onError` when it
 * needs custom suppression or an action (e.g. loops' "View loop"). Keeps all
 * domain-specific error behavior out of this shared file.
 */
export function toastMutationError(error: unknown, action?: ErrorToastAction) {
  const friendly = getFriendlyError(error);
  toast.error(friendly.title, {
    description: friendly.description,
    ...(action ? { action } : {}),
  });
}

/**
 * QueryClient factory shared across surfaces (FEA-1510): both the web shell
 * and the desktop renderer construct their clients from this so retry and
 * the default mutation-error toast stay identical. Mutations that need
 * domain-specific error behavior override their own `onError` (which replaces
 * this default) rather than threading concerns through here. The React
 * provider wiring stays shell-side (web: `apps/app/lib/query-client.tsx`).
 */
export type MakeQueryClientOptions = {
  /**
   * Override the default query `staleTime`. The desktop shell passes
   * `Number.POSITIVE_INFINITY` for a push model: queries never go stale on a
   * timer and refresh only when the live DB-change bridge invalidates them
   * (FEA-1834). Defaults to one minute for the web shell.
   */
  staleTime?: number;
};

export function makeQueryClient(options?: MakeQueryClientOptions) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: options?.staleTime ?? 60 * 1000, // 1 minute (web default)
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: (failureCount, error) => {
          // Retry once on network instability. If we received a response from the API, don't retry.
          if (
            error instanceof ApiError &&
            (error.isClientError() || error.isServerError())
          ) {
            return false;
          }
          return failureCount < 1;
        },
        retryDelay: 1000,
      },
      mutations: {
        retry: false,
        onError: (error, _variables, _onMutateResult, mutation) => {
          if (mutation?.meta?.suppressDefaultErrorToast === true) {
            return;
          }
          toastMutationError(error);
        },
      },
    },
  });
}
