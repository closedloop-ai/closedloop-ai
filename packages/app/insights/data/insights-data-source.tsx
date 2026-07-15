"use client";

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsGitHubProvenance,
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
  InsightsTileAvailabilityMap,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { createContext, type ReactNode, useContext } from "react";
import type { InsightsTileAvailability } from "../lib/tile-availability";

/**
 * Surface-agnostic data port for the Insights page. The web shell implements
 * this against the cloud `apps/api` (`/insights/*` routes); the desktop shell
 * implements it against its local database over Electron IPC. The shared
 * components never know which backend answers — they only read this port.
 *
 * `availableScopes` lets a shell advertise which aggregation scopes it
 * supports: web exposes `me`/`org` (and teams when available); desktop always
 * exposes local `me` and may expose cloud-backed `org` when the gateway is
 * configured.
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
  availableTeams?: readonly InsightsTeamOption[];
  getTileAvailability?: (
    input: InsightsTileAvailabilityInput
  ) => InsightsTileAvailability;
  githubConnectHref?: string;
  onConnectGitHub?: () => void | Promise<void>;
  getDelivery: (
    period: InsightsPeriod,
    scope: InsightsScope,
    teamId?: string
  ) => Promise<DeliveryInsightsResponse>;
  getUtilization: (
    period: InsightsPeriod,
    scope: InsightsScope,
    teamId?: string
  ) => Promise<UtilizationInsightsResponse>;
  getAgents: (
    period: InsightsPeriod,
    scope: InsightsScope,
    teamId?: string
  ) => Promise<AgentsInsightsResponse>;
};

export type InsightsTeamOption = {
  id: string;
  name: string;
};

export type InsightsTileAvailabilityInput = {
  tileId: string;
  section: InsightsSection;
  scope: InsightsScope;
  payloadAvailability?: InsightsTileAvailabilityMap;
  payloadGitHubProvenance?: InsightsGitHubProvenance;
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
