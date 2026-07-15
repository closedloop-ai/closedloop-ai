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
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import {
  type InsightsGitHubProvenance,
  InsightsGitHubProvenanceState,
  type InsightsTileAvailabilityMap,
} from "@repo/api/src/types/insights";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
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
  InsightsTileSourceKind,
  resolveInsightsTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";

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
  const auth = useDesktopAuth();
  const queryClient = useQueryClient();
  const [githubConnectionState, setGithubConnectionState] =
    useState<InsightsGitHubConnectionState>(
      InsightsGitHubConnectionState.Unknown
    );
  const [orgInsightsAvailable, setOrgInsightsAvailable] = useState(false);
  const nextGitHubRefreshSequenceRef = useRef(0);
  const lastAppliedGitHubRefreshSequenceRef = useRef(0);
  const lastAppliedGitHubConnectionStateRef =
    useRef<InsightsGitHubConnectionState | null>(null);
  const refreshGitHubConnectionState = useCallback(async () => {
    nextGitHubRefreshSequenceRef.current += 1;
    const sequence = nextGitHubRefreshSequenceRef.current;
    const status = await readDesktopGitHubIntegrationStatus();
    if (status === null) {
      return;
    }
    if (sequence < lastAppliedGitHubRefreshSequenceRef.current) {
      return;
    }
    lastAppliedGitHubRefreshSequenceRef.current = sequence;
    const nextConnectionState = resolveDesktopGitHubConnectionState(status);
    const previousConnectionState = lastAppliedGitHubConnectionStateRef.current;
    lastAppliedGitHubConnectionStateRef.current = nextConnectionState;
    setGithubConnectionState(nextConnectionState);
    if (
      previousConnectionState &&
      previousConnectionState !== nextConnectionState
    ) {
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
      queryClient.invalidateQueries({ queryKey: insightsKeys.all });
    }
  }, [queryClient]);
  const handleConnectGitHub = useCallback(async () => {
    try {
      if (auth.state.status !== "authenticated") {
        const signIn = await auth.beginSignIn();
        if (!signIn.ok) {
          return;
        }
      }
      const status = await readDesktopGitHubIntegrationStatus();
      const result = await window.desktopApi.openGitHubConnect({
        ...(resolveGitHubConnectMode(status) === GitHubConnectMode.Install
          ? { install: true }
          : {}),
        returnTo: "/insights",
      });
      if (!result.ok) {
        return;
      }
    } catch {
      // A rejected sign-in / connect IPC call must not leak as an unhandled
      // promise rejection: leave the current connection state — and its
      // "Connect GitHub" CTA — in place so the user can retry, rather than
      // failing silently mid-flow. Mirrors the branch views' shared connect
      // handler (useDesktopGitHubConnect, FEA-2782).
      return;
    }
    refreshGitHubConnectionState().catch(() => undefined);
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: insightsKeys.all });
  }, [auth, queryClient, refreshGitHubConnectionState]);

  useEffect(() => {
    let cancelled = false;
    async function loadOrgInsightsCapability() {
      const [apiKeyStatus, runtimeStatus] = await Promise.all([
        readDesktopApiKeyStatus(),
        readDesktopRuntimeStatus(),
      ]);
      if (cancelled) {
        return;
      }
      setOrgInsightsAvailable(
        hasApiKey(apiKeyStatus) && gatewayHealthy(runtimeStatus)
      );
    }
    loadOrgInsightsCapability().catch(() => undefined);
    refreshGitHubConnectionState().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshGitHubConnectionState]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (isDocumentHidden()) {
        return;
      }
      refreshGitHubConnectionState().catch(() => undefined);
    };
    globalThis.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      globalThis.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refreshGitHubConnectionState]);

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
      onConnectGitHub: handleConnectGitHub,
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
          connectionState: resolveTileGitHubConnectionState({
            githubConnectionState,
            payloadAvailability,
            payloadGitHubProvenance,
            scope,
          }),
          payloadAvailability,
          sourceKind:
            scope === InsightsScope.Me
              ? InsightsTileSourceKind.Local
              : InsightsTileSourceKind.Cloud,
        }),
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
    [githubConnectionState, handleConnectGitHub, orgInsightsAvailable]
  );

  return (
    <InsightsDataSourceProvider value={source}>
      {children}
    </InsightsDataSourceProvider>
  );
}

const apiKeyStatusSchema = z.object({ hasApiKey: z.boolean().optional() });
const runtimeStatusSchema = z.object({
  gatewayHealthy: z.boolean().optional(),
});

function hasApiKey(value: unknown): boolean {
  return apiKeyStatusSchema.safeParse(value).data?.hasApiKey === true;
}

function gatewayHealthy(value: unknown): boolean {
  return runtimeStatusSchema.safeParse(value).data?.gatewayHealthy === true;
}

function isDocumentHidden(): boolean {
  return document.hidden === true;
}

async function readDesktopApiKeyStatus(): Promise<unknown> {
  try {
    return await window.desktopApi.getApiKeyStatus();
  } catch {
    return null;
  }
}

async function readDesktopRuntimeStatus(): Promise<unknown> {
  try {
    return await window.desktopApi.getRuntimeStatus();
  } catch {
    return null;
  }
}

function readDesktopGitHubIntegrationStatus(): Promise<GitHubIntegrationStatus | null> {
  return readOptionalDesktopGitHubIntegrationStatus().catch(() => null);
}

async function readOptionalDesktopGitHubIntegrationStatus(): Promise<GitHubIntegrationStatus | null> {
  return await (window.desktopApi.getGitHubIntegrationStatus?.() ??
    Promise.resolve(null));
}

function resolveDesktopGitHubConnectionState(
  status: GitHubIntegrationStatus
): InsightsGitHubConnectionState {
  if (resolveGitHubDataConnected(status) === true) {
    return InsightsGitHubConnectionState.Connected;
  }
  return InsightsGitHubConnectionState.Disconnected;
}

function resolveTileGitHubConnectionState({
  githubConnectionState,
  payloadAvailability,
  payloadGitHubProvenance,
  scope,
}: {
  githubConnectionState: InsightsGitHubConnectionState;
  payloadAvailability: InsightsTileAvailabilityMap | undefined;
  payloadGitHubProvenance: InsightsGitHubProvenance | undefined;
  scope: InsightsScope;
}): InsightsGitHubConnectionState {
  if (scope !== InsightsScope.Org) {
    return githubConnectionState;
  }
  if (githubConnectionState === InsightsGitHubConnectionState.Disconnected) {
    return InsightsGitHubConnectionState.Disconnected;
  }
  if (
    payloadAvailability &&
    payloadGitHubProvenance?.state === InsightsGitHubProvenanceState.Active
  ) {
    return InsightsGitHubConnectionState.Connected;
  }
  return InsightsGitHubConnectionState.Disconnected;
}
