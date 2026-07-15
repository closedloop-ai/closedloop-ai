/**
 * Desktop Agents workspace view (FEA-2923 / T-5.2 / T-16.4).
 *
 * Renders the shared read-only `AgentsGroupedList` inventory under a single
 * type-tab bar (All / Agents / Commands / Skills / Plugins). The plugin
 * management surface (install / uninstall / update / catalog-browse /
 * run-history, driven by the preserved `window.desktopApi.db.catalog*` IPC) is
 * injected via the list's `pluginsFooter` slot, so it appears at the bottom of
 * the Plugins tab instead of as a separate, redundant second tab row.
 *
 * An `OptInDistributionsBanner` sits above the list and surfaces opt-in
 * distributions pushed from the main process for accept/install.
 *
 * Flag guard: returns null immediately when `AGENTS_FEATURE_FLAG_KEY` is off.
 * This mirrors the desktop gate pattern (`hiddenNavIds` hides the nav entry;
 * the render-time null guard prevents direct hash navigation from landing here
 * when the flag is off).
 *
 * Production resolves the local IPC `AgentComponentsDataSource` injected by
 * `DesktopAppCoreProvider` above this view; the `dataSource` prop is a test
 * seam only (it overrides that injected source for unit tests).
 */

import { AgentsGroupedList } from "@repo/app/agents/components/workspace/agents-grouped-list";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { OptInDistributionsBanner } from "./opt-in-distributions-banner";
import { PluginsPanel } from "./plugins-panel";

/**
 * Desktop Agents workspace.
 *
 * Uses the shared grouped-list with the `agents:desktop` persistence key. Rows
 * are non-clickable for now (no `getComponentHref`) because the per-component
 * detail view is not built yet — this avoids navigating to a 404. The plugin
 * management panel is injected as the list's `pluginsFooter`, so it renders
 * under the Plugins type-tab.
 */
export function AgentsView({
  dataSource,
}: {
  /** Test seam; overrides the DesktopAppCoreProvider-injected local source. */
  dataSource?: AgentComponentsDataSource;
} = {}) {
  const flagOn = useFeatureFlagEnabled(AGENTS_FEATURE_FLAG_KEY);
  if (!flagOn) {
    return null;
  }

  // NOTE: getComponentHref is intentionally omitted — the per-component detail
  // view is not built yet, so rows stay non-clickable to avoid 404s. Re-add the
  // agentDetailHref factory once the detail route lands.
  const list = (
    <AgentsGroupedList
      persistKey="agents:desktop"
      pluginsFooter={<PluginsPanel />}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OptInDistributionsBanner />
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
