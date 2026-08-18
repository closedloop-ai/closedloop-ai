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
  InsightsTileSourceKind,
  resolveInsightsTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../branches/use-desktop-github-connect";
import { overlayLocalActivityHeatmap } from "./overlay-local-activity-heatmap";
import { overlayLocalAutonomyTrend } from "./overlay-local-autonomy-trend";

/**
 * Desktop insights wiring, shared by the Insights view and the Branches
 * summary cards. Source selection follows the single PLN-1138 D-E auth-driven
 * rule (`useDesktopAppCoreMode`): when authenticated and online (Cloud mode)
 * both `me` and `org` insights read the cloud `/insights/*` routes through the
 * shared API client — whose desktop transport is the main-process IPC fetch
 * bridge (D-G) — so the credential stays in main and the read path is
 * byte-identical to web (PRD-461 D3: authenticated own-data reads cloud, not
 * local). Signed out or offline (Local mode) it falls back to the in-process
 * SQLite database over IPC, personal-scope (`Me`) only.
 *
 * Deliberately does NOT create its own QueryClient: it inherits the app-core
 * client (DesktopAppCoreProvider), which is swapped per mode, so insights and
 * agent-session reads share one cache and the live-DB invalidation bridge
 * reaches dashboard queries too. The insights hooks set their own per-query
 * options (staleTime/refetch).
 */
export function DesktopInsightsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const mode = useDesktopAppCoreMode();
  const isCloud = mode === DesktopAppCoreMode.Cloud;
  const cloudReads = useMemo(
    () => createHttpInsightsReads(apiClient),
    [apiClient]
  );
  const [githubConnectionState, setGithubConnectionState] =
    useState<InsightsGitHubConnectionState>(
      InsightsGitHubConnectionState.Unknown
    );
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
  // FEA-3280: reuse the SAME known-working connect flow as the branch views
  // instead of an inline copy that swallowed every failure and returned
  // silently (a runtime dead click). The install-mode pre-flight — a fresh org
  // with no App installation enters the install flow — is folded in as the
  // hook's best-effort `resolveInstall`: it can no longer abort the connect,
  // and every outcome now drives a visible `connectState` banner (Pending →
  // Opened / SignInRequired / Failed) rather than doing nothing.
  const resolveInstallMode = useCallback(async () => {
    const status = await readDesktopGitHubIntegrationStatus();
    return resolveGitHubConnectMode(status) === GitHubConnectMode.Install;
  }, []);
  const connectInvalidateKeys = useMemo(() => [insightsKeys.all], []);
  const { connectState, connectGitHub } = useDesktopGitHubConnect({
    invalidateQueryKeys: connectInvalidateKeys,
    resolveInstall: resolveInstallMode,
    returnTo: "/insights",
  });
  const handleConnectGitHub = useCallback(async () => {
    await connectGitHub();
    // Re-read gating after the connect handoff so the KPI cards flip once the
    // connection lands (the hook already invalidated the github/insights
    // caches on success).
    refreshGitHubConnectionState().catch(() => undefined);
  }, [connectGitHub, refreshGitHubConnectionState]);

  useEffect(() => {
    refreshGitHubConnectionState().catch(() => undefined);
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
      availableScopes: isCloud
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
          // FEA-3721: tile-availability gating flips with the READ SOURCE, which
          // follows the app-core mode (PLN-1138 D-E), not the scope. In Cloud
          // mode BOTH `me` and `org` read the cloud `/insights/*` routes, whose
          // response already carries per-tile `payloadAvailability` for the
          // GitHub-truth tiles (`buildDeliveryTileAvailability` is scope-
          // independent). So Cloud mode must trust that payload for both scopes
          // (`Cloud` sourceKind) — forcing `me` to `Local` here wrongly re-gated
          // populated cloud KPIs (merged/merge-rate/ttm) on the LOCAL GitHub App
          // connection and rendered them 0/blank. `Local` sourceKind — which
          // gates on the desktop's own GitHub data connection because the local
          // SQLite read carries no cloud payload proof — is used ONLY for the
          // signed-out/offline Local read path.
          sourceKind: isCloud
            ? InsightsTileSourceKind.Cloud
            : InsightsTileSourceKind.Local,
        }),
      // PLN-1138 D-E / PRD-461 D3: authenticated + online reads BOTH `me` and
      // `org` from the cloud `/insights/*` routes over the shared client (its
      // desktop transport is the D-G IPC fetch bridge); signed out or offline
      // reads own-data from the local SQLite database over IPC.
      getDelivery: (period, scope, teamId) =>
        isCloud
          ? cloudReads.getDelivery(period, scope, teamId)
          : (window.desktopApi.db.getInsights(
              InsightsSection.Delivery,
              period,
              scope
            ) as Promise<DeliveryInsightsResponse>),
      // FEA-3684: the cloud `/insights/utilization` route now computes the Event
      // Activity heatmap (`activityHeatmap`) itself, so Cloud mode reads it from
      // the cloud response and cloud is authoritative when the slice is present.
      // But the slice can still be absent/empty in Cloud mode — a deploy-window
      // request that hits an OLDER/rolled-back route, or a legacy synced session
      // with no `metadata.messages` — which would render the card empty even
      // though the local `session_turn_bucket` table still holds the buckets. So
      // we keep the same best-effort local overlay used for the Autonomy Trend:
      // it splices in the local heatmap ONLY when the cloud slice is genuinely
      // missing/empty and otherwise preserves the cloud value untouched. Local
      // mode still computes the heatmap directly from the in-process DB (below).
      getUtilization: (period, scope, teamId) =>
        isCloud
          ? readCloudSectionWithLocalOverlay(
              InsightsSection.Utilization,
              cloudReads.getUtilization(period, scope, teamId),
              period,
              scope,
              overlayLocalActivityHeatmap
            )
          : (window.desktopApi.db.getInsights(
              InsightsSection.Utilization,
              period,
              scope
            ) as Promise<UtilizationInsightsResponse>),
      getAgents: (period: InsightsPeriod, scope, teamId) =>
        isCloud
          ? readCloudSectionWithLocalOverlay(
              InsightsSection.Agents,
              cloudReads.getAgents(period, scope, teamId),
              period,
              scope,
              overlayLocalAutonomyTrend
            )
          : (window.desktopApi.db.getInsights(
              InsightsSection.Agents,
              period,
              scope
            ) as Promise<AgentsInsightsResponse>),
    }),
    [githubConnectionState, handleConnectGitHub, isCloud, cloudReads]
  );

  return (
    <InsightsDataSourceProvider value={source}>
      {/* FEA-3280: surface the connect handoff outcome so a click is never a
          silent dead action. Renders nothing until the user connects (Idle /
          Pending → null), then shows the shared branch-view banner for the
          Opened / SignInRequired / Failed terminal states — with a Failed state
          the user can retry from, exactly like the branch views. */}
      {connectState === DesktopGitHubConnectState.Idle ? null : (
        <div className="px-4 pt-3">
          <DesktopConnectStatus state={connectState} variant="list" />
        </div>
      )}
      {children}
    </InsightsDataSourceProvider>
  );
}

