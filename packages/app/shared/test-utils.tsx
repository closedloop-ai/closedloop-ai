import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Shared React Query test harness for `@repo/app` and the app shells.
 *
 * Both `apps/app` and `@repo/app` test suites need an identical isolated
 * QueryClient; the no-`apps/app`-imports rule used to force a byte-for-byte
 * copy in each `__tests__/test-utils`. This is the single source of truth —
 * `apps/app/hooks/queries/__tests__/test-utils.tsx` re-exports from here.
 */

/**
 * Creates a fresh QueryClient for each test to ensure test isolation.
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Wrapper component that provides QueryClient context for testing.
 */
export function createWrapper() {
  const queryClient = createTestQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/**
 * Wrapper component that provides a caller-supplied QueryClient.
 * Use this when you need to spy on or inspect the QueryClient after mutations.
 */
export function createWrapperWithClient(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
