"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useRef } from "react";
import { ApiError, getFriendlyError } from "./api-error";

type QueryProviderProps = {
  children: ReactNode;
};

export function QueryProvider({ children }: Readonly<QueryProviderProps>) {
  const queryClient = useRef<QueryClient | null>(null);

  queryClient.current ??= getQueryClient();

  return (
    <QueryClientProvider client={queryClient.current}>
      {children}
    </QueryClientProvider>
  );
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
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
          const friendly = getFriendlyError(error);
          const loopId = getLoopIdFromError(error);
          toast.error(friendly.title, {
            description: friendly.description,
            ...(loopId
              ? {
                  action: {
                    label: "View loop",
                    onClick: () => {
                      globalThis.location.assign(`/loops/${loopId}`);
                    },
                  },
                }
              : {}),
          });
        },
      },
    },
  });
}

function getLoopIdFromError(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const detailsLoopId = readString(error.details, "loopId");
  if (detailsLoopId) {
    return detailsLoopId;
  }
  const dataRecord = asRecord(error.data);
  const directLoopId = readString(dataRecord, "loopId");
  if (directLoopId) {
    return directLoopId;
  }
  return readString(asRecord(dataRecord.data), "loopId");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string
): string | null {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 ? item : null;
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (globalThis.window === undefined) {
    // Server: always make a new query client
    return makeQueryClient();
  }

  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
