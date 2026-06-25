"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type {
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import {
  InsightsScope as InsightsScopeValues,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { DegradedState } from "@repo/app/agents/components/shared/degraded-state";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import {
  useAgentsInsights,
  useDeliveryInsights,
  useUtilizationInsights,
} from "@repo/app/insights/hooks/use-insights";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Clock3Icon, LayersIcon } from "lucide-react";
import { DashboardCard } from "./dashboard-card";
import { DashboardRowContent } from "./dashboard-rows";
import { DASHBOARD_ROWS } from "./dashboard-tiles";

// The overview dashboard is a 90-day window: every widget — KPI totals, trend
// sparklines, and the activity heatmap — uses a rolling 90-day window so the
// metrics and time-series visuals stay bounded and readable (the all-time
// corpus produces an unreadable ~200-column heatmap and noisy trends).
const PERIOD: InsightsPeriod = "90";
const PERIOD_LABEL = "Last 90 days";
const RECENT_SESSIONS_LIMIT = 8;

export type InsightsOverviewDashboardProps = {
  /** Route href for a session row; each surface owns its URL shape. */
  getSessionHref: (item: AgentSessionListItem) => string;
  /** Aggregation scope for the insights queries. Defaults to the current user. */
  scope?: InsightsScope;
};

/**
 * Surface-agnostic overview dashboard body: a fixed, read-only layout built
 * from the shared Insights tile catalog (KPIs, activity heatmap, recent
 * sessions, model usage, autonomy trend, PR throughput, distributions). The web
 * shell mounts this inside `WebInsightsDataSourceProvider`; the desktop shell
 * composes the same rows with its own first-launch reveal + guided tour.
 */
export function InsightsOverviewDashboard({
  getSessionHref,
  scope = InsightsScopeValues.Me,
}: Readonly<InsightsOverviewDashboardProps>) {
  const delivery = useDeliveryInsights(PERIOD, scope);
  const utilization = useUtilizationInsights(PERIOD, scope);
  const agents = useAgentsInsights(PERIOD, scope);
  const sessionsQuery = useAgentSessions({ limit: RECENT_SESSIONS_LIMIT });

  const analyticsLoaded =
    delivery.isSuccess && utilization.isSuccess && agents.isSuccess;
  // With staleTime: Infinity and every refetch disabled, an errored insights
  // query never recovers on its own — so we must surface a degraded state
  // rather than holding the loading skeleton forever.
  const analyticsError =
    delivery.isError || utilization.isError || agents.isError;

  const sections = {
    [InsightsSection.Delivery]: delivery.data,
    [InsightsSection.Utilization]: utilization.data,
    [InsightsSection.Agents]: agents.data,
  };

  const recentItems = sessionsQuery.data?.items ?? [];
  const sessionsTotal = sessionsQuery.data?.total ?? 0;

  // The activity heatmap and autonomy trend are populated only by the desktop's
  // local insights engine; the cloud Insights API marks them "desktop-only" and
  // omits them today. Render those chart rows only when their data is actually
  // present, so web never shows a perpetual skeleton (autonomy) or a
  // permanently-empty card (heatmap) — and they light up automatically if the
  // API starts serving them. Every other row is backed by web-populated charts.
  const hasHeatmap = Boolean(utilization.data?.charts.activityHeatmap);
  const hasAutonomy = Boolean(agents.data?.charts.autonomyTrend);
  const visibleRows = DASHBOARD_ROWS.filter((row) => {
    if (row.tour === "activity") {
      return hasHeatmap;
    }
    if (row.tour === "autonomy") {
      return hasAutonomy;
    }
    return true;
  });
  // Recent Sessions sits under the activity heatmap when it's shown (desktop
  // order); otherwise directly under the headline stats row.
  const recentSessionsAnchor = hasHeatmap ? "activity" : "stats";

  // Hold the loading treatment until every insights section resolves so we
  // never flash bare zero/"Unknown" tiles. Empty = analytics loaded and the
  // sessions query has resolved with genuinely no synced sessions yet (guarding
  // against the sessions query still loading after insights resolve from cache).
  const loading = !(analyticsLoaded || analyticsError);
  const empty =
    analyticsLoaded && sessionsQuery.isSuccess && sessionsTotal === 0;

  if (analyticsError) {
    return (
      <DegradedState message="Dashboard metrics are temporarily unavailable. Refresh to try again." />
    );
  }

  if (loading) {
    return <DashboardLoading />;
  }

  if (empty) {
    return (
      <EmptyState
        className="min-h-[360px] rounded-xl border border-border/70 bg-card"
        description="Connect a compute target with desktop agent-session sync enabled and your agent runs will appear here automatically."
        icon={LayersIcon}
        title="No agent sessions yet"
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {visibleRows.map((row) => (
        <div data-tour={row.tour} key={row.tour}>
          <DashboardRowContent
            autonomySeries={agents.data?.charts.autonomyTrend}
            heatmap={utilization.data?.charts.activityHeatmap}
            modelSeries={agents.data?.charts.modelUsageOverTime}
            periodLabel={PERIOD_LABEL}
            row={row}
            sections={sections}
          />
          {row.tour === recentSessionsAnchor ? (
            <div className="mt-5">
              <RecentSessions
                getSessionHref={getSessionHref}
                isError={sessionsQuery.isError}
                isLoading={sessionsQuery.isLoading}
                items={recentItems}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RecentSessions({
  items,
  isLoading,
  isError,
  getSessionHref,
}: {
  items: AgentSessionListItem[];
  isLoading: boolean;
  isError: boolean;
  getSessionHref: (item: AgentSessionListItem) => string;
}) {
  return (
    <DashboardCard
      description="Latest synced agent runs"
      title="Recent Sessions"
    >
      {isLoading ? (
        <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
          Loading sessions…
        </div>
      ) : null}
      {isError ? (
        <div className="py-8 text-center text-[var(--destructive)] text-sm">
          Recent sessions are temporarily unavailable.
        </div>
      ) : null}
      {isLoading || isError ? null : (
        <SyncedSessionsTable
          emptyState={
            <EmptyState
              className="py-12"
              description="No synced sessions have arrived yet."
              icon={Clock3Icon}
              title="No recent sessions"
            />
          }
          getSessionHref={getSessionHref}
          items={items}
        />
      )}
    </DashboardCard>
  );
}

function DashboardLoading() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => i).map((i) => (
          <Skeleton className="h-[104px] rounded-[1.25rem]" key={i} />
        ))}
      </div>
      <Skeleton className="h-[300px] rounded-[1.25rem]" />
      <Skeleton className="h-[280px] rounded-[1.25rem]" />
      <Skeleton className="h-[340px] rounded-[1.25rem]" />
    </div>
  );
}
