"use client";

import { InsightsScope } from "@repo/api/src/types/insights";
import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import { InsightsOverviewDashboard } from "@repo/app/insights/components/overview/insights-overview-dashboard";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

/**
 * Org dashboard shell. Renders the shared Insights overview dashboard — the
 * same KPI cards, activity heatmap, model-usage / autonomy charts, PR
 * throughput, and distributions as the desktop dashboard — fed by the cloud
 * Insights API via WebInsightsDataSourceProvider. The app route owns Header
 * chrome, org slug, and session href shape.
 *
 * FEA-4155: no longer wrapped in `<FeatureFlagged>` on the winding-down
 * `DESKTOP_AGENT_SESSION_SYNC` flag. Dashboard is the first always-on nav
 * destination, so gating it on that flag collapsed the landing page to a
 * dead-end "No agent activity yet" while Sessions/Branches sat unblanked right
 * beside it (bot review #3789). The shared `InsightsOverviewDashboard` owns its
 * own loading / empty ("No agent sessions yet") / per-widget error states, so
 * the surface degrades honestly on a zero-data org without a flag gate.
 */
export default function DashboardPage() {
  const orgSlug = useOrgSlug();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Dashboard" }]} suppressPageHeading />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Agent-session telemetry across your organization's synced compute
            targets.
          </p>
        </div>
        <WebInsightsDataSourceProvider>
          {/* Org-scoped so the KPI/chart metrics stay consistent with the
              org-wide Recent Sessions table on this `/{orgSlug}/dashboard`
              route (mirrors the prior org-scoped dashboard). */}
          <InsightsOverviewDashboard
            getSessionHref={(session) => `/${orgSlug}/sessions/${session.id}`}
            scope={InsightsScope.Org}
          />
        </WebInsightsDataSourceProvider>
      </div>
    </div>
  );
}
