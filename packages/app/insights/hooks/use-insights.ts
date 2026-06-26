"use client";

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsScope,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
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
  section: (section: string, period: InsightsPeriod, scope: InsightsScope) =>
    [...insightsKeys.all, section, period, scope] as const,
};

export function useDeliveryInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  enabled = true
): UseQueryResult<DeliveryInsightsResponse> {
  const source = useInsightsDataSource();
  return useQuery({
    queryKey: insightsKeys.section("delivery", period, scope),
    queryFn: () => source.getDelivery(period, scope),
    placeholderData: keepPreviousData,
    ...INSIGHTS_QUERY_OPTIONS,
    enabled,
  });
}

export function useUtilizationInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  enabled = true
): UseQueryResult<UtilizationInsightsResponse> {
  const source = useInsightsDataSource();
  return useQuery({
    queryKey: insightsKeys.section("utilization", period, scope),
    queryFn: () => source.getUtilization(period, scope),
    placeholderData: keepPreviousData,
    ...INSIGHTS_QUERY_OPTIONS,
    enabled,
  });
}

export function useAgentsInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  enabled = true
): UseQueryResult<AgentsInsightsResponse> {
  const source = useInsightsDataSource();
  return useQuery({
    queryKey: insightsKeys.section("agents", period, scope),
    queryFn: () => source.getAgents(period, scope),
    placeholderData: keepPreviousData,
    ...INSIGHTS_QUERY_OPTIONS,
    enabled,
  });
}
