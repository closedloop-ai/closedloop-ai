/**
 * The DESKTOP host of the Agents inventory route (FEA-2923 / T-5.2 / T-16.4,
 * rehosted by ISS-9398).
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE. Three things, each a host-boundary seam:
 * the ROUTE a row links to (an unprefixed `/agents/{slug}` the desktop hash
 * route table resolves to `AgentDetailView`), the view-state persistence key,
 * and the plugin-management bridge — `HostBoundarySeam.LocalRuntimeCapability`,
 * because installing and uninstalling packs runs over main-process IPC on
 * `window.desktopApi.db.catalog*` and a browser has no analogue. It does NOT
 * decide where that panel appears or under which tab: the surface owns that.
 *
 * ONE flag read, HERE, choosing between two whole shapes — the complete
 * `AgentsListSurfaceV2` or the `AgentsGroupedList` composition that ships today,
 * where the same panel arrives through the list's `pluginsFooter` slot. Neither
 * branch knows the gate exists. The key is the SAME PostHog key web reads:
 * `DesktopFeatureFlagProvider` resolves the signed-in account's PostHog
 * assignment and nothing else (ISS-8753), so there is no Labs toggle and no
 * desktop registry entry beside it.
 *
 * This gate decides WHICH component renders the route, not whether the route
 * exists. Reaching it at all still needs the Labs container plus the
 * `agents-nav` per-item gate that ISS-5310 restored (`use-nav-gates.ts`,
 * `App.tsx` -> `renderPage`), so the FEA-3994 "always-on" note this file used to
 * carry has been wrong since that re-gating.
 *
 * FEA-4019 graduated Tools/MCPs/Hooks to first-class type tabs on both shells,
 * and FEA-4085 evacuated the Packs distribution catalog from the plugins slot —
 * desktop keeps only install / update / uninstall there until the dedicated
 * desktop Packs page (FEA-4086/4087/4089) lands.
 *
 * The opt-in distributions prompt (`OptInDistributionsBanner`) is NOT rendered
 * here — it is an app-level startup surface mounted in `AppShell` so a targeted
 * user is prompted regardless of the current tab (FEA-4007).
 *
 * Production resolves the local IPC `AgentComponentsDataSource` injected by
 * `DesktopAppCoreProvider` above this view; the `dataSource` prop is a test seam
 * only (it overrides that injected source for unit tests).
 */

import { AgentsGroupedList } from "@repo/app/agents/components/workspace/agents-grouped-list";
import { AgentsListSurfaceV2 } from "@repo/app/agents/components/workspace/agents-list-surface-v2";
import type { AgentsPluginManagementCapability } from "@repo/app/agents/components/workspace/agents-list-surface-v2-props";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { agentDetailHref } from "../../navigation/route-table";
import { PluginsPanel } from "./plugins-panel";

/** The desktop renderer's `localStorage` namespace for this route's view state. */
const DESKTOP_AGENTS_PERSIST_KEY = "agents:desktop";

/**
 * Desktop's declared plugin-management bridge.
 *
 * A named capability rather than a node the host places, so the claim it makes
 * is "this shell CAN manage installed packs" and nothing about presentation. Web
 * declares the same capability absent, and the parity ledger holds it to a
 * reason (`apps/app/__tests__/agents-list-surface-v2-host-capability-parity.test.ts`).
 */
const DESKTOP_PLUGIN_MANAGEMENT: AgentsPluginManagementCapability = {
  renderPanel: () => <PluginsPanel />,
};

export function AgentsView({
  dataSource,
}: {
  /** Test seam; overrides the DesktopAppCoreProvider-injected local source. */
  dataSource?: AgentComponentsDataSource;
} = {}) {
  const completeSurfaceEnabled = useFeatureFlagEnabled(
    AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY
  );

  const body = completeSurfaceEnabled ? (
    <AgentsListSurfaceV2
      getComponentHref={(item) => agentDetailHref(item.slug)}
      persistKey={DESKTOP_AGENTS_PERSIST_KEY}
      pluginManagement={DESKTOP_PLUGIN_MANAGEMENT}
    />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentsGroupedList
        getComponentHref={(item) => agentDetailHref(item.slug)}
        persistKey={DESKTOP_AGENTS_PERSIST_KEY}
        pluginsFooter={<PluginsPanel />}
      />
    </div>
  );

  return dataSource ? (
    <AgentComponentsDataSourceProvider dataSource={dataSource}>
      {body}
    </AgentComponentsDataSourceProvider>
  ) : (
    body
  );
}
