"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { InsightsScope } from "@repo/api/src/types/insights";
import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import { InsightsOverviewDashboard } from "@repo/app/insights/components/overview/insights-overview-dashboard";
import { LayoutDashboardIcon } from "lucide-react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

/**
 * Empty state shown when the agent telemetry dashboard is unavailable
 * (e.g. the desktop-agent-session-sync flag is off for web-only users).
 */
function DashboardEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <LayoutDashboardIcon className="h-12 w-12 text-muted-foreground" />
      <p className="text-muted-foreground">No agent activity yet</p>
      <p className="text-muted-foreground text-sm">
        Agent session metrics appear here once the desktop app starts syncing
        sessions for your organization.
      </p>
    </div>
  );
}

/**
 * Org dashboard shell. Renders the shared Insights overview dashboard — the
 * same KPI cards, activity heatmap, model-usage / autonomy charts, PR
 * throughput, and distributions as the desktop dashboard — fed by the cloud
 * Insights API via WebInsightsDataSourceProvider. The app route owns feature
 * gating, Header chrome, org slug, and session href shape.
 */
export default function DashboardPage() {
  const orgSlug = useOrgSlug();

  return (
    <FeatureFlagged
      fallback={
        <div className="flex min-h-0 flex-1 flex-col">
          <Header breadcrumbs={[{ label: "Dashboard" }]} />
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
            <DashboardEmptyState />
          </div>
        </div>
      }
      flag={DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={[{ label: "Dashboard" }]} />
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
    </FeatureFlagged>
  );
}
