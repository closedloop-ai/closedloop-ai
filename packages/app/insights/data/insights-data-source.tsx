"use client";

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { createContext, type ReactNode, useContext } from "react";

/**
 * Surface-agnostic data port for the Insights page. The web shell implements
 * this against the cloud `apps/api` (`/insights/*` routes); the desktop shell
 * implements it against its local database over Electron IPC. The shared
 * components never know which backend answers — they only read this port.
 *
 * `availableScopes` lets a shell advertise which aggregation scopes it
 * supports: web exposes both `me` and `org`; desktop is personal-only (`me`),
 * so it omits the scope selector entirely.
 *
 * `availableSections` lets a shell advertise which sections it can populate. A
 * shell omits a section it has no data for rather than rendering empty tiles —
 * e.g. desktop hides Delivery until PR/branch data syncs locally. The shared UI
 * shows tabs, the metric picker, and dashboard tiles only for available
 * sections.
 */
export type InsightsDataSource = {
  availableScopes: readonly InsightsScope[];
  availableSections: readonly InsightsSection[];
  getDelivery: (
    period: InsightsPeriod,
    scope: InsightsScope
  ) => Promise<DeliveryInsightsResponse>;
  getUtilization: (
    period: InsightsPeriod,
    scope: InsightsScope
  ) => Promise<UtilizationInsightsResponse>;
  getAgents: (
    period: InsightsPeriod,
    scope: InsightsScope
  ) => Promise<AgentsInsightsResponse>;
};

const InsightsDataSourceContext = createContext<InsightsDataSource | null>(
  null
);

export function InsightsDataSourceProvider({
  value,
  children,
}: {
  value: InsightsDataSource;
  children: ReactNode;
}) {
  return (
    <InsightsDataSourceContext.Provider value={value}>
      {children}
    </InsightsDataSourceContext.Provider>
  );
}

export function useInsightsDataSource(): InsightsDataSource {
  const source = useContext(InsightsDataSourceContext);
  if (!source) {
    throw new Error(
      "useInsightsDataSource must be used within an InsightsDataSourceProvider"
    );
  }
  return source;
}
