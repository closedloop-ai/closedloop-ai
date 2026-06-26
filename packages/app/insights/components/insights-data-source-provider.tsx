"use client";

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsScope,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  INSIGHTS_SECTION_OPTIONS,
  InsightsScope as InsightsScopeValues,
} from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { type ReactNode, useMemo } from "react";

/**
 * Web shell adapter for the Insights data port: serves the shared page from the
 * cloud database via the authenticated `apps/api` `/insights/*` routes. Exposes
 * both `me` and `org` aggregation scopes. The desktop shell mounts its own
 * adapter against its local database.
 */
export function WebInsightsDataSourceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const apiClient = useApiClient();
  const source = useMemo<InsightsDataSource>(
    () => ({
      availableScopes: [InsightsScopeValues.Me, InsightsScopeValues.Org],
      availableSections: INSIGHTS_SECTION_OPTIONS,
      getDelivery: (period, scope) =>
        apiClient.get<DeliveryInsightsResponse>(
          insightsPath("delivery", period, scope)
        ),
      getUtilization: (period, scope) =>
        apiClient.get<UtilizationInsightsResponse>(
          insightsPath("utilization", period, scope)
        ),
      getAgents: (period, scope) =>
        apiClient.get<AgentsInsightsResponse>(
          insightsPath("agents", period, scope)
        ),
    }),
    [apiClient]
  );

  return (
    <InsightsDataSourceProvider value={source}>
      {children}
    </InsightsDataSourceProvider>
  );
}

function insightsPath(
  section: string,
  period: InsightsPeriod,
  scope: InsightsScope
): string {
  const params = new URLSearchParams({ period, scope });
  return `/insights/${section}?${params.toString()}`;
}
