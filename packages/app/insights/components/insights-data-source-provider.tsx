"use client";

import { resolveGitHubDataConnected } from "@repo/api/src/types/github-data-connected";
import type { InsightsGitHubProvenance } from "@repo/api/src/types/insights";
import {
  INSIGHTS_SECTION_OPTIONS,
  InsightsGitHubProvenanceState,
  InsightsScope as InsightsScopeValues,
} from "@repo/api/src/types/insights";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import {
  GitHubConnectAction,
  resolveGitHubConnectAction,
} from "@repo/app/github/lib/github-connect-action";
import {
  createHttpInsightsReads,
  createHttpSessionMeshInsightsRead,
} from "@repo/app/insights/data/http-insights-data-source";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { insightsKeys } from "@repo/app/insights/hooks/use-insights";
import {
  InsightsGitHubConnectionState,
  resolveInsightsGitHubConnectionState,
  resolveInsightsTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
import { useTeams } from "@repo/app/teams/hooks/use-teams";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef } from "react";

/**
 * ISS-10585: The data source is what makes the dashboard's Sessions tile org-scoped; the
 * shared tile renders whatever it is handed (operator ruling, 2026-09-18).
 */
export const DASHBOARD_KPI_TILE_COUNT_SITE =
  SESSION_COUNT_SITE.DashboardKpiTileOrg;

/**
 * Web shell adapter for the Insights data port: serves the shared page from the
 * cloud database via the authenticated `apps/api` `/insights/*` routes. Exposes
 * both `me` and `org` aggregation scopes. The desktop shell mounts its own
 * adapter against its local database.
 */
export function WebInsightsDataSourceProvider({
  children,
  githubAuthorizeHref,
  githubConnectHref,
  teamScopes = false,
}: {
  children: ReactNode;
  githubAuthorizeHref?: string;
  githubConnectHref?: string;
  /**
   * Read the org's Teams so the `team` aggregation scope can be advertised.
   *
   * ISS-7514: `GET /teams` answers exactly one question — is there a team to
   * switch to — and only the Insights page renders the scope selector that asks
   * it. The org dashboard mounts this same provider and reads neither
   * `availableScopes` nor `availableTeams`, so leaving this off keeps that
   * request out of its first paint entirely rather than merely later.
   *
   * Off ALSO means `availableTeams` stays `undefined` rather than `[]`: a
   * consumer must be able to tell "nobody asked" from "this org has no teams".
   */
  teamScopes?: boolean;
}) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const teamsQuery = useTeams({ enabled: teamScopes });
  const githubStatusQuery = useGitHubIntegrationStatus();
  // Undefined until the read resolves — including forever when it was never
  // enabled. Kept distinct from `[]` all the way to `availableTeams`.
  const teams = teamsQuery.data;
  const githubConnectionState = resolveInsightsGitHubConnectionState(
    githubStatusQuery.data
  );
  const githubDataConnected = resolveGitHubDataConnected(
    githubStatusQuery.data
  );
  // ISS-5958 D3 follow-on: a connect CTA always means "authorize my own GitHub
  // account". Installing the App across an org stays an admin action reached
  // from Settings, so no status shape can route this href into the install flow
  // any more.
  const resolvedGitHubConnectHref = githubAuthorizeHref ?? githubConnectHref;
  // ISS-5958 D1: this provider only mounts under the web `(authenticated)`
  // route group, so a session always sits behind it and `SignUp` is not
  // reachable here. That comes from WHERE this renders, never from whether a
  // GitHub status happens to be present.
  const githubConnectAction = resolveGitHubConnectAction({
    status: githubStatusQuery.data,
    authenticated: true,
  });
  const lastObservedGitHubConnected = useRef(githubDataConnected);

  useEffect(() => {
    const connected = resolveGitHubDataConnected(githubStatusQuery.data);
    if (connected === undefined) {
      return;
    }
    if (lastObservedGitHubConnected.current === undefined) {
      lastObservedGitHubConnected.current = connected;
      return;
    }
    if (lastObservedGitHubConnected.current === connected) {
      return;
    }
    lastObservedGitHubConnected.current = connected;
    queryClient.invalidateQueries({ queryKey: insightsKeys.all });
  }, [githubStatusQuery.data, queryClient]);

  const reads = useMemo(() => createHttpInsightsReads(apiClient), [apiClient]);
  const sessionMeshRead = useMemo(
    () => createHttpSessionMeshInsightsRead(apiClient),
    [apiClient]
  );
  const source = useMemo<InsightsDataSource>(
    () => ({
      availableScopes:
        teams && teams.length > 0
          ? [
              InsightsScopeValues.Me,
              InsightsScopeValues.Org,
              InsightsScopeValues.Team,
            ]
          : [InsightsScopeValues.Me, InsightsScopeValues.Org],
      availableSections: INSIGHTS_SECTION_OPTIONS,
      availableTeams: teams?.map((team) => ({ id: team.id, name: team.name })),
      githubConnect: resolvedGitHubConnectHref
        ? {
            // A gated tile only renders while the connection is missing, so an
            // action the resolver reports as `null` (connected, or not known
            // yet) never reaches a CTA; first-time connect is the honest
            // fallback if one ever does.
            action: githubConnectAction ?? GitHubConnectAction.Connect,
            href: resolvedGitHubConnectHref,
          }
        : undefined,
      getTileAvailability: ({
        tileId,
        section,
        scope,
        payloadAvailability,
        payloadGitHubProvenance,
      }) =>
        resolveInsightsTileAvailability({
          tileId,
          section,
          scope,
          connectionState: resolveCloudGitHubConnectionState({
            connectionState: githubConnectionState,
            payloadGitHubProvenance,
          }),
          payloadAvailability,
        }),
      ...reads,
      ...sessionMeshRead,
    }),
    [
      reads,
      sessionMeshRead,
      teams,
      githubConnectAction,
      resolvedGitHubConnectHref,
      githubConnectionState,
    ]
  );

  return (
    <InsightsDataSourceProvider value={source}>
      {children}
    </InsightsDataSourceProvider>
  );
}

function resolveCloudGitHubConnectionState({
  connectionState,
  payloadGitHubProvenance,
}: {
  connectionState: InsightsGitHubConnectionState;
  payloadGitHubProvenance: InsightsGitHubProvenance | undefined;
}): InsightsGitHubConnectionState {
  if (
    connectionState === InsightsGitHubConnectionState.Disconnected ||
    payloadGitHubProvenance?.state ===
      InsightsGitHubProvenanceState.Disconnected
  ) {
    return InsightsGitHubConnectionState.Disconnected;
  }
  if (payloadGitHubProvenance?.state === InsightsGitHubProvenanceState.Active) {
    return InsightsGitHubConnectionState.Connected;
  }
  return InsightsGitHubConnectionState.Unknown;
}
