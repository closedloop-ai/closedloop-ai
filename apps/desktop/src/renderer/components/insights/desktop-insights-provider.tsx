import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsScope,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { type ReactNode, useEffect, useMemo, useState } from "react";

/**
 * Desktop insights wiring, shared by the Insights view and the Branches
 * summary cards: serves the `@repo/app` insights hooks from the local
 * in-process (SQLite) database over IPC. Org scope is offered only when an API
 * key is configured and the gateway is healthy; otherwise desktop is
 * personal-scope (`Me`) only.
 *
 * Deliberately does NOT create its own QueryClient: it inherits the app-core
 * client (DesktopAppCoreProvider) so insights and agent-session reads share one
 * cache and the live-DB invalidation bridge reaches dashboard queries too. The
 * insights hooks set their own per-query options (staleTime/refetch).
 */
export function DesktopInsightsProvider({ children }: { children: ReactNode }) {
  const [orgInsightsAvailable, setOrgInsightsAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadConnectionState() {
      const [apiKeyStatus, runtimeStatus] = await Promise.all([
        window.desktopApi.getApiKeyStatus(),
        window.desktopApi.getRuntimeStatus(),
      ]);
      if (cancelled) {
        return;
      }
      setOrgInsightsAvailable(
        hasApiKey(apiKeyStatus) && gatewayHealthy(runtimeStatus)
      );
    }
    loadConnectionState().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const source = useMemo<InsightsDataSource>(
    () => ({
      availableScopes: orgInsightsAvailable
        ? [InsightsScope.Me, InsightsScope.Org]
        : [InsightsScope.Me],
      availableSections: [
        InsightsSection.Delivery,
        InsightsSection.Utilization,
        InsightsSection.Agents,
      ],
      getDelivery: (period, scope) =>
        window.desktopApi.db.getInsights(
          InsightsSection.Delivery,
          period,
          scope
        ) as Promise<DeliveryInsightsResponse>,
      getUtilization: (period, scope) =>
        window.desktopApi.db.getInsights(
          InsightsSection.Utilization,
          period,
          scope
        ) as Promise<UtilizationInsightsResponse>,
      getAgents: (period: InsightsPeriod, scope) =>
        window.desktopApi.db.getInsights(
          InsightsSection.Agents,
          period,
          scope
        ) as Promise<AgentsInsightsResponse>,
    }),
    [orgInsightsAvailable]
  );

  return (
    <InsightsDataSourceProvider value={source}>
      {children}
    </InsightsDataSourceProvider>
  );
}

function hasApiKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { hasApiKey?: unknown }).hasApiKey === true
  );
}

function gatewayHealthy(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { gatewayHealthy?: unknown }).gatewayHealthy === true
  );
}
