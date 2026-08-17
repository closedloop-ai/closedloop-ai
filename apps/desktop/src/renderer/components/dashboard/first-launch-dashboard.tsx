import type { InsightsGitHubProvenance } from "@repo/api/src/types/insights";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { AiImpactCard } from "@repo/app/insights/components/overview/ai-impact-card";
import { useDashboardRefreshing } from "@repo/app/insights/components/overview/dashboard-refreshing";
import { hasAgentPipelineNodes } from "@repo/app/insights/components/overview/dashboard-row-sections";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import { dashboardRowsFor } from "@repo/app/insights/components/overview/dashboard-tiles";
import { useDashboardRowGates } from "@repo/app/insights/components/overview/use-dashboard-row-gates";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { useDashboardRange } from "@repo/app/insights/hooks/use-dashboard-range";
import {
  insightsKeys,
  useAgentsInsights,
  useDeliveryInsights,
  useUtilizationInsights,
} from "@repo/app/insights/hooks/use-insights";
import {
  type InsightsTileAvailability,
  resolveMissingSourceTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { useQueryClient } from "@tanstack/react-query";
import { LayersIcon, RefreshCwIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";
import { DashboardCard, PageShell } from "../layout/page-shell";
import {
  GuestSignupIntent,
  useGuestSignup,
} from "../onboarding/guest-signup-provider";
import {
  canOfferAccount,
  tourCompleteLabel,
  useGuestOnboarding,
} from "../onboarding/use-guest-onboarding";
import { DASHBOARD_PAGE_TITLE } from "./dashboard-constants";
import { DashboardHeaderActions } from "./dashboard-header-actions";
import { DashboardLoading } from "./dashboard-loading";
import {
  resolveDashboardState,
  useBackfillSettleDetection,
  useDashboardSessionSource,
  useSessionsCountFresh,
} from "./dashboard-state";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  readFlag,
  writeFlag,
} from "./dashboard-storage-keys";
import { OrgGatedRegion } from "./org-scope-gate";
import { buildTourSteps } from "./tour/build-tour-steps";
import { Tour } from "./tour/tour";
import { TourHint } from "./tour/tour-hint";
import { useTourArming } from "./tour/use-tour-arming";
import { useTourHarnesses } from "./tour/use-tour-harnesses";
import { useDashboardScope } from "./use-dashboard-scope";
import { useOrgScopeGate } from "./use-org-scope-gate";

const RECENT_SESSIONS_LIMIT = 8;
// FEA-2232: the dashboard window is user-driven via the shared, surface-keyed
// `useDashboardRange` hook (the maps + persistence formerly inlined here for
// FEA-2210 now live in `@repo/app/insights`). The "desktop" surface persists
// independently of the Sessions / Branches tabs and the web dashboard.
const DASHBOARD_RANGE_SURFACE = "desktop";

// localStorage flags gate the one-time first-launch experience.
const REVEAL_DURATION_MS = 3600;
// Poll cadence for the cheap session-count read used to detect when the local
// import has "settled" (the dashboard's loading treatment holds until then).
const BACKFILL_POLL_MS = 2500;

// Per-row reveal thresholds on the 0..100 scan tick.
const REVEAL_AT: Record<string, number> = {
  stats: 2,
  activity: 24,
  sessions: 42,
  models: 58,
  "agent-pipeline": 64,
  autonomy: 70,
  prs: 82,
  distribution: 92,
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/**
 * The desktop first-launch dashboard: a fixed, read-only overview built from
 * the shared Insights tile catalog and fed by the local SQLite-backed data
 * source (via DesktopInsightsProvider). On first launch it plays a one-time
 * "populate" reveal as local sessions are analyzed, then auto-starts a guided
 * tour. Subsequent launches render immediately; the tour stays replayable.
 */
export function FirstLaunchDashboard() {
  const source = useInsightsDataSource();
  // PLN-1138: authenticated + online exposes `org` (DesktopInsightsProvider);
  // signed out / offline is personal-scope only. See useDashboardScope for the
  // clamp that keeps a stale `org` read off the local own-data store.
  const { scope, orgScopeAvailable, setScope } = useDashboardScope(
    source.availableScopes
  );
  const prefersReduced = usePrefersReducedMotion();
  const [firstLaunch] = useState(() => !readFlag(dashboardOnboardedStorageKey));
  const motion = firstLaunch && !prefersReduced;

  // ISS-5112: guest-mode first run (the `guest-onboarding` Labs flag) plus
  // whether this device is already signed in.
  const guest = useGuestOnboarding();
  const guestCanConvert = canOfferAccount(guest);
  const { requestSignup } = useGuestSignup();
  // ISS-5112: selecting Organization as a guest dims the dashboard behind a
  // Create-account card rather than switching to a scope the app cannot serve.
  const { orgGated, handleScopeChange, dismissOrgGate, requestOrgAccount } =
    useOrgScopeGate(guestCanConvert, setScope);

  const [tick, setTick] = useState(motion ? 0 : 100);
  const [tourActive, setTourActive] = useState(false);
  const [tourHint, setTourHint] = useState(false);

  const completedRef = useRef(false);

  // FEA-2210/FEA-2232: user-driven window (desktop-local persisted selection),
  // backed by the shared surface-keyed hook.
  const { dateRange, setDateRange, period, periodLabel, deltaLabel } =
    useDashboardRange(DASHBOARD_RANGE_SURFACE);

  // Backfill settle detection: while the local DB is still importing sessions,
  // the totals keep growing. Poll the cheap session list and treat the data as
  // "appropriately backfilled" once the total stops growing across consecutive
  // polls. The heavy insights queries are NOT polled during import (that would
  // compete with the main-process SQLite writes) — they refetch once on settle.
  const [settled, setSettled] = useState(false);
  const [grew, setGrew] = useState(false);
  const sessionsQuery = useAgentSessions(
    { limit: RECENT_SESSIONS_LIMIT },
    { refetchInterval: settled ? false : BACKFILL_POLL_MS }
  );
  const sessionsTotal = sessionsQuery.data?.total ?? 0;
  // ISS-6002: whether the local store has proven it can serve rows. `?? 0` above
  // means a pending read, a failed read and a read taken before the store opened
  // are all indistinguishable from a real zero, so nothing may treat this total
  // as authoritative until a SUCCESSFUL read has landed on a proven-up source.
  const sessionSource = useDashboardSessionSource();
  const sessionsCountFresh = useSessionsCountFresh({
    sessionSourceReady: sessionSource.ready,
    sessionsDataLoaded: sessionsQuery.data !== undefined,
    dataUpdatedAt: sessionsQuery.dataUpdatedAt,
  });

  useBackfillSettleDetection({
    sessionsTotal,
    isLoading: sessionsQuery.isLoading,
    dataUpdatedAt: sessionsQuery.dataUpdatedAt,
    sessionSourceReady: sessionSource.ready,
    settled,
    setGrew,
    setSettled,
  });

  // With the SQLite/WAL reader pool, the insights aggregations run on reader
  // connections concurrently with the backfill writer (and off the main thread),
  // so there's no longer any reason to defer them until the import settles —
  // load them immediately and let db-change invalidation refresh them as the
  // import grows. (The old `settled || !grew` gate was a SQLite-era mitigation
  // for the single-connection engine blocking the UI during ingest.)
  const insightsEnabled = true;
  const delivery = useDeliveryInsights(
    period,
    scope,
    undefined,
    insightsEnabled
  );
  const utilization = useUtilizationInsights(
    period,
    scope,
    undefined,
    insightsEnabled
  );
  const agents = useAgentsInsights(period, scope, undefined, insightsEnabled);

  // All three insights sections resolved — the data behind every tile and the
  // tour summary (KPIs, model breakdown) is ready. The first-launch tour waits
  // on this so it never opens over blank cards (e.g. a missing "Models in use").
  const analyticsLoaded =
    delivery.isSuccess && utilization.isSuccess && agents.isSuccess;

  // FEA-3240: surface a degraded/error state when any insights query reaches
  // terminal error instead of holding the loading skeleton indefinitely.
  const { analyticsError, retrying, handleRetry } = useInsightsErrorRecovery(
    delivery,
    utilization,
    agents
  );

  const sections = useMemo<InsightsSectionData>(
    () => ({
      [InsightsSection.Delivery]: delivery.data,
      [InsightsSection.Utilization]: utilization.data,
      [InsightsSection.Agents]: agents.data,
    }),
    [agents.data, delivery.data, utilization.data]
  );
  // FEA-4020: a single dashboard-wide "Refreshing" indicator (shown in the
  // header next to the range/scope controls), mirroring the web
  // `InsightsOverviewDashboard`. See `useSectionRefreshing` below.
  const refreshing = useSectionRefreshing(
    `${period}:${scope}`,
    delivery,
    utilization,
    agents
  );
  const sourceGetTileAvailability = source.getTileAvailability;
  const getTileAvailability = useCallback(
    (tile: TileDescriptor) => {
      if (!sourceGetTileAvailability) {
        return resolveMissingSourceTileAvailability({
          tileId: tile.id,
          section: tile.section,
        });
      }
      // `org` tiles gate on the cloud response's availability/provenance
      // (sourceKind Cloud), so pass them through like the web dashboard; `me`
      // tiles gate on the desktop GitHub connection and ignore these.
      const sectionData = sections[tile.section];
      return sourceGetTileAvailability({
        tileId: tile.id,
        section: tile.section,
        scope,
        payloadAvailability: sectionData?.tileAvailability,
        payloadGitHubProvenance: getSectionGitHubProvenance(sectionData),
      });
    },
    [sourceGetTileAvailability, scope, sections]
  );

  const recentItems = sessionsQuery.data?.items ?? [];

  // Drive the populate scan once, on first launch.
  useEffect(() => {
    if (!motion) {
      return;
    }
    const start = Date.now();
    const interval = window.setInterval(() => {
      const next = Math.min(
        100,
        ((Date.now() - start) / REVEAL_DURATION_MS) * 100
      );
      setTick(next);
      if (next >= 100) {
        window.clearInterval(interval);
      }
    }, 40);
    return () => window.clearInterval(interval);
  }, [motion]);

  // ISS-5112: the insights payload has no harness dimension, so the guest tour's
  // "Harnesses found" row reads the local SQLite usage aggregate directly. Gated
  // on the flag so a flag-off launch issues no extra read at all. Declared above
  // `useTourArming` because arming waits on it — this row must be settled before
  // the callout opens, or the intro summary grows underneath the reader.
  const { harnesses, ready: harnessesReady } = useTourHarnesses(guest.enabled);

  useTourArming({
    tick,
    settled,
    analyticsLoaded,
    harnessesReady,
    firstLaunch,
    completedRef,
    setTourActive,
  });

  const isShown = (tour: string) => !motion || tick >= (REVEAL_AT[tour] ?? 0);

  // Loading vs empty vs ready. The first-launch / loading treatment persists
  // until the analytics actually load — never show the bare zero/"Unknown"
  // tiles. `loading`: queries still resolving, OR no rows yet while the local
  // import is still running. `empty`: import settled with genuinely no data.
  // Canonical load state straight from the query statuses — no hardcoded counts
  // or `.data` presence checks (brittle under keepPreviousData placeholders).
  const dataQueries = [delivery, utilization, agents, sessionsQuery];
  // Determinate progress: fraction of the dashboard's reads that have resolved.
  const loadProgress = Math.round(
    (dataQueries.filter((query) => query.isSuccess).length /
      dataQueries.length) *
      100
  );
  // FEA-2038 + FEA-3240 + ISS-6002: the dashboard state machine, in
  // `dashboard-state.ts` so it can be tested without mounting the page.
  const {
    loading,
    showError,
    empty,
    sessionsFailed,
    sessionsCountKnown,
    analyzing: resolving,
  } = resolveDashboardState({
    analyticsLoaded,
    analyticsError,
    sessionsError: sessionsQuery.isError,
    sessionSourceUnavailable: sessionSource.unavailable,
    retrying,
    grew,
    settled,
    sessionsCountFresh,
    sessionsTotal,
  });
  // "Analyzing" treatment: the state machine's own unresolved-count /
  // running-import verdict, plus the first-launch reveal. Deliberately the SAME
  // evidence `loading` is built from (ISS-6002 review) — deriving it from raw
  // readiness left the header, the progress bar and the Recent Sessions caption
  // stuck on "analyzing" over rendered rows whenever the probe latched.
  const analyzing = resolving || (motion && tick < 100);
  const progressPct =
    motion && tick < 100 ? Math.max(tick, loadProgress) : loadProgress;

  const tourSteps = useMemo(
    () =>
      buildTourSteps({
        sessionsTotal,
        agents: agents.data,
        guestOnboardingEnabled: guest.enabled,
        harnesses,
      }),
    [sessionsTotal, agents.data, guest.enabled, harnesses]
  );

  const closeTour = (reason: "done" | "skip") => {
    setTourActive(false);
    writeFlag(dashboardTourSeenStorageKey);
    if (reason === "skip") {
      window.setTimeout(() => setTourHint(true), 80);
      return;
    }
    // Finishing as a guest is the moment an account buys something (team
    // insights, collaborators), so it is the moment to ask. `guestCanConvert`
    // is the SAME predicate `tourCompleteLabel` reads for the button's text, so
    // what the last press says and what it does cannot disagree.
    if (guestCanConvert) {
      requestSignup(GuestSignupIntent.Tour);
    }
  };

  const replayTour = () => {
    setTourHint(false);
    setTourActive(false);
    requestAnimationFrame(() => setTourActive(true));
  };

  return (
    <PageShell
      actions={
        <DashboardHeaderActions
          analyzing={analyzing && !showError}
          dateRange={dateRange}
          gated={orgGated}
          onDateRangeChange={setDateRange}
          onReplayTour={replayTour}
          onScopeChange={handleScopeChange}
          refreshing={refreshing}
          scope={scope}
          // `orgGated` is part of the test, not redundant with
          // `guestCanConvert`: selecting a sign-in method inside the ask puts
          // auth into `opening_browser`/`exchanging`, which is no longer
          // signed-out, so `guestCanConvert` goes false for the whole browser
          // round-trip while the gate card is still on screen. Without this
          // term the toggle unmounts out from under its own gate.
          scopeAvailable={orgScopeAvailable || guestCanConvert || orgGated}
          // ISS-6002: `null` until the count is actually known, so the header
          // cannot announce "· 0 sessions" for a store that has not opened, a
          // read still in flight, or a read that failed. The resolver's own
          // verdict, so the header and the body cannot disagree about whether
          // there is a number to show.
          sessionsTotal={sessionsCountKnown ? sessionsTotal : null}
        />
      }
      fullWidth
      title={DASHBOARD_PAGE_TITLE}
    >
      <AnalyzingBar
        analyzing={analyzing && !showError}
        progressPct={progressPct}
      />

      <OrgGatedRegion
        gated={orgGated}
        onCreateAccount={requestOrgAccount}
        onDismiss={dismissOrgGate}
      >
        <DashboardBody
          agents={agents}
          analyzing={analyzing}
          deltaLabel={deltaLabel}
          empty={empty}
          getTileAvailability={getTileAvailability}
          handleRetry={handleRetry}
          importActive={grew && !settled}
          isShown={isShown}
          loading={loading}
          loadProgress={loadProgress}
          motion={motion}
          periodLabel={periodLabel}
          recentItems={recentItems}
          sections={sections}
          sessionsFailed={sessionsFailed}
          sessionsLoading={sessionsQuery.isLoading}
          showError={showError}
          source={source}
          utilization={utilization}
        />
      </OrgGatedRegion>

      <Tour
        active={tourActive}
        completeLabel={tourCompleteLabel(guest)}
        onClose={closeTour}
        steps={tourSteps}
      />
      <TourHint onClose={() => setTourHint(false)} show={tourHint} />
    </PageShell>
  );
}

// Settled with genuinely no local sessions.
function DashboardEmpty() {
  return (
    <EmptyState
      className="min-h-[360px] rounded-xl border border-border/70 bg-card"
      description="Start using Claude Code, Codex, or another agent on this Mac and your sessions will appear here automatically — computed locally, nothing uploaded."
      icon={LayersIcon}
      title="No agent sessions yet"
    />
  );
}

// FEA-3240: terminal error — all retries exhausted, surface a clear degraded
// state with a manual retry button instead of showing the skeleton forever.
function DashboardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-4 rounded-xl border border-border/70 border-dashed bg-card p-8">
      <p className="text-center text-[var(--muted-foreground)] text-sm">
        Dashboard metrics are temporarily unavailable.
      </p>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        <RefreshCwIcon className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}

function AnalyzingBar({
  analyzing,
  progressPct,
}: {
  analyzing: boolean;
  progressPct: number;
}) {
  if (!analyzing) {
    return null;
  }
  return (
    <div
      aria-label="Analysis progress"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(progressPct)}
      className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--accent)]"
      role="progressbar"
    >
      <div
        className="h-full bg-[var(--primary)] transition-[width] duration-300 ease-out"
        style={{ width: `${progressPct}%` }}
      />
    </div>
  );
}

