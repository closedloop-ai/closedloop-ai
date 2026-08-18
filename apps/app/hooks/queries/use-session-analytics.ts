"use client";

import type {
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import type {
  LostWorkInsightsResponse,
  TokenOpsWasteInsightsResponse,
} from "@repo/api/src/types/session-analytics";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/**
 * Reads for the two session-analytics screens (ISS-4987 lost work, ISS-4988
 * TokenOps waste).
 *
 * Both go through `apps/api` — `apps/app` never touches the database — and both
 * hit routes that share one window, one scope predicate, and one classifier, so
 * the two screens describe the same population.
 *
 * `retry: false` on purpose. Each response already carries its own
 * `unavailableWidgets`, so a partial result is a SETTLED state the screen
 * renders as a dash with a reason. Retrying behind the user's back would keep a
 * skeleton up over data the server already told us it could not produce.
 */

const SESSION_ANALYTICS_STALE_TIME_MS = 60_000;

export const sessionAnalyticsKeys = {
  all: ["session-analytics"] as const,
  lostWork: (period: InsightsPeriod, scope: InsightsScope) =>
    [...sessionAnalyticsKeys.all, "lost-work", period, scope] as const,
  tokenOpsWaste: (period: InsightsPeriod, scope: InsightsScope) =>
    [...sessionAnalyticsKeys.all, "tokenops-waste", period, scope] as const,
};

function analyticsPath(
  section: string,
  period: InsightsPeriod,
  scope: InsightsScope
): string {
  const params = new URLSearchParams({ period, scope });
  const timeZone = resolveTimeZone();
  if (timeZone) {
    params.set("timeZone", timeZone);
  }
  return `/insights/${section}?${params.toString()}`;
}

/**
 * The viewer's IANA zone, so the daily buckets are labelled on the calendar
 * days they actually happened on. Resolved defensively: a browser that cannot
 * report one falls back to the server's UTC bucketing rather than failing.
 */
function resolveTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function useLostWorkInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  enabled = true
): UseQueryResult<LostWorkInsightsResponse> {
  const api = useApiClient();
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<LostWorkInsightsResponse>(
        analyticsPath("lost-work", period, scope)
      ),
    queryKey: sessionAnalyticsKeys.lostWork(period, scope),
    retry: false,
    staleTime: SESSION_ANALYTICS_STALE_TIME_MS,
  });
}

export function useTokenOpsWasteInsights(
  period: InsightsPeriod,
  scope: InsightsScope,
  enabled = true
): UseQueryResult<TokenOpsWasteInsightsResponse> {
  const api = useApiClient();
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<TokenOpsWasteInsightsResponse>(
        analyticsPath("tokenops-waste", period, scope)
      ),
    queryKey: sessionAnalyticsKeys.tokenOpsWaste(period, scope),
    retry: false,
    staleTime: SESSION_ANALYTICS_STALE_TIME_MS,
  });
}
