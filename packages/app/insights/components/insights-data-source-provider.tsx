"use client";

import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type { InsightsGitHubProvenance } from "@repo/api/src/types/insights";
import {
  INSIGHTS_SECTION_OPTIONS,
  InsightsGitHubProvenanceState,
  InsightsScope as InsightsScopeValues,
} from "@repo/api/src/types/insights";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { createHttpInsightsReads } from "@repo/app/insights/data/http-insights-data-source";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { insightsKeys } from "@repo/app/insights/hooks/use-insights";
import {
  GitHubConnectMode,
  resolveGitHubConnectMode,
  resolveGitHubDataConnected,
} from "@repo/app/insights/lib/github-connect-mode";
import {
  InsightsGitHubConnectionState,
  resolveInsightsTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useTeams } from "@repo/app/teams/hooks/use-teams";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef } from "react";

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
  githubInstallHref,
}: {
  children: ReactNode;
  githubAuthorizeHref?: string;
  githubConnectHref?: string;
  githubInstallHref?: string;
}) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const teamsQuery = useTeams();
  const githubStatusQuery = useGitHubIntegrationStatus();
  const teams = teamsQuery.data ?? [];
  const githubConnectionState = resolveGitHubConnectionState(
    githubStatusQuery.data
  );
  const githubDataConnected = resolveGitHubDataConnected(
    githubStatusQuery.data
  );
  const resolvedGitHubConnectHref = resolveGitHubConnectHref({
    authorizeHref: githubAuthorizeHref ?? githubConnectHref,
    installHref: githubInstallHref,
    status: githubStatusQuery.data,
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
  const source = useMemo<InsightsDataSource>(
    () => ({
      availableScopes:
        teams.length > 0
          ? [
              InsightsScopeValues.Me,
              InsightsScopeValues.Org,
              InsightsScopeValues.Team,
            ]
          : [InsightsScopeValues.Me, InsightsScopeValues.Org],
      availableSections: INSIGHTS_SECTION_OPTIONS,
      availableTeams: teams.map((team) => ({ id: team.id, name: team.name })),
      githubConnectHref: resolvedGitHubConnectHref,
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
    }),
    [reads, teams, resolvedGitHubConnectHref, githubConnectionState]
  );

  return (
    <InsightsDataSourceProvider value={source}>
      {children}
    </InsightsDataSourceProvider>
  );
}

function resolveGitHubConnectionState(
  status: GitHubIntegrationStatus | undefined
): InsightsGitHubConnectionState {
  const connected = resolveGitHubDataConnected(status);
  if (connected === true) {
    return InsightsGitHubConnectionState.Connected;
  }
  if (connected === false) {
    return InsightsGitHubConnectionState.Disconnected;
  }
  return InsightsGitHubConnectionState.Unknown;
}

function resolveGitHubConnectHref({
  authorizeHref,
  installHref,
  status,
}: {
  authorizeHref: string | undefined;
  installHref: string | undefined;
  status: GitHubIntegrationStatus | undefined;
}): string | undefined {
  if (resolveGitHubConnectMode(status) === GitHubConnectMode.Install) {
    return installHref ?? authorizeHref;
  }
  return authorizeHref ?? installHref;
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
