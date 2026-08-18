/**
 * Desktop Agents workspace view (FEA-2923 / T-5.2 / T-16.4).
 *
 * Renders the shared read-only `AgentsGroupedList` inventory under a single
 * type-tab bar (All / Agents / Commands / Skills / Plugins / MCPs / Tools /
 * Hooks — FEA-4019 graduated Tools/MCPs/Hooks to first-class tabs). The Packs
 * distribution catalog no longer bolts onto the Plugins tab (FEA-4085 evacuated
 * it — it belongs on the dedicated Packs page, a sibling slice
 * FEA-4086/4087/4089). Desktop keeps its plugin management panel
 * (install / update / uninstall) injected via the list's `pluginsFooter` slot
 * so it stays reachable under the Plugins tab until that dedicated Packs page
 * lands; web passes no footer.
 *
 * The opt-in distributions prompt (`OptInDistributionsBanner`) is NOT rendered
 * here — it is an app-level startup surface mounted in `AppShell` so a targeted
 * user is prompted regardless of the current tab (FEA-4007).
 *
 * FEA-3994: the Agents Workspace is now always-on (its Labs flag was graduated
 * and removed), so this view no longer guards on a feature flag.
 *
 * Production resolves the local IPC `AgentComponentsDataSource` injected by
 * `DesktopAppCoreProvider` above this view; the `dataSource` prop is a test
 * seam only (it overrides that injected source for unit tests).
 */

import { AgentsGroupedList } from "@repo/app/agents/components/workspace/agents-grouped-list";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { agentDetailHref } from "../../navigation/route-table";
import { PluginsPanel } from "./plugins-panel";

/**
 * Desktop Agents workspace.
 *
 * Uses the shared grouped-list with the `agents:desktop` persistence key. Rows
 * navigate to the per-component detail view (`/agents/{slug}`, rendered by
 * `AgentDetailView`) via the component's org-identity `slug` and the
 * `agentDetailHref` route helper. The plugin management panel is injected as the
 * list's `pluginsFooter`, so install / update / uninstall stays reachable under
 * the Plugins type-tab until the dedicated desktop Packs page lands.
 */
export function AgentsView({
  dataSource,
}: {
  /** Test seam; overrides the DesktopAppCoreProvider-injected local source. */
  dataSource?: AgentComponentsDataSource;
} = {}) {
  const list = (
    <AgentsGroupedList
      getComponentHref={(item) => agentDetailHref(item.slug)}
      persistKey="agents:desktop"
      pluginsFooter={<PluginsPanel />}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {dataSource ? (
        <AgentComponentsDataSourceProvider dataSource={dataSource}>
          {list}
        </AgentComponentsDataSourceProvider>
      ) : (
        list
      )}
    </div>
  );
}
