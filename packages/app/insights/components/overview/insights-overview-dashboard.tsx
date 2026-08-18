"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
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
import { SESSIONS_GLANCEABLE_COLUMNS } from "@repo/app/agents/hooks/use-sessions-view-state";
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
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Clock3Icon, LayersIcon } from "lucide-react";
import { useMemo } from "react";
import type { InsightsSectionData } from "../tile-content";
import { AiImpactCard } from "./ai-impact-card";
import { DashboardCard } from "./dashboard-card";
import {
  DashboardRefreshingIndicator,
  useDashboardRefreshing,
} from "./dashboard-refreshing";
import { hasAgentPipelineNodes, isRowLoading } from "./dashboard-row-sections";
import { DashboardRowContent } from "./dashboard-rows";
import {
  DashboardActivityRowSkeleton,
  DashboardAutonomyRowSkeleton,
  DashboardDistributionRowSkeleton,
  DashboardModelsRowSkeleton,
  DashboardPrsRowSkeleton,
  DashboardStatsRowSkeleton,
} from "./dashboard-skeletons";
import type { DashboardRow } from "./dashboard-tiles";
import { dashboardRowsFor } from "./dashboard-tiles";
import { useDashboardRowGates } from "./use-dashboard-row-gates";

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
  // FEA-3534: derive the session-read viewer scope from the dashboard's Me/Org
  // scope prop and thread it into the Recent Sessions query. Without this the
  // card issued a bare `GET /agent-sessions` (no scope), so after the PLN-1138
  // cloud swap the "Me" dashboard silently showed org-wide sessions. `me` maps
  // to `self` (server-enforced to the authenticated user); every other scope
  // stays org-wide, preserving the Org view. Team drill-down is not wired on
  // this card (it passes no teamId, exactly like the KPI queries above), so it
  // resolves to the org view rather than an unscoped team read.
  const viewerScope =
    scope === InsightsScopeValues.Me
      ? AgentSessionViewerScope.Self
      : AgentSessionViewerScope.Organization;
  // Mirror the Sessions page default view exactly — same window, same sort —
  // so "Recent Sessions" is a strict prefix of that list on every surface
  // (FEA-2180). Both must sort by last activity, not start time / cursor order.
  const sessionsQuery = useAgentSessions({
    limit: RECENT_SESSIONS_LIMIT,
    startDate,
    sortBy: SessionSortKey.LastActivity,
    sortDir: "desc",
    viewerScope,
  });

  const analyticsLoaded =
    delivery.isSuccess && utilization.isSuccess && agents.isSuccess;
  // With staleTime: Infinity and every refetch disabled, an errored insights
  // query never recovers on its own — so we must surface a degraded state
  // rather than holding the loading skeleton forever.
  const analyticsError =
    delivery.isError || utilization.isError || agents.isError;

  // Per-section loading gates. Below (after the error early-return) each row
  // draws its own skeleton until the sections it reads from resolve, so a slow
  // query only holds its own rows — not the whole page — behind a placeholder.
  // A section is "loading" here when it is neither settled-success nor errored.
  const sectionLoading = {
    [InsightsSection.Delivery]: !delivery.isSuccess,
    [InsightsSection.Utilization]: !utilization.isSuccess,
    [InsightsSection.Agents]: !agents.isSuccess,
  } as const;

  // FEA-4020: a single header "Refreshing" indicator for the whole dashboard.
  // Every section query is keyed on the same range (period) + scope, so a change
  // to either refetches all of them at once — one range change is one refresh,
  // and it reads as one indicator rather than a spinner dimmed over every row.
  // The indicator is gated on the user-driven request key changing (not raw
  // `isFetching`), so it never flashes for a background refetch at the same
  // range. It shows only past the first load (all sections settled once), so it
  // never competes with the per-row skeletons.
  const allSectionsSettled =
    (delivery.isSuccess || delivery.isError) &&
    (utilization.isSuccess || utilization.isError) &&
    (agents.isSuccess || agents.isError);
  const refreshing = useDashboardRefreshing({
    requestKey: `${period}:${scope}`,
    anyFetching:
      delivery.isFetching || utilization.isFetching || agents.isFetching,
    settled: allSectionsSettled,
  });

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
  // FEA-4022: the frustration trend is org opt-in (and empty when no scored
  // sessions), so it is treated like the autonomy row — kept as a skeleton while
  // the Agents section loads, dropped once it resolves without the series.
  const hasFrustration = Boolean(agents.data?.charts.frustrationTrend);
  // The agent-pipeline row also carries a data-driven filter on top of its gate:
  // an org that runs no subagents would otherwise draw a permanent 340px empty
  // card. Same treatment as its rowmates above. Gate AND data — the gate decides
  // whether the row exists at all, this decides whether an existing row has
  // anything to show.
  const hasAgentPipeline = hasAgentPipelineNodes(
    agents.data?.charts.agentPipeline
  );
  // ISS-5061 (ISS-4779 closed-by-default): resolve the row gates ONCE and thread
  // the same value through the row ORDER and the render boundary, so the two
  // cannot disagree about whether a row exists. `dashboardRowsFor` drops a
  // gated-off row from the order, so the rows below close up instead of leaving
  // a blank slot; `DashboardRowContent` re-checks at the render boundary for a
  // caller that maps `DASHBOARD_ROWS` directly. Nothing else needs the gates:
  // a row that is not in the order never reaches the loading or skeleton path.
  const rowGates = useDashboardRowGates();
  // Which rows to render. The desktop-only heatmap/autonomy rows are dropped
  // once their section resolves without that chart, but kept (as a skeleton)
  // while the section is still loading so the layout doesn't reflow when it
  // arrives. Every other row always renders — as its own skeleton until its
  // backing section lands.
  const visibleRows = dashboardRowsFor(rowGates).filter((row) => {
    if (row.tour === "activity") {
      return hasHeatmap || sectionLoading[InsightsSection.Utilization];
    }
    if (row.tour === "autonomy") {
      return hasAutonomy || sectionLoading[InsightsSection.Agents];
    }
    if (row.tour === "frustration") {
      return hasFrustration || sectionLoading[InsightsSection.Agents];
    }
    if (row.tour === "agent-pipeline") {
      return hasAgentPipeline || sectionLoading[InsightsSection.Agents];
    }
    return true;
  });
  // Recent Sessions sits under the activity heatmap when it's shown (desktop
  // order); otherwise directly under the headline stats row. While utilization
  // is still loading we can't yet know whether the heatmap exists, so anchor
  // under the heatmap row (which is rendering its skeleton) to avoid a reflow.
  const recentSessionsAnchor =
    hasHeatmap || sectionLoading[InsightsSection.Utilization]
      ? "activity"
      : "stats";

  // Empty = every section resolved and the sessions query genuinely returned no
  // synced sessions (guarding against the sessions query still loading after
  // insights resolve from cache). Per-section skeletons cover the in-flight
  // window, so we only short-circuit to the empty state once nothing is left to
  // load — never mid-load.
  const empty =
    analyticsLoaded && sessionsQuery.isSuccess && sessionsTotal === 0;

  if (analyticsError) {
    return (
      <DegradedState message="Dashboard metrics are temporarily unavailable. Refresh to try again." />
    );
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
          Sessions keeps its own 7d window (RECENT_SESSIONS_RANGE).
          FEA-4020: the single dashboard-wide "Refreshing" indicator sits beside
          the picker; a range/scope change refetches every widget at once, so it
          reads as one indicator here rather than a spinner on every row. */}
      <div className="flex min-w-0 items-center justify-start gap-3 overflow-x-auto sm:justify-end">
        <DashboardRefreshingIndicator refreshing={refreshing} />
        <DateRangeFilter onChange={setDateRange} value={dateRange} />
      </div>
      {visibleRows.map((row) => (
        <div className="min-w-0" data-tour={row.tour} key={row.tour}>
          {isRowLoading(row, sectionLoading) ? (
            <DashboardRowSkeleton row={row} />
          ) : (
            <DashboardRowContent
              agentPipeline={agents.data?.charts.agentPipeline}
              autonomySeries={agents.data?.charts.autonomyTrend}
              deltaLabel={deltaLabel}
              frustrationSeries={agents.data?.charts.frustrationTrend}
              gates={rowGates}
              getTileAvailability={getTileAvailability}
              githubConnectHref={source.githubConnectHref}
              heatmap={utilization.data?.charts.activityHeatmap}
              modelSeries={agents.data?.charts.modelUsageOverTime}
              modelTokenSeries={agents.data?.charts.modelTokensOverTime}
              onConnectGitHub={source.onConnectGitHub}
              periodLabel={periodLabel}
              row={row}
              sections={sections}
            />
          )}
          {row.tour === "stats" && !isRowLoading(row, sectionLoading) ? (
            <div className="mt-5">
              <AiImpactCard sections={sections} />
            </div>
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

/** The section-matched skeleton for a single dashboard row. */
function DashboardRowSkeleton({ row }: { row: DashboardRow }) {
  switch (row.tour) {
    case "stats":
      return <DashboardStatsRowSkeleton />;
    case "activity":
      return <DashboardActivityRowSkeleton />;
    case "models":
      return <DashboardModelsRowSkeleton />;
    case "agent-pipeline":
      // Reuses the models skeleton because the agent-pipeline card is the same
      // shape — a single full-width chart card at h-[340px] (dashboard-rows.tsx
      // `agent-pipeline` case) — so the placeholder matches the real graph and
      // nothing flash-resizes on load. If that card's height ever changes, give
      // this case its own skeleton so the two stay in sync (kept as reuse for
      // now since the heights are identical).
      return <DashboardModelsRowSkeleton />;
    case "autonomy":
      return <DashboardAutonomyRowSkeleton />;
    case "frustration":
      // FEA-4022: the frustration card is the same shape as autonomy — a single
      // full-width h-[300px] trend card (dashboard-rows.tsx `frustration` case) —
      // so it reuses the autonomy skeleton and nothing flash-resizes on load.
      return <DashboardAutonomyRowSkeleton />;
    case "prs":
      return <DashboardPrsRowSkeleton />;
    case "distribution":
      return <DashboardDistributionRowSkeleton />;
    default:
      return <DashboardPrsRowSkeleton />;
  }
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
          visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
        />
      )}
    </DashboardCard>
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
