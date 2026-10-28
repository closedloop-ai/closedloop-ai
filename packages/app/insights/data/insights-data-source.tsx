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
import type { SessionMeshInsights } from "@repo/api/src/types/session-mesh";
import { createContext, type ReactNode, useContext } from "react";
import type { GitHubConnectTarget } from "../../github/lib/github-connect-target";
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
  /**
   * What a connect CTA on this surface does, and how the shell performs it
   * (ISS-5958). One value, so a shell that owns a connect action cannot also
   * hand the shared components a navigation href — the FEA-3280 dead click.
   */
  githubConnect?: GitHubConnectTarget;
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
  /** Org-wide coordination facts. Absent means this adapter cannot prove them. */
  getSessionMeshInsights?: (
    scope: "me" | "org",
    period: "7" | "30" | "90" | "all",
    userId?: string
  ) => Promise<SessionMeshInsights>;
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