function DashboardBody({
  loading,
  importActive,
  showError,
  empty,
  handleRetry,
  loadProgress,
  motion,
  isShown,
  agents,
  deltaLabel,
  periodLabel,
  getTileAvailability,
  source,
  utilization,
  sections,
  sessionsFailed,
  sessionsLoading,
  recentItems,
  analyzing,
}: {
  loading: boolean;
  importActive: boolean;
  showError: boolean;
  empty: boolean;
  handleRetry: () => void;
  loadProgress: number;
  motion: boolean;
  isShown: (tour: string) => boolean;
  agents: ReturnType<typeof useAgentsInsights>;
  deltaLabel: string;
  periodLabel: string;
  getTileAvailability: (tile: TileDescriptor) => InsightsTileAvailability;
  source: ReturnType<typeof useInsightsDataSource>;
  utilization: ReturnType<typeof useUtilizationInsights>;
  sections: InsightsSectionData;
  /** The read errored, or its source is unavailable — the localized failure. */
  sessionsFailed: boolean;
  sessionsLoading: boolean;
  recentItems: Parameters<typeof SyncedSessionsTable>[0]["items"];
  analyzing: boolean;
}) {
  // ISS-5061 (ISS-4779 closed-by-default): resolved before the early returns
  // (rules-of-hooks) and threaded into BOTH the row order and the row renderer,
  // so the desktop shell gates the Agent Collaboration Network row from exactly
  // the same value the web shell does — no surface can draw it while the other
  // hides it.
  const rowGates = useDashboardRowGates();
  if (loading) {
    return (
      <DashboardLoading
        analyticsPct={loadProgress}
        importActive={importActive}
      />
    );
  }
  if (showError) {
    return <DashboardError onRetry={handleRetry} />;
  }
  if (empty) {
    return <DashboardEmpty />;
  }
  // FEA-4022 (T5/T20): the frustration row is org opt-in and has no Local-mode
  // producer, so its series is often absent. Unlike the web shell (which filters
  // it), the desktop first-launch dashboard mapped every DASHBOARD_ROW and never
  // passed frustrationSeries, so the row rendered a 300px card shimmering a
  // skeleton forever. Drop the frustration row once the Agents section resolves
  // WITHOUT the series (Local mode, or an opted-out org in Cloud mode); keep it
  // as a skeleton only while the section is still loading so the layout doesn't
  // reflow when it arrives — mirroring InsightsOverviewDashboard's visibleRows.
  const hasFrustration = Boolean(agents.data?.charts.frustrationTrend);
  // The agent-pipeline row carries a data-driven filter on top of its Labs gate:
  // an install whose sessions spawn no subagents would otherwise carry a
  // permanent 340px empty card. Same shape of absent data, same treatment as
  // frustration above. Gate AND data — the gate decides whether the row exists
  // at all, this decides whether an existing row has anything to show.
  const hasAgentPipeline = hasAgentPipelineNodes(
    agents.data?.charts.agentPipeline
  );
  const visibleRows = dashboardRowsFor(rowGates).filter((row) => {
    if (row.tour === "frustration") {
      return hasFrustration || agents.isLoading;
    }
    if (row.tour === "agent-pipeline") {
      return hasAgentPipeline || agents.isLoading;
    }
    return true;
  });
  return (
    <div className="flex flex-col gap-5">
      {visibleRows.map((row) => (
        <Reveal
          delay={0}
          key={row.tour}
          motion={motion}
          show={isShown(row.tour)}
        >
          <div data-tour={row.tour}>
            <DashboardRowContent
              agentPipeline={agents.data?.charts.agentPipeline}
              autonomySeries={agents.data?.charts.autonomyTrend}
              deltaLabel={deltaLabel}
              frustrationSeries={agents.data?.charts.frustrationTrend}
              gates={rowGates}
              getTileAvailability={getTileAvailability}
              githubConnectHref={source.githubConnectHref}
              heatmap={utilization.data?.charts.activityHeatmap}
              modelSeries={agents.data?.charts.modelUsageOverTime}
              modelTokenSeries={agents.data?.charts.modelTokensOverTime}
              onConnectGitHub={source.onConnectGitHub}
              periodLabel={periodLabel}
              row={row}
              sections={sections}
            />
          </div>
          {row.tour === "stats" ? (
            <div className="mt-5">
              <AiImpactCard sections={sections} />
            </div>
          ) : null}
          {row.tour === "activity" && isShown("sessions") ? (
            <div className="mt-5">
              <RecentSessions
                isError={sessionsFailed}
                isLoading={sessionsLoading}
                items={recentItems}
                parsing={analyzing}
              />
            </div>
          ) : null}
        </Reveal>
      ))}
    </div>
  );
}

