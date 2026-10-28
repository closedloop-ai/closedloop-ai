"use client";

import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import {
  type NetworkMode,
  type QueryClient,
  QueryClientContext,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import { useApiClientOptional } from "../../shared/api/use-api-client-optional";
import { useSurfaceAnalytics } from "../../shared/observability/surface-analytics-context";
import type { BranchesQueryIdentity } from "../hooks/branch-query-keys";
import {
  type BranchesDataSource,
  createHttpBranchesDataSource,
  HTTP_BRANCHES_DATA_SOURCE_SCOPE,
} from "./branches-data-source";
import type { CompleteBranchListWork } from "./complete-branch-list-read";

type BranchesQueryPolicy = {
  networkMode?: NetworkMode;
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
  const observeBranchListWork = useBranchListWorkObserver();
  return useMemo(
    () =>
      injected?.dataSource ??
      createHttpBranchesDataSource(apiClient, { observeBranchListWork }),
    [injected?.dataSource, apiClient, observeBranchListWork]
  );
}

/**
 * Non-throwing counterpart to {@link useBranchesDataSource} (ISS-10332): the
 * injected source, else the HTTP source when an `ApiAdapterProvider` is
 * mounted, else `null`. For a shared CELL that gains an optional write and must
 * still mount where no API port exists — a bare `render(<BranchesTable />)`,
 * Storybook — and there renders its mark read-only rather than throwing.
 */
export function useBranchesDataSourceOptional(): BranchesDataSource | null {
  const injected = useContext(BranchesDataSourceContext);
  const apiClient = useApiClientOptional();
  const observeBranchListWork = useBranchListWorkObserver();
  return useMemo(() => {
    if (injected?.dataSource) {
      return injected.dataSource;
    }
    return apiClient
      ? createHttpBranchesDataSource(apiClient, { observeBranchListWork })
      : null;
  }, [injected?.dataSource, apiClient, observeBranchListWork]);
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

/**
 * The injected Branch-owned client, or null when no source injects one. Unlike
 * {@link useBranchesQueryContext} it is safe ABOVE a mount's query-client
 * check, because it reads the context alone and never falls back to
 * `useQueryClient`, which throws with no provider.
 */
export function useBranchesInjectedQueryClient(): QueryClient | null {
  return useContext(BranchesDataSourceContext)?.queryClient ?? null;
}

/**
 * Non-throwing counterpart to {@link useBranchesQueryContext}: the injected
 * Branch client when one exists, else the nearest `QueryClientProvider`'s
 * client, else `null` instead of throwing (ISS-12452).
 *
 * For a shared CELL that must still mount where no `QueryClientProvider`
 * ancestor exists at all — a bare grid-alignment test, Storybook. Reads
 * {@link QueryClientContext} directly rather than calling `useQueryClient`,
 * which throws with no provider; every hook below runs unconditionally so
 * hook order never varies with whether one is present.
 */
export function useBranchesQueryContextOptional(
  identity?: BranchesQueryIdentity
): {
  queryClient: QueryClient | null;
  queryIdentity?: BranchesQueryIdentity;
  queryPolicy?: BranchesQueryPolicy;
} {
  const injected = useContext(BranchesDataSourceContext);
  const ambientQueryClient = useContext(QueryClientContext) ?? null;
  return {
    queryClient: injected?.queryClient ?? ambientQueryClient,
    queryIdentity: identity ?? injected?.queryIdentity,
    queryPolicy: injected?.queryPolicy,
  };
}

/**
 * The active Branches source's `scope`, without constructing the fallback HTTP
 * client. {@link useBranchesDataSource} needs an `ApiAdapterProvider` ancestor
 * because it always builds that fallback; a caller that only wants to NAME the
 * source — to key a persisted snapshot by it — must not inherit that
 * requirement.
 */
export function useBranchesDataSourceScope(): string {
  return (
    useContext(BranchesDataSourceContext)?.dataSource.scope ??
    HTTP_BRANCHES_DATA_SOURCE_SCOPE
  );
}

function useBranchListWorkObserver() {
  const { capture } = useSurfaceAnalytics();
  return useCallback(
    (work: CompleteBranchListWork) => {
      capture(SurfaceAnalyticsEvent.GridviewRolloutDecision, {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        peak_request_concurrency: work.peakRequestConcurrency,
        reason: BranchesListRolloutDecisionReason.CompleteCohortRead,
        request_count: work.requestCount,
        row_count: work.rowCount,
      });
    },
    [capture]
  );
}
