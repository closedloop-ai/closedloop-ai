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
    // Server: always make a new, per-request query client. Pin `gcTime` to
    // Infinity here (TanStack's SSR convention) so no garbage-collection timeout
    // is ever scheduled on the server: a live gcTime timer keeps its QueryClient
    // (and cache) reachable for the whole window, so under sustained SSR traffic
    // finite retention would accumulate per-request caches and timers. Passing a
    // base gcTime override also disables FEA-4104's listing scope-up, so the
    // 30-minute listing window (browser-only) never schedules a finite timer
    // server-side either. With Infinity there is no timer, and the per-request
    // client is collected normally once rendering completes and it drops out of
    // scope.
    //
    // The shared client's focus/reconnect refetch defaults (ISS-5976) are left
    // inherited rather than overridden here: React Query's focus and online
    // managers are driven by `window`/`document` events, and there is no window
    // on the server, so neither trigger can ever fire against a per-request
    // client. Overriding them would add a policy line that reads as meaningful
    // and is not.
    return makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
  }

  // Browser: no overrides, so this inherits the shared factory's freshness
  // policy — `staleTime` 60s with refetch-on-focus and refetch-on-reconnect ON
  // (ISS-5976). That inheritance IS the fix: the web shell has no push stream,
  // so those two events are the only things that ever act on staleness here.
  // Before ISS-5976 the factory forced both off for every caller, which left
  // this client with a staleness clock and nothing to read it — every web list
  // stayed stale until the user reloaded the page or hit a manual Refresh.
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
