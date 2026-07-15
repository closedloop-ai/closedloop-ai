import { AgentSessionsLiveBridge } from "@repo/app/agents/data-source/agent-sessions-live-bridge";
import {
  AgentComponentsDataSourceProvider,
  AgentSessionsDataSourceProvider,
} from "@repo/app/agents/data-source/provider";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { registerSurfaceRoutingAdapter } from "@repo/shared-platform/gateway-dispatch";
import { installGatewayFetchShim } from "@repo/shared-platform/gateway-fetch-shim";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import {
  createDesktopRoutingAdapter,
  ensureDesktopRoutingSelection,
} from "../engineer/desktop-routing-adapter";
import { createDesktopTraceCommentsDataSource } from "../shared-trace-comments/desktop-trace-comments-data-source";
import { DesktopAuthProvider } from "./desktop-auth-provider";
import { InsightsLiveBridge } from "./insights-live-bridge";
import { createLocalAgentComponentsDataSource } from "./local-agent-components-data-source";
import { createLocalAgentSessionsDataSource } from "./local-agent-sessions-data-source";
import { applyDesktopSessionsListPollDefaults } from "./sessions-list-poll-defaults";

/**
 * Desktop app-core provider stack for shared `@repo/app` telemetry views.
 *
 * Agent Sessions reads route through an injected local `AgentSessionsDataSource`
 * (direct IPC to the in-process SQLite DB), and `AgentSessionsLiveBridge`
 * refreshes those views in real time off the local DB's `desktop:db:changed`
 * push stream (FEA-1834). `InsightsLiveBridge` rides the same stream to refresh
 * the dashboard's insights aggregates (KPI cards / heatmap / charts), which
 * read through `insightsKeys` and would otherwise stay one-shot-on-load. The
 * QueryClient runs a push model (`staleTime: Infinity`) so the bridges — not a
 * timer — own freshness. The one exception is the Sessions LIST query, which
 * gets a background poll fallback (FEA-2187, see
 * {@link applyDesktopSessionsListPollDefaults}): the live bridge is
 * visibility-gated, so a hidden/offscreen renderer (CI) can defer the single
 * post-import flush forever, stranding the list on its initial empty fetch.
 *
 * `ApiAdapterProvider` is retained (it still backs `useApiClient`, which the
 * data-source accessor constructs unconditionally, and the unused state
 * mutation) over an inert transport (`inertDesktopApiAdapter`). Auth is now
 * live: `DesktopAuthProvider` (FEA-2219) mirrors the main-process session
 * manager into the shared `AuthAdapter` over IPC, replacing the former static
 * signed-out adapter; feature flags stay local-only static.
 */
export function DesktopAppCoreProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [queryClient] = useState(() => {
    const client = makeQueryClient({ staleTime: Number.POSITIVE_INFINITY });
    applyDesktopSessionsListPollDefaults(client);
    return client;
  });
  const [featureFlagAdapter] = useState(() => createStaticFeatureFlagAdapter());
  const [agentComponentsDataSource] = useState(() =>
    createLocalAgentComponentsDataSource(window.desktopApi)
  );
  const [agentSessionsDataSource] = useState(() =>
    createLocalAgentSessionsDataSource(window.desktopApi)
  );
  const [traceCommentsDataSource] = useState(() =>
    createDesktopTraceCommentsDataSource(window.desktopApi)
  );

  // Engineer gateway transport (M-001): install the shared `/api/gateway/*`
  // fetch shim, register the desktop SurfaceRoutingAdapter the shared router
  // dispatches to, and repair the routing selection to LocalElectron (the
  // shared default is CloudRelay, which the desktop adapter does not support in
  // v1). Ref-counted shim + Set-backed registry + idempotent repair keep this
  // correct under React Strict Mode's mount → unmount → remount cycle.
  //
  // Unlike the web bootstrap (which guards on `shim.isFirstInstall` because
  // `installEngineerFetchInterceptor` is a global, multi-caller install keyed on
  // window state), this is the single app-core mount: each effect run registers
  // exactly one adapter and the cleanup disposes that same instance, so an
  // unconditional register/dispose pair is the idiomatic, leak-free shape here.
  useEffect(() => {
    const shim = installGatewayFetchShim();
    const disposeAdapter = registerSurfaceRoutingAdapter(
      createDesktopRoutingAdapter()
    );
    ensureDesktopRoutingSelection();
    return () => {
      disposeAdapter();
      shim.dispose();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <DesktopAuthProvider>
        <FeatureFlagAdapterProvider adapter={featureFlagAdapter}>
          <ApiAdapterProvider adapter={inertDesktopApiAdapter}>
            <AgentComponentsDataSourceProvider
              dataSource={agentComponentsDataSource}
            >
              <TraceCommentsDataSourceProvider
                dataSource={traceCommentsDataSource}
              >
                <AgentSessionsDataSourceProvider
                  dataSource={agentSessionsDataSource}
                >
                  <AgentSessionsLiveBridge />
                  <InsightsLiveBridge />
                  {children}
                </AgentSessionsDataSourceProvider>
              </TraceCommentsDataSourceProvider>
            </AgentComponentsDataSourceProvider>
          </ApiAdapterProvider>
        </FeatureFlagAdapterProvider>
      </DesktopAuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Inert API transport for desktop. Agent-session reads route through the
 * injected local data source, so the only role `ApiAdapterProvider` still plays
 * is satisfying `useApiClient` (constructed unconditionally by the data-source
 * accessor) and the unused state mutation. There is no remote REST API on
 * desktop, so the transport rejects rather than silently falling back to the
 * platform `fetch`.
 */
const inertDesktopApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://desktop.local",
  fetch: () =>
    Promise.reject(
      new Error(
        "Desktop has no remote REST API; agent-session reads use the local data source."
      )
    ),
};
