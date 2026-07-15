"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type {
  InsightsGitHubProvenance,
  InsightsScope,
} from "@repo/api/src/types/insights";
import {
  InsightsScope as InsightsScopeValues,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { DegradedState } from "@repo/app/agents/components/shared/degraded-state";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { SessionSortKey } from "@repo/app/agents/lib/session-sort-group";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { useDashboardRange } from "@repo/app/insights/hooks/use-dashboard-range";
import {
  useAgentsInsights,
  useDeliveryInsights,
  useUtilizationInsights,
} from "@repo/app/insights/hooks/use-insights";
import { resolveMissingSourceTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { DateRangeFilter } from "@repo/app/shared/components/date-range-filter";
import { FeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Clock3Icon, LayersIcon } from "lucide-react";
import { useMemo } from "react";
import type { InsightsSectionData } from "../tile-content";
import { AI_IMPACT_FEATURE_FLAG_KEY, AiImpactCard } from "./ai-impact-card";
import { DashboardCard } from "./dashboard-card";
import { DashboardRowContent } from "./dashboard-rows";
import { DASHBOARD_ROWS } from "./dashboard-tiles";

// FEA-2232: the overview window is user-driven via the shared date-range picker
// (defaults to 90d). The selection is persisted under a dashboard-specific
// localStorage key, independent of the Sessions / Branches tabs. KPI totals
// cover the full selected range; trend sparklines stay capped at 90 days by the
// insights service, which the "all" caption reflects.
const DASHBOARD_RANGE_SURFACE = "web";
const RECENT_SESSIONS_LIMIT = 8;
// Match the Sessions page default window so "Recent Sessions" is a strict
// prefix of that list (same lastActivityAt window + ordering); see FEA-2180.
const RECENT_SESSIONS_RANGE: DateRange = "7d";

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
  const source = useInsightsDataSource();
  // FEA-2232: user-driven window (persisted, dashboard-local selection).
  const { dateRange, setDateRange, period, periodLabel, deltaLabel } =
    useDashboardRange(DASHBOARD_RANGE_SURFACE);
  const delivery = useDeliveryInsights(period, scope, undefined);
  const utilization = useUtilizationInsights(period, scope, undefined);
  const agents = useAgentsInsights(period, scope, undefined);
  // Memoized: getStartDateForRange returns a fresh ms-precision ISO string per
  // call, so an unmemoized value would change the query key every render and
  // drive a refetch/skeleton-flash loop (same reason as the Sessions page).
  const startDate = useMemo(
    () => getStartDateForRange(RECENT_SESSIONS_RANGE),
    []
  );
  // Mirror the Sessions page default view exactly — same window, same sort —
  // so "Recent Sessions" is a strict prefix of that list on every surface
  // (FEA-2180). Both must sort by last activity, not start time / cursor order.
  const sessionsQuery = useAgentSessions({
    limit: RECENT_SESSIONS_LIMIT,
    startDate,
    sortBy: SessionSortKey.LastActivity,
    sortDir: "desc",
  });

  const analyticsLoaded =
    delivery.isSuccess && utilization.isSuccess && agents.isSuccess;
  // With staleTime: Infinity and every refetch disabled, an errored insights
  // query never recovers on its own — so we must surface a degraded state
  // rather than holding the loading skeleton forever.
  const analyticsError =
    delivery.isError || utilization.isError || agents.isError;

  const sections = useMemo(
    () => ({
      [InsightsSection.Delivery]: delivery.data,
      [InsightsSection.Utilization]: utilization.data,
      [InsightsSection.Agents]: agents.data,
    }),
    [agents.data, delivery.data, utilization.data]
  );
  const sourceGetTileAvailability = source.getTileAvailability;
  const getTileAvailability = useMemo(
    () => (tile: TileDescriptor) => {
      const payloadAvailability = sections[tile.section]?.tileAvailability;
      const payloadGitHubProvenance = getSectionGitHubProvenance(
        sections[tile.section]
      );
      if (!sourceGetTileAvailability) {
        return resolveMissingSourceTileAvailability({
          tileId: tile.id,
          section: tile.section,
        });
      }
      return sourceGetTileAvailability({
        tileId: tile.id,
        section: tile.section,
        scope,
        payloadAvailability,
        payloadGitHubProvenance,
      });
    },
    [scope, sections, sourceGetTileAvailability]
  );

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
    <div className="flex min-w-0 flex-col gap-5">
      {/* FEA-2232: window picker — drives the KPI/chart insights only; Recent
          Sessions keeps its own 7d window (RECENT_SESSIONS_RANGE). */}
      <div className="flex min-w-0 justify-start overflow-x-auto sm:justify-end">
        <DateRangeFilter onChange={setDateRange} value={dateRange} />
      </div>
      {visibleRows.map((row) => (
        <div className="min-w-0" data-tour={row.tour} key={row.tour}>
          <DashboardRowContent
            autonomySeries={agents.data?.charts.autonomyTrend}
            deltaLabel={deltaLabel}
            getTileAvailability={getTileAvailability}
            githubConnectHref={source.githubConnectHref}
            heatmap={utilization.data?.charts.activityHeatmap}
            modelSeries={agents.data?.charts.modelUsageOverTime}
            onConnectGitHub={source.onConnectGitHub}
            periodLabel={periodLabel}
            row={row}
            sections={sections}
          />
          {row.tour === "stats" ? (
            <FeatureFlagged flag={AI_IMPACT_FEATURE_FLAG_KEY}>
              <div className="mt-5">
                <AiImpactCard sections={sections} />
              </div>
            </FeatureFlagged>
          ) : null}
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
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5">
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

function getSectionGitHubProvenance(
  section: InsightsSectionData[InsightsSection] | undefined
): InsightsGitHubProvenance | undefined {
  if (!(section && "githubProvenance" in section)) {
    return undefined;
  }
  return section.githubProvenance;
}
