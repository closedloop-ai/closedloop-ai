"use client";

import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useRef } from "react";

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

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (globalThis.window === undefined) {
    // Server: always make a new query client
    return makeQueryClient();
  }

  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
