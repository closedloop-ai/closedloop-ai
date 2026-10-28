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
import { resolveGitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
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
  InsightsTileSourceKind,
  resolveInsightsGitHubConnectionState,
  resolveInsightsTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
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
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  isDesktopAuthSettled,
  isDesktopAuthSignedOut,
} from "../../shared-agent-sessions/desktop-auth-signed-out";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { readDesktopGitHubIntegrationStatus } from "../../shared-branches/desktop-github-integration-status";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../branches/use-desktop-github-connect";
import { overlayLocalActivityHeatmap } from "./overlay-local-activity-heatmap";
import { overlayLocalAutonomyTrend } from "./overlay-local-autonomy-trend";

/**
 * ISS-10585: Device-scoped twin of the web provider: same shared tile, local reads
 * (operator ruling, 2026-09-18).
 */
export const DASHBOARD_KPI_TILE_COUNT_SITE =
  SESSION_COUNT_SITE.DashboardKpiTileThisDevice;

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
  const cloudSessionMeshRead = useMemo(
    () => createHttpSessionMeshInsightsRead(apiClient),
    [apiClient]
  );
  // ISS-5958: the connection STATE answers "gate this tile?"; the status behind
  // it is what says whether the user's own grant is the thing that broke, which
  // is the difference between a Connect and a Reconnect CTA. Both come off THIS
  // read. Letting the connect hook fetch its own status instead put a tile's
  // gating and its wording on two sources that disagree whenever the second one
  // is unresolved -- routine in Local/offline mode, where it is enabled purely
  // on the session and may never land.
  const [githubStatus, setGithubStatus] =
    useState<GitHubIntegrationStatus | null>(null);
  const { state: authState } = useDesktopAuth();
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
    // ISS-5958: a payload carrying neither connection field leaves the state
    // UNKNOWN. Calling it Disconnected asserted a fact the payload never
    // carried, and gated org tiles the cloud payload proves are populated.
    setGithubStatus(status);
    const nextConnectionState = resolveInsightsGitHubConnectionState(status);
    const previousConnectionState = lastAppliedGitHubConnectionStateRef.current;
    lastAppliedGitHubConnectionStateRef.current = nextConnectionState;
    if (
      previousConnectionState &&
      previousConnectionState !== nextConnectionState
    ) {
      // Not awaited: this runs inside a status callback, and a failed refetch
      // surfaces through the invalidated queries' own error state.
      queryClient
        .invalidateQueries({ queryKey: githubKeys.all })
        .catch(() => undefined);
      queryClient
        .invalidateQueries({ queryKey: insightsKeys.all })
        .catch(() => undefined);
    }
  }, [queryClient]);
  // FEA-3280: reuse the SAME known-working connect flow as the branch views
  // instead of an inline copy that swallowed every failure and returned
  // silently (a runtime dead click), so every outcome drives a visible
  // `connectState` banner (Pending → Opened / SignInRequired / Failed) rather
  // than doing nothing. ISS-5958 D3 follow-on removed the install-mode
  // pre-flight this used to run: the CTA is always a personal authorize.
  const connectInvalidateKeys = useMemo(() => [insightsKeys.all], []);
  // ISS-7866 review: the TRANSIENT-aware predicate, not a strict
  // `=== "authenticated"`. `resolveGitHubGateConnected` turns a `false` here
  // into a hard "not connected", so the strict form asserted a definite GitHub
  // disconnect for the whole sign-in handoff — gating the dashboard's tiles and
  // prompting a user who was in the middle of connecting. Sessions already
  // reads this same helper; sharing it is what keeps the two from disagreeing.
  const authenticated = !isDesktopAuthSignedOut(authState.status);
  const githubConnectAction = resolveGitHubConnectAction({
    authenticated,
    status: githubStatus,
  });
  // ISS-7866: no session means no GitHub data connection. That is a fact we
  // hold, not a state we failed to read, and saying so here is what lets the
  // gate stop treating UNKNOWN as grounds to prompt. Signed out the status
  // fetch returns null and never resolves, so this value would otherwise sit at
  // Unknown for the whole session — the dashboard's ask used to depend on that
  // accident, while the Sessions strip refused to ask on anything but a
  // definite absence. Both now ask on the same evidence.
  const effectiveGitHubConnectionState = resolveInsightsGitHubConnectionState(
    githubStatus,
    authenticated,
    isDesktopAuthSettled(authState.status)
  );
  const { connectState, connectGitHub, connectTarget } =
    useDesktopGitHubConnect({
      connectAction: githubConnectAction,
      invalidateQueryKeys: connectInvalidateKeys,
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
      githubConnect: {
        // ISS-5958 D1: signed out, this CTA starts account creation, so it must
        // say so. The action is resolved from the same status that gated the
        // tile; the handler is this surface's own wrapper, which re-reads gating
        // after the handoff so the KPI cards flip once the connection lands.
        action: connectTarget.action,
        onConnect: handleConnectGitHub,
      },
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
            githubConnectionState: effectiveGitHubConnectionState,
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
      ...(isCloud ? cloudSessionMeshRead : {}),
    }),
    [
      connectTarget.action,
      effectiveGitHubConnectionState,
      handleConnectGitHub,
      isCloud,
      cloudReads,
      cloudSessionMeshRead,
    ]
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
 * cloud value. The local read is best-effort: any failure — or a wait past
 * {@link LOCAL_OVERLAY_READ_TIMEOUT_MS} — passes `undefined`, so `overlayFn`
 * returns the cloud response untouched. Personal scope only — the overlaid slice
 * is this Mac's own local activity; an `org` read has no local equivalent to
 * overlay.
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

/**
 * ISS-10413 — how long the best-effort local overlay read may hold the cloud
 * response it is overlaid onto.
 *
 * `Promise.all` waits for a SLOW read as patiently as a fast one, and slow is
 * the ordinary case here: this aggregate runs against the same store the import
 * writer is filling, so during a first-launch import the local read can outlast
 * the range change that triggered it by minutes. The section's query then never
 * settles, and because `keepPreviousData` reports an unsettled new key as
 * `success`, the tiles keep rendering the PREVIOUS period's numbers under the
 * new period's label with nothing on screen saying so.
 *
 * 4000 ms is ISS-5110's bound on a desktop IPC read, taken for the same reason
 * stated there: the local round trip carries no cancellation of its own, so the
 * renderer bounds the wait. Past it a later answer is superseded anyway — the
 * cloud response is already in hand and is authoritative for every slice but
 * this one.
 */
const LOCAL_OVERLAY_READ_TIMEOUT_MS = 4000;

async function readLocalSection<TResponse>(
  section: InsightsSection,
  period: InsightsPeriod,
  scope: InsightsScope
): Promise<TResponse | undefined> {
  // `.catch` on the read itself, not around the race: once the deadline wins,
  // nothing is awaiting this promise any more, and a rejection arriving later
  // would surface as an unhandled rejection rather than the `undefined` this
  // function's contract promises.
  const read = (
    window.desktopApi.db.getInsights(
      section,
      period,
      scope
    ) as Promise<TResponse>
  ).catch(() => undefined);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        deadline = setTimeout(
          () => resolve(undefined),
          LOCAL_OVERLAY_READ_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function isDocumentHidden(): boolean {
  return document.hidden === true;
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