function Reveal({
  show,
  motion,
  delay,
  children,
}: {
  show: boolean;
  motion: boolean;
  delay: number;
  children: ReactNode;
}) {
  if (!show) {
    return null;
  }
  return (
    <div
      data-ob-motion={motion ? "" : undefined}
      style={{
        animation: motion
          ? `ob-rise .5s cubic-bezier(.2,.7,.3,1) ${delay}ms both`
          : "none",
      }}
    >
      {children}
    </div>
  );
}

function RecentSessions({
  items,
  isLoading,
  isError,
  parsing,
}: {
  items: Parameters<typeof SyncedSessionsTable>[0]["items"];
  isLoading: boolean;
  isError: boolean;
  parsing: boolean;
}) {
  return (
    <div data-tour="sessions">
      <DashboardCard
        description={
          parsing
            ? "Parsing local session logs…"
            : "Every agent run found on this device"
        }
        title="Recent Sessions"
      >
        {renderSessions(items, isLoading, isError)}
      </DashboardCard>
    </div>
  );
}

function renderSessions(
  items: Parameters<typeof SyncedSessionsTable>[0]["items"],
  isLoading: boolean,
  isError: boolean
): ReactNode {
  if (isLoading) {
    return (
      <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
        Reading session logs…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="py-8 text-center text-[var(--destructive)] text-sm">
        Recent sessions are temporarily unavailable.
      </div>
    );
  }
  return (
    <SyncedSessionsTable
      emptyState={
        <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
          No synced sessions found yet.
        </div>
      }
      getSessionHref={desktopSessionDetailHref}
      items={items}
    />
  );
}

