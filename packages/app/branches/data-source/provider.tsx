"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import type { BranchesQueryIdentity } from "../hooks/branch-query-keys";
import {
  type BranchesDataSource,
  createHttpBranchesDataSource,
} from "./branches-data-source";

type BranchesQueryPolicy = {
  refetchOnReconnect?: boolean;
  refetchOnWindowFocus?: boolean;
  staleTime?: number;
};

type BranchesDataSourceContextValue = {
  dataSource: BranchesDataSource;
  queryClient?: QueryClient;
  queryIdentity?: BranchesQueryIdentity;
  queryPolicy?: BranchesQueryPolicy;
};

const BranchesDataSourceContext =
  createContext<BranchesDataSourceContextValue | null>(null);

/**
 * Inject a non-default branches data source (e.g. the desktop local DB over
 * IPC). Surfaces that mount no provider fall through to the HTTP source.
 */
export function BranchesDataSourceProvider({
  dataSource,
  queryClient,
  queryIdentity,
  queryPolicy,
  children,
}: {
  dataSource: BranchesDataSource;
  /** Optional Branch-only client; unrelated descendant queries keep their parent client. */
  queryClient?: QueryClient;
  /** Optional caller identity applied when a Branch hook does not supply one. */
  queryIdentity?: BranchesQueryIdentity;
  /** Optional Branch-only defaults applied before per-hook options. */
  queryPolicy?: BranchesQueryPolicy;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ dataSource, queryClient, queryIdentity, queryPolicy }),
    [dataSource, queryClient, queryIdentity, queryPolicy]
  );
  return (
    <BranchesDataSourceContext.Provider value={value}>
      {children}
    </BranchesDataSourceContext.Provider>
  );
}

/**
 * Resolve the active branches data source for the read hooks.
 *
 * `useApiClient()` is called **unconditionally** (Rules of Hooks) so the hook
 * order never depends on provider presence; when no provider is mounted, the
 * memoized default HTTP source is used. This is a deliberate contract, not an
 * oversight: an injected (non-HTTP) source is used as-is, but it **still
 * requires an `ApiAdapterProvider` ancestor** because the fallback HTTP client
 * is always constructed. Every surface that mounts these hooks already provides
 * one — including desktop in local mode, where it is retained (the local data
 * source is injected over it) so the auth/API stack stays available for the
 * eventual authenticated-backend path. Both halves of this contract are pinned
 * by `__tests__/provider.test.tsx`.
 */
export function useBranchesDataSource(): BranchesDataSource {
  const injected = useContext(BranchesDataSourceContext);
  const apiClient = useApiClient();
  return useMemo(
    () => injected?.dataSource ?? createHttpBranchesDataSource(apiClient),
    [injected?.dataSource, apiClient]
  );
}

/** Resolve the Branch-owned client, identity, and defaults for query hooks. */
export function useBranchesQueryContext(identity?: BranchesQueryIdentity): {
  queryClient: QueryClient;
  queryIdentity?: BranchesQueryIdentity;
  queryPolicy?: BranchesQueryPolicy;
} {
  const injected = useContext(BranchesDataSourceContext);
  const parentQueryClient = useQueryClient();
  return {
    queryClient: injected?.queryClient ?? parentQueryClient,
    queryIdentity: identity ?? injected?.queryIdentity,
    queryPolicy: injected?.queryPolicy,
  };
}
