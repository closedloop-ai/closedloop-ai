"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  type BranchesDataSource,
  createHttpBranchesDataSource,
} from "./branches-data-source";

const BranchesDataSourceContext = createContext<BranchesDataSource | null>(
  null
);

/**
 * Inject a non-default branches data source (e.g. the desktop local DB over
 * IPC). Surfaces that mount no provider fall through to the HTTP source.
 */
export function BranchesDataSourceProvider({
  dataSource,
  children,
}: {
  dataSource: BranchesDataSource;
  children: ReactNode;
}) {
  return (
    <BranchesDataSourceContext.Provider value={dataSource}>
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
    () => injected ?? createHttpBranchesDataSource(apiClient),
    [injected, apiClient]
  );
}