type InsightsQueryResult = { isError: boolean; isFetching: boolean };

// The subset of a section query's status the FEA-4020 refreshing derivation
// reads: whether it has settled (success or error) and whether it is fetching.
type SettleableQuery = {
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
};

function useInsightsErrorRecovery(
  delivery: InsightsQueryResult,
  utilization: InsightsQueryResult,
  agents: InsightsQueryResult
) {
  const queryClient = useQueryClient();
  const analyticsError =
    delivery.isError || utilization.isError || agents.isError;
  const [retrying, setRetrying] = useState(false);
  const sawFetchingRef = useRef(false);

  const handleRetry = useCallback(() => {
    sawFetchingRef.current = false;
    setRetrying(true);
    queryClient.invalidateQueries({ queryKey: insightsKeys.all });
  }, [queryClient]);

  // Clear retrying only after we've observed at least one isFetching=true
  // render — invalidateQueries is async and isFetching may not flip on the
  // immediate next render after setRetrying(true).
  useEffect(() => {
    if (!retrying) {
      return;
    }
    const anyFetching =
      delivery.isFetching || utilization.isFetching || agents.isFetching;
    if (anyFetching) {
      sawFetchingRef.current = true;
    }
    if (sawFetchingRef.current && !anyFetching) {
      setRetrying(false);
    }
  }, [
    retrying,
    delivery.isFetching,
    utilization.isFetching,
    agents.isFetching,
  ]);

  return { analyticsError, retrying, handleRetry };
}

