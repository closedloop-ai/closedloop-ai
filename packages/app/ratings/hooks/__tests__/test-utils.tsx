import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { type Mock, vi } from "vitest";

/**
 * Shared API-client mock for the ratings hook tests. Wire it into a test via:
 *   vi.mock("../../../shared/api/use-api-client", () => ({
 *     useApiClient: () => mockApiClient,
 *   }));
 * (the `vi.mock` call itself must stay in each test file — it is hoisted
 * per-module and cannot be shared.)
 */
export const mockApiClient: Record<"get" | "post" | "put" | "delete", Mock> = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

/** Fresh QueryClient per render, retries disabled for deterministic tests. */
export function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
