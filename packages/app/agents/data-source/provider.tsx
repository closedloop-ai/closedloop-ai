"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  type AgentComponentsDataSource,
  createHttpAgentComponentsDataSource,
} from "./agent-components-data-source";
import {
  type AgentSessionsDataSource,
  createHttpAgentSessionsDataSource,
} from "./agent-sessions-data-source";

// ─── AgentComponentsDataSource ───────────────────────────────────────────────

const AgentComponentsDataSourceContext =
  createContext<AgentComponentsDataSource | null>(null);

/**
 * Inject a non-default agent-components data source (e.g. the desktop Phase-1
 * stub or eventual local DB over IPC). Surfaces that mount no provider fall
 * through to the HTTP source.
 */
export function AgentComponentsDataSourceProvider({
  dataSource,
  children,
}: {
  dataSource: AgentComponentsDataSource;
  children: ReactNode;
}) {
  return (
    <AgentComponentsDataSourceContext.Provider value={dataSource}>
      {children}
    </AgentComponentsDataSourceContext.Provider>
  );
}

/**
 * Resolve the active agent-components data source for the read hooks.
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
export function useAgentComponentsDataSource(): AgentComponentsDataSource {
  const injected = useContext(AgentComponentsDataSourceContext);
  const apiClient = useApiClient();
  return useMemo(
    () => injected ?? createHttpAgentComponentsDataSource(apiClient),
    [injected, apiClient]
  );
}

// ─── AgentSessionsDataSource ─────────────────────────────────────────────────

const AgentSessionsDataSourceContext =
  createContext<AgentSessionsDataSource | null>(null);

/**
 * Inject a non-default agent-sessions data source (e.g. the desktop local DB
 * over IPC). Surfaces that mount no provider fall through to the HTTP source.
 */
export function AgentSessionsDataSourceProvider({
  dataSource,
  children,
}: {
  dataSource: AgentSessionsDataSource;
  children: ReactNode;
}) {
  return (
    <AgentSessionsDataSourceContext.Provider value={dataSource}>
      {children}
    </AgentSessionsDataSourceContext.Provider>
  );
}

/**
 * Resolve the active agent-sessions data source for the read hooks.
 *
 * `useApiClient()` is called **unconditionally** (Rules of Hooks) so the hook
 * order never depends on provider presence; when no `DataSourceProvider` is
 * mounted, the memoized default HTTP source is used. This is a deliberate
 * contract, not an oversight: an injected (non-HTTP) source is used as-is, but
 * it **still requires an `ApiAdapterProvider` ancestor** because the fallback
 * HTTP client is always constructed. Every surface that mounts these hooks
 * already provides one — including desktop in local mode, where it is retained
 * (the local data source is injected over it) so the auth/API stack stays
 * available for the eventual authenticated-backend path. Both halves of this
 * contract are pinned by `__tests__/provider.test.tsx`.
 */
export function useAgentSessionsDataSource(): AgentSessionsDataSource {
  const injected = useContext(AgentSessionsDataSourceContext);
  const apiClient = useApiClient();
  return useMemo(
    () => injected ?? createHttpAgentSessionsDataSource(apiClient),
    [injected, apiClient]
  );
}