// FEA-4020: derive the single header "Refreshing" flag from the three insights
// section queries. All three are keyed on the same range (period) + scope, so a
// change to either refetches every widget at once — one change is one refresh,
// and it reads as one indicator rather than a spinner dimmed over every row.
// `useDashboardRefreshing` gates on the user-driven request key changing (not
// raw `isFetching`), so a db-change invalidation that refetches the SAME range —
// or the ~2s Recent-Sessions poll — never flashes it, and it never shows before
// the first settle (so it can't compete with the first-launch loading
// treatment).
function useSectionRefreshing(
  requestKey: string,
  delivery: SettleableQuery,
  utilization: SettleableQuery,
  agents: SettleableQuery
): boolean {
  const settled =
    (delivery.isSuccess || delivery.isError) &&
    (utilization.isSuccess || utilization.isError) &&
    (agents.isSuccess || agents.isError);
  return useDashboardRefreshing({
    requestKey,
    anyFetching:
      delivery.isFetching || utilization.isFetching || agents.isFetching,
    settled,
  });
}

// Only Delivery/Utilization responses carry GitHub provenance; Agents does not.
// Mirrors the web overview so `org` tile availability resolves identically.
function getSectionGitHubProvenance(
  section: InsightsSectionData[InsightsSection] | undefined
): InsightsGitHubProvenance | undefined {
  if (!(section && "githubProvenance" in section)) {
    return undefined;
  }
  return section.githubProvenance;
}
