import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsScope,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import type { InsightsDataSource } from "./insights-data-source";

/**
 * The cloud read half of the Insights data port — the three section getters that
 * speak the authenticated `apps/api` `/insights/*` routes. Extracted from the web
 * shell so BOTH surfaces build the exact same REST reads: the web shell composes
 * them with its href-based GitHub connect + team scopes, and authenticated
 * desktop composes them with its native GitHub connect and local fallback. There
 * is one place that builds the insights URLs, so the two surfaces cannot drift.
 */
export type InsightsReads = Pick<
  InsightsDataSource,
  "getDelivery" | "getUtilization" | "getAgents"
>;

/** The slice of the API client the HTTP insights reads need. */
type InsightsHttpClient = {
  get<T>(path: string): Promise<T>;
};

/**
 * Build the cloud `/insights/*` reads over a shared API client. On the web shell
 * the client is a browser `fetch` wrapper; on authenticated desktop it is the
 * same shared client whose transport rides the main-process IPC fetch bridge
 * (PLN-1138 D-G) — so the credential stays in main and the read path is
 * byte-identical to web.
 */
export function createHttpInsightsReads(
  api: InsightsHttpClient
): InsightsReads {
  return {
    getDelivery: (period, scope, teamId) =>
      api.get<DeliveryInsightsResponse>(
        insightsPath("delivery", period, scope, teamId)
      ),
    getUtilization: (period, scope, teamId) =>
      api.get<UtilizationInsightsResponse>(
        insightsPath("utilization", period, scope, teamId)
      ),
    getAgents: (period, scope, teamId) =>
      api.get<AgentsInsightsResponse>(
        insightsPath("agents", period, scope, teamId)
      ),
  };
}

export function insightsPath(
  section: string,
  period: InsightsPeriod,
  scope: InsightsScope,
  teamId?: string
): string {
  const params = new URLSearchParams({ period, scope });
  if (teamId) {
    params.set("teamId", teamId);
  }
  // FEA-2745: send the browser's IANA timezone so the cloud backend labels the
  // daily trend / by-day bars in the viewer's local calendar — matching the
  // desktop shell, which buckets in local time. Absent/unresolved → the server
  // falls back to UTC bucketing.
  const timeZone = resolveBrowserTimeZone();
  if (timeZone) {
    params.set("timeZone", timeZone);
  }
  return `/insights/${section}?${params.toString()}`;
}

function resolveBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
