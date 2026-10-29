import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * `InsightsOverviewDashboard` reads the query client directly, to invalidate the
 * insights section queries when a reader presses a degraded row's Retry
 * (ISS-10486). That is a hook call on every render, so a suite that mounts the
 * dashboard with its data hooks mocked still needs a client above it.
 *
 * The client comes from the shared harness, which is where its defaults live.
 * The provider is written out rather than taken from `createWrapperWithClient`
 * because that helper mints a fresh COMPONENT TYPE per call, which remounts the
 * whole subtree on a rerender — these suites rerender to drive a state change
 * and would lose the state they are measuring.
 */
export function withDashboardQueryClient(
  children: ReactNode,
  /** A caller's own client, when the suite needs to observe what reaches it. */
  client?: QueryClient
) {
  return (
    <QueryClientProvider client={client ?? createTestQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}