/**
 * Cloud-mode read for one insights section, with a desktop-only chart slice
 * overlaid from the local database.
 *
 * Two slices use this helper. The Autonomy Trend on Agents (FEA-3454) is a
 * desktop-only analytic the cloud `/insights/agents` route never computes, so in
 * Cloud mode that chart row would render empty even though the local DB holds the
 * buckets. The Event Activity heatmap on Utilization is now cloud-computed
 * (FEA-3684) and cloud is authoritative when present, but the slice can still be
 * absent/empty in Cloud mode during a deploy window (an older/rolled-back route)
 * or for legacy synced rows — so it keeps a graceful fallback to the same local
 * buckets rather than rendering empty.
 *
 * We read the cloud response (authoritative for every other slice, PRD-461 D3)
 * and hand both it and a best-effort local read to `overlayFn`, which splices the
 * local slice in only when the cloud's is absent/empty and preserves a populated
 * cloud value. The local read is best-effort: any failure passes `undefined`, so
 * `overlayFn` returns the cloud response untouched. Personal scope only — the
 * overlaid slice is this Mac's own local activity; an `org` read has no local
 * equivalent to overlay.
 */
async function readCloudSectionWithLocalOverlay<
  TResponse extends AgentsInsightsResponse | UtilizationInsightsResponse,
>(
  section: InsightsSection,
  cloudPromise: Promise<TResponse>,
  period: InsightsPeriod,
  scope: InsightsScope,
  overlayFn: (cloud: TResponse, local: TResponse | undefined) => TResponse
): Promise<TResponse> {
  if (scope !== InsightsScope.Me) {
    return await cloudPromise;
  }
  const [cloud, local] = await Promise.all([
    cloudPromise,
    readLocalSection<TResponse>(section, period, scope),
  ]);
  return overlayFn(cloud, local);
}

async function readLocalSection<TResponse>(
  section: InsightsSection,
  period: InsightsPeriod,
  scope: InsightsScope
): Promise<TResponse | undefined> {
  try {
    return (await window.desktopApi.db.getInsights(
      section,
      period,
      scope
    )) as TResponse;
  } catch {
    return undefined;
  }
}

function isDocumentHidden(): boolean {
  return document.hidden === true;
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
    // `me`-scope Cloud tiles trust the cloud payload directly (see
    // resolveInsightsTileAvailability's Cloud+Me fast-path), so this local
    // connection state only gates the signed-out/offline Local read path.
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
