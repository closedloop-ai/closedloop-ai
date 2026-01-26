"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "@repo/design-system/components/ui/sonner";
import { type ReactNode, useRef } from "react";
import { ApiError } from "./api-error";

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

/**
 * Get a user-friendly error message from an error object.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred";
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
      },
      mutations: {
        onError: (error) => {
          const message = getErrorMessage(error);
          toast.error(message);
        },
      },
    },
  });
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
