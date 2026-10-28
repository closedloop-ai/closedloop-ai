"use client";

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  InsightsScope as InsightsScopeValues,
  InsightsSection as InsightsSectionValues,
} from "@repo/api/src/types/insights";
import {
  keepPreviousData,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
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
  // `InsightsSection`, not `string`. A scoped invalidation is only as good as
  // the key it rebuilds: a token that differs from the one the query registered
  // under matches nothing, and `invalidateQueries` reports no error for a
  // prefix that hit zero queries — the retry would simply do nothing, visibly
  // spin, and come back to the same failed row. Typing the token is what makes
  // the rebuilt key provably the registered one (ISS-10486 review).
  section: (
    section: InsightsSection,
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
    queryKey: insightsKeys.section(
      InsightsSectionValues.Delivery,
      period,
      scope,
      teamId
    ),
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
    queryKey: insightsKeys.section(
      InsightsSectionValues.Utilization,
      period,
      scope,
      teamId
    ),
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
    queryKey: insightsKeys.section(
      InsightsSectionValues.Agents,
      period,
      scope,
      teamId
    ),
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

/**
 * Recovery for the sections one degraded element reads from, and nothing else.
 *
 * ISS-10486 / ISS-10408 (shared). Both dashboard shells used to recover by
 * invalidating {@link insightsKeys.all}, which was correct while ANY failed
 * section replaced the entire page: there was one error card, so "retry
 * everything" and "retry the thing that failed" were the same press. Once the
 * failure is degraded to its own row that stops being true, and a global
 * invalidation is actively wrong in two directions:
 *
 *   - It REFETCHES THE HEALTHY SECTIONS. The reader pressed Retry on Agents and
 *     the two sections already showing them data are thrown away and re-read. If
 *     one of those re-reads fails, the press has turned a dashboard with two
 *     good sections into one with none — a recovery control that can make the
 *     page worse is not a recovery control.
 *   - It MARKS EVERY DEGRADED ROW AS RETRYING, because the busy flag is read off
 *     the same three queries. Pressing one row's button disables the others and
 *     reports work on rows nobody asked to recover.
 *
 * So the caller passes the sections its element actually reads — the same
 * `ROW_SECTIONS` list that decided the element was degraded in the first place —
 * and exactly those keys are invalidated. Returned as a stable callback taking
 * the section list, rather than a hook bound to one list, so a shell can serve
 * every row from one call.
 */
export function useInsightsSectionRetry(
  period: InsightsPeriod,
  scope: InsightsScope,
  teamId?: string
): (sections: readonly InsightsSection[]) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (sections: readonly InsightsSection[]) => {
      for (const section of sections) {
        // Not awaited: a failed refetch surfaces through the section query's own
        // error state, which is what the degraded element already renders from.
        queryClient
          .invalidateQueries({
            queryKey: insightsKeys.section(section, period, scope, teamId),
          })
          .catch(() => undefined);
      }
    },
    [queryClient, period, scope, teamId]
  );
}
