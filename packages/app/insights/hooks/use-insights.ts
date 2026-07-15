"use client";

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsScope,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { InsightsScope as InsightsScopeValues } from "@repo/api/src/types/insights";
import {
  keepPreviousData,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query";
import { useInsightsDataSource } from "../data/insights-data-source";

const INSIGHTS_QUERY_OPTIONS = {
  refetchInterval: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: Number.POSITIVE_INFINITY,
} as const;

export const insightsKeys = {
  all: ["insights"] as const,
  section: (
    section: string,
    period: InsightsPeriod,
    scope: InsightsScope,
    teamId?: string
  ) => [...insightsKeys.all, section, period, scope, teamId ?? null] as const,
};

export function useDeliveryInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  teamId?: string,
  enabled = true
): UseQueryResult<DeliveryInsightsResponse> {
  const source = useInsightsDataSource();
  return useQuery({
    queryKey: insightsKeys.section("delivery", period, scope, teamId),
    queryFn: () => source.getDelivery(period, scope, teamId),
    placeholderData: keepPreviousData,
    ...INSIGHTS_QUERY_OPTIONS,
    enabled: isInsightsQueryEnabled(scope, teamId) && enabled,
  });
}

export function useUtilizationInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  teamId?: string,
  enabled = true
): UseQueryResult<UtilizationInsightsResponse> {
  const source = useInsightsDataSource();
  return useQuery({
    queryKey: insightsKeys.section("utilization", period, scope, teamId),
    queryFn: () => source.getUtilization(period, scope, teamId),
    placeholderData: keepPreviousData,
    ...INSIGHTS_QUERY_OPTIONS,
    enabled: isInsightsQueryEnabled(scope, teamId) && enabled,
  });
}

export function useAgentsInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  teamId?: string,
  enabled = true
): UseQueryResult<AgentsInsightsResponse> {
  const source = useInsightsDataSource();
  return useQuery({
    queryKey: insightsKeys.section("agents", period, scope, teamId),
    queryFn: () => source.getAgents(period, scope, teamId),
    placeholderData: keepPreviousData,
    ...INSIGHTS_QUERY_OPTIONS,
    enabled: isInsightsQueryEnabled(scope, teamId) && enabled,
  });
}

function isInsightsQueryEnabled(
  scope: InsightsScope,
  teamId: string | undefined
): boolean {
  return scope !== InsightsScopeValues.Team || Boolean(teamId);
}
