/**
 * Desktop Agent component detail view (FEA-2923 / T-5.3 / AC-022).
 *
 * Mirrors `BranchDetailView`: mounts the shared `AgentDetail` from
 * `@repo/app/agents/components/workspace/agent-detail`. Below it, the
 * `OptimizationAnalyticsPanel` renders the desktop-local personal-optimization
 * analytics (token-by-model trend, sub-agent pull-in frequency, skill-loaded
 * triage) for the resolved component via the `window.desktopApi.db` IPC.
 *
 * The shared `AgentDetail`'s HTTP-backed "Token trend by model" section is a
 * render-prop `analytics` slot that desktop simply omits: its
 * `useAgentComponentTokenTrend` hook calls the REST API through the inert
 * desktop HTTP adapter (there is no local IPC token-trend source), which would
 * otherwise render a red "Failed to load token trend" error on every desktop
 * detail view. The equivalent desktop-local trend is served by
 * `OptimizationAnalyticsPanel` over IPC.
 *
 * Flag guard: returns null immediately when `AGENTS_FEATURE_FLAG_KEY` is off.
 *
 * Production resolves the local IPC `AgentComponentsDataSource` injected by
 * `DesktopAppCoreProvider`; there is no HTTP fallback on desktop.
 * `usePublishDetailTitle` keeps the Topbar breadcrumb ("Agents / <name>") in
 * sync while the view is mounted.
 */

import { AgentDetail } from "@repo/app/agents/components/workspace/agent-detail";
import { useAgentComponentDetail } from "@repo/app/agents/hooks/use-agent-component-detail";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { usePublishDetailTitle } from "../../navigation/detail-title-context";
import { OptimizationAnalyticsPanel } from "./optimization-analytics-panel";

/**
 * Split an org-identity slug (`${kind}::${key}`) into its analytics key half.
 *
 * The analytics IPC (`getComponentModelTrend`, `getSubagentFrequency`,
 * `isSkillLoaded`) filters on `agent_component_session_usage.component_key`,
 * which the identity slug is derived from (`orgIdentitySlug`). The display
 * `name` is NOT a reliable key — e.g. skills key on `/name` — so keying the
 * panel on the slug's key half avoids silently-empty analytics when the
 * display name differs from the usage `component_key`.
 */
function analyticsKeyFromSlug(slug: string): string {
  const sep = slug.indexOf("::");
  return sep === -1 ? slug : slug.slice(sep + 2);
}

/**
 * Desktop wrapper for the shared Agent Detail body (FEA-2923 / T-5.3).
 *
 * Mounts the shared `AgentDetail` presentational component, which fetches data
 * via `useAgentComponentDetail` off the injected local IPC data source, and
 * appends the desktop-local `OptimizationAnalyticsPanel` for the resolved
 * component.
 *
 * `usePublishDetailTitle` publishes the resolved component name to the Topbar
 * breadcrumb ("Agents / <name>") while this view is mounted.
 */
export function AgentDetailView({
  agentSlug,
  backHref,
}: {
  agentSlug: string;
  backHref: string;
}) {
  const flagOn = useFeatureFlagEnabled(AGENTS_FEATURE_FLAG_KEY);
  if (!flagOn) {
    return null;
  }

  return <AgentDetailViewContent agentSlug={agentSlug} backHref={backHref} />;
}

function AgentDetailViewContent({
  agentSlug,
}: {
  agentSlug: string;
  backHref: string;
}) {
  const detailQuery = useAgentComponentDetail(agentSlug);
  const detail = detailQuery.data;

  // Publish the component name to the Topbar breadcrumb ("Agents / <name>");
  // null while the detail is still loading. Uses a raw string key to avoid
  // extending DetailKind in detail-title-context (which is outside this
  // agent's file boundary): the key format mirrors detailTitleKey().
  usePublishDetailTitle(`agent:${agentSlug}`, detail?.name ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {/*
       * No `analytics` slot is passed: the shared `AgentDetail`'s optional
       * HTTP-backed "Token trend by model" section stays unmounted on desktop
       * (its `useAgentComponentTokenTrend` hook would hit the inert desktop HTTP
       * adapter and render a red "Failed to load token trend" error). The
       * equivalent desktop-local trend is served by `OptimizationAnalyticsPanel`
       * over IPC below.
       */}
      <AgentDetail slug={agentSlug} />
      {detail ? (
        <OptimizationAnalyticsPanel
          target={{
            kind: detail.kind,
            // Analytics query keys on `agent_component_session_usage.component_key`
            // (the slug's key half), NOT the display name.
            key: analyticsKeyFromSlug(agentSlug),
            name: detail.name,
          }}
        />
      ) : null}
    </div>
  );
}
