"use client";

import { useAnalytics } from "@repo/analytics/client";
import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import {
  AgentTelemetryAnalytics,
  type AgentTelemetryAnalyticsQueryState,
} from "@repo/app/agents/components/analytics/agent-telemetry-analytics";
import {
  buildSearchParams,
  getStartDateForRange,
  parseDateRange,
} from "@repo/app/shared/lib/format-utils";
import type { ReadonlySearchParams } from "@repo/navigation/navigation-adapter";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";

/**
 * Non-org monitoring route wrapper. It owns route state, analytics capture,
 * feature gating, and non-org hrefs while the shared package body owns render.
 */
export default function AgentMonitoringPage() {
  const analytics = useAnalytics();
  const navigation = useNavigation();
  const searchParams = useSearchParamsValue();
  const [queryState, setQueryState] = useState(() =>
    parseMonitoringQueryState(searchParams)
  );
  const previousFilterKeyRef = useRef<string | null>(null);
  const sharedFilters = useMemo(
    () => ({
      dateRange: queryState.dateRange,
      harness: queryState.harness,
      projectId: queryState.selectedProjectId,
      status: queryState.status,
      teamId: queryState.selectedTeamId,
      userId: queryState.selectedUserId,
    }),
    [queryState]
  );
  const exportHref = useMemo(() => {
    const params = buildSearchParams({
      format: "csv",
      harness: queryState.harness === "all" ? undefined : queryState.harness,
      projectId: queryState.selectedProjectId ?? undefined,
      startDate: getStartDateForRange(queryState.dateRange),
      status: queryState.status === "all" ? undefined : queryState.status,
      teamId: queryState.selectedTeamId ?? undefined,
      userId: queryState.selectedUserId ?? undefined,
    }).toString();
    return `/api/agent-sessions/export${params ? `?${params}` : ""}`;
  }, [queryState]);

  useEffect(() => {
    analytics.capture("agent_sessions_dashboard_viewed", {
      surface: "agent_monitoring",
    });
  }, [analytics]);

  useEffect(() => {
    const filterKey = JSON.stringify(sharedFilters);
    if (previousFilterKeyRef.current === null) {
      previousFilterKeyRef.current = filterKey;
      return;
    }
    if (previousFilterKeyRef.current === filterKey) {
      return;
    }
    previousFilterKeyRef.current = filterKey;
    analytics.capture("agent_sessions_filter_applied", {
      date_range: queryState.dateRange,
      harness: queryState.harness,
      project_id: queryState.selectedProjectId,
      status: queryState.status,
      team_id: queryState.selectedTeamId,
      user_id: queryState.selectedUserId,
    });
  }, [analytics, queryState, sharedFilters]);

  useEffect(() => {
    const nextQuery = buildMonitoringQuery(queryState);
    if (nextQuery === searchParams.toString()) {
      return;
    }
    navigation.replace(`/loops/monitoring${nextQuery ? `?${nextQuery}` : ""}`, {
      scroll: false,
    });
  }, [navigation, queryState, searchParams]);

  return (
    <FeatureFlagged flag={DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Header
          breadcrumbs={[
            { label: "Loops", href: "/loops" },
            { label: "Agent Monitoring" },
          ]}
        />
        <AgentTelemetryAnalytics
          exportHref={exportHref}
          getSessionHref={(session) => `/sessions/${session.id}`}
          getUserHref={(userId) => `/sessions?userId=${userId}`}
          onQueryStateChange={setQueryState}
          organizationFiltersEnabled
          queryState={queryState}
        />
      </div>
    </FeatureFlagged>
  );
}

function parseMonitoringQueryState(
  searchParams: ReadonlySearchParams
): AgentTelemetryAnalyticsQueryState {
  const value = Number(searchParams.get("page") ?? "1");
  return {
    dateRange: parseDateRange(searchParams.get("dateRange")),
    harness: searchParams.get("harness") ?? "all",
    page: Number.isFinite(value) && value > 1 ? value - 1 : 0,
    selectedProjectId: searchParams.get("projectId"),
    selectedTeamId: searchParams.get("teamId"),
    selectedUserId: searchParams.get("userId"),
    status: searchParams.get("status") ?? "all",
  };
}

function buildMonitoringQuery(
  queryState: AgentTelemetryAnalyticsQueryState
): string {
  return buildSearchParams({
    dateRange:
      queryState.dateRange === "30d" ? undefined : queryState.dateRange,
    harness: queryState.harness === "all" ? undefined : queryState.harness,
    page: queryState.page > 0 ? String(queryState.page + 1) : undefined,
    projectId: queryState.selectedProjectId ?? undefined,
    status: queryState.status === "all" ? undefined : queryState.status,
    teamId: queryState.selectedTeamId ?? undefined,
    userId: queryState.selectedUserId ?? undefined,
  }).toString();
}
