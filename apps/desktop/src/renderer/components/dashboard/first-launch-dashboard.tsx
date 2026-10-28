import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { InsightsPeriod } from "@repo/api/src/types/insights";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { AiImpactSlot } from "@repo/app/insights/components/overview/ai-impact-slot";
import { DashboardEmptySurface } from "@repo/app/insights/components/overview/dashboard-empty-surface";
import { DashboardRangeEmptyBody } from "@repo/app/insights/components/overview/dashboard-range-empty-body";
import { useDashboardRefreshing } from "@repo/app/insights/components/overview/dashboard-refreshing";
import {
  isRowLoading,
  isRowStale,
  recentSessionsAnchorRow,
  visibleDashboardRows,
} from "@repo/app/insights/components/overview/dashboard-row-sections";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import { DashboardRowSkeleton } from "@repo/app/insights/components/overview/dashboard-skeletons";
import { DashboardRowTour } from "@repo/app/insights/components/overview/dashboard-tiles";
import {
  DashboardTourAnchor,
  ROW_TOUR_ANCHORS,
} from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import {
  DESKTOP_PARSING_SESSIONS_DESCRIPTION,
  DESKTOP_RECENT_SESSIONS_DESCRIPTION,
  DESKTOP_RECENT_SESSIONS_TITLE,
  DESKTOP_SYNCED_SESSIONS_DESCRIPTION,
  DESKTOP_SYNCED_SESSIONS_TITLE,
} from "@repo/app/insights/components/overview/recent-sessions-copy";
import { useDashboardRowGates } from "@repo/app/insights/components/overview/use-dashboard-row-gates";
import { useDashboardScope } from "@repo/app/insights/components/overview/use-dashboard-scope";
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
  DASHBOARD_PAGE_DESCRIPTION,
  DASHBOARD_PAGE_TITLE,
} from "@repo/app/insights/lib/dashboard-header-copy";
import { getSectionGitHubProvenance } from "@repo/app/insights/lib/github-provenance";
import {
  type InsightsTileAvailability,
  resolveMissingSourceTileAvailability,
} from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { TourCloseReason } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-types";
import { resolveDashboardTourSteps } from "@repo/app/onboarding/components/dashboard-tour/resolve-dashboard-tour-steps";
import { useGuidedDashboardTour } from "@repo/app/onboarding/hooks/use-guided-dashboard-tour";
import {
  DashboardTourOutcome,
  DashboardTourStanding,
  dashboardTourOutcome,
} from "@repo/app/onboarding/lib/dashboard-tour-completion";
import { usePrefersReducedMotion } from "@repo/app/shared/hooks/use-prefers-reduced-motion";
import { DateRange } from "@repo/app/shared/lib/format-utils";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BOOT_IMPORT_STORE_POLL_MS } from "../../hooks/boot-import-store-poll";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";
import { DashboardCard, PageShell } from "../layout/page-shell";
import { useBlockingOnboardingModalOpen } from "../onboarding/blocking-onboarding-modal-store";
import { tourCompleteLabel } from "../onboarding/use-guest-onboarding";
import { useRequestGuestAccount } from "../onboarding/use-request-guest-account";
import { DashboardHeaderActions } from "./dashboard-header-actions";
import { DashboardLoading } from "./dashboard-loading";
import {
  useLocalWindowSessionVerdict,
  useViewerSessionHistory,
} from "./dashboard-range-verdict";
import {
  DesktopDashboardContent,
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
import {
  DashboardTourRecord,
  readDashboardTourRecord,
} from "./tour/guest-tour-record";
import { isDashboardTourStepReady } from "./tour/tour-step-readiness";
import {
  isDesktopAuthHandoffPending,
  useTourArming,
} from "./tour/use-tour-arming";

const RECENT_SESSIONS_LIMIT = 8;
// FEA-2232: the dashboard window is user-driven via the shared, surface-keyed
// `useDashboardRange` hook (the maps + persistence formerly inlined here for
// FEA-2210 now live in `@repo/app/insights`). The "desktop" surface persists
// independently of the Sessions / Branches tabs and the web dashboard.
const DASHBOARD_RANGE_SURFACE = "desktop";

// localStorage flags gate the one-time first-launch experience.
const REVEAL_DURATION_MS = 3600;

// Per-row reveal thresholds on the 0..100 scan tick, plus the Recent Sessions
// card, which reveals on its own beat rather than with the row it sits under.
//
// Keyed by the shared anchor vocabulary and exhaustive over it, so a row added
// to `DashboardRowTour` fails typecheck here instead of silently losing its
// threshold. It was `Record<string, number>` and `frustration` was already
// missing (ISS-8351): `isShown` fell through its `?? 0` and that row skipped
// the staggered reveal entirely. `impact` is deliberately absent from the key
// type — the AI Impact card reveals with the `stats` row it renders inside and
// is never gated on its own.
const REVEAL_AT: Record<
  DashboardRowTour | typeof DashboardTourAnchor.Sessions,
  number
> = {
  stats: 2,
  activity: 24,
  sessions: 42,
  models: 58,
  "agent-pipeline": 64,
  autonomy: 70,
  frustration: 76,
  prs: 82,
  distribution: 92,
};

/**
 * The desktop first-launch dashboard: a fixed, read-only overview built from
 * the shared Insights tile catalog and fed by the local SQLite-backed data
 * source (via DesktopInsightsProvider). On first launch it plays a one-time
 * "populate" reveal as local sessions are analyzed, then auto-starts a guided
 * tour. Subsequent launches render immediately; the tour stays replayable.
 */
export function FirstLaunchDashboard() {
  const source = useInsightsDataSource();
  // ISS-6972: which store this page read, so its empty state can only claim
  // what that store can actually answer for.
  const readsCloud = useDesktopAppCoreMode() === DesktopAppCoreMode.Cloud;
  // PLN-1138: authenticated + online exposes `org` (DesktopInsightsProvider);
  // signed out / offline is personal-scope only. See useDashboardScope for the
  // clamp that keeps a stale `org` read off the local own-data store.
  //
  // ISS-10929 retired this toggle and the operator restored it (2026-09-30),
  // ruling the removal a regression.
  const { scope, orgScopeAvailable, setScope } = useDashboardScope(
    source.availableScopes
  );
  const prefersReduced = usePrefersReducedMotion();
  const [firstLaunch] = useState(() => !readFlag(dashboardOnboardedStorageKey));
  const motion = firstLaunch && !prefersReduced;

  const requestAccount = useRequestGuestAccount();

  const [tick, setTick] = useState(motion ? 0 : 100);
  const [tourActive, setTourActive] = useState(false);

  const completedRef = useRef(false);

  // FEA-2210/FEA-2232: user-driven window (desktop-local persisted selection),
  // backed by the shared surface-keyed hook.
  const { dateRange, setDateRange, period, periodLabel, deltaLabel } =
    useDashboardRange(DASHBOARD_RANGE_SURFACE);

  // Backfill settle detection: while the local DB is still importing sessions,
  // the totals keep growing. Poll the cheap session list and treat the data as
  // "appropriately backfilled" once the total stops growing across consecutive
  // polls. The heavy insights queries do not POLL at all (push model); what
  // settle buys them is the one refetch `InsightsLiveBridge` holds its
  // db-change backlog for (ISS-11611).
  const [settled, setSettled] = useState(false);
  const sessionsQuery = useAgentSessions(
    { limit: RECENT_SESSIONS_LIMIT },
    { refetchInterval: settled ? false : BOOT_IMPORT_STORE_POLL_MS }
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
    setSettled,
  });

  // With the SQLite/WAL reader pool, the insights aggregations run on reader
  // connections concurrently with the backfill writer (and off the main thread),
  // so there's no longer any reason to defer the FIRST read until the import
  // settles — load them immediately. (The old import-settle gate was a
  // SQLite-era mitigation for the single-connection engine blocking the UI
  // during ingest.) Their RE-reads are a separate question, answered by
  // `InsightsLiveBridge`: ISS-11611 measured a db-change invalidation every 5s
  // for the whole import, so the bridge now holds that backlog until settle and
  // flushes it once.
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

  // Full analytics readiness controls the loading state when no session data
  // is available yet; the tour can use available rows before every read ends.
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
  const sectionLoading = {
    [InsightsSection.Delivery]: !delivery.isSuccess,
    [InsightsSection.Utilization]: !utilization.isSuccess,
    [InsightsSection.Agents]: !agents.isSuccess,
  };
  // The fact `sectionLoading` cannot carry — it is `!isSuccess`, so a terminally
  // errored section is indistinguishable from a pending one there. The shared
  // `AiImpactSlot` needs the split to tell its placeholder from its degraded
  // captions, and it must get it from the same two records on both shells.
  const sectionFailed = {
    [InsightsSection.Delivery]: delivery.isError,
    [InsightsSection.Utilization]: utilization.isError,
    [InsightsSection.Agents]: agents.isError,
  };
  // ISS-10413/ISS-10414: which sections are answering for the PREVIOUS range or
  // scope. `placeholderData: keepPreviousData` re-renders every section with the
  // last key's payload the instant the selection changes, and TanStack reports
  // that as settled success — so `sectionLoading` above is false and the rows
  // draw. Delivery answers in a beat; Utilization and Agents can trail it by
  // minutes, which is how the recorded 7d dashboard carried a 90-day Sessions
  // KPI, a June-September heatmap and last quarter's model cost beside a settled
  // seven-day Cost. The payload does not say which window computed it, so this
  // flag — "the data you are reading is not the key you asked for" — is the
  // whole disclosure, and it is per section because they land separately.
  const sectionStale = {
    [InsightsSection.Delivery]: delivery.isPlaceholderData,
    [InsightsSection.Utilization]: utilization.isPlaceholderData,
    [InsightsSection.Agents]: agents.isPlaceholderData,
  };
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
      // Settle the scan rather than abandoning it: reduced motion turned on
      // mid-reveal re-runs this effect and tears the interval down, leaving
      // `tick` frozen part-way and every row past that threshold hidden for the
      // rest of the session. Reduced motion drops the reveal ANIMATION, not the
      // reveal. On a non-motion mount `tick` already starts at 100, so this is a
      // no-op there.
      setTick(100);
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

  // FEA-2038 + FEA-3240 + ISS-6002: the dashboard state machine, in
  // `dashboard-state.ts` so it can be tested without mounting the page.
  // Declared above `useTourArming`: arming reads `content`, and this is the one
  // place that answer comes from (ISS-9992). The same content value carries ISS-9728's "did the page
  // draw rows for the canonical tour to ring?" fact.
  const localVerdict = useLocalWindowSessionVerdict({
    enabled:
      !(readsCloud || sessionSource.importInProgress) &&
      dateRange !== DateRange.AllTime,
    period,
    readAllTime: () => source.getUtilization(InsightsPeriod.All, scope),
    sessionsTotal,
    utilization,
  });
  const windowSessionCount = localVerdict.windowSessionCount;
  const viewerHasSessions = useViewerSessionHistory({
    enabled:
      readsCloud && dateRange !== DateRange.AllTime && windowSessionCount === 0,
    localHasSessions:
      localVerdict.hasSessionsOutsideWindow ?? sessionsTotal > 0,
    readsCloud,
    scope,
  });
  const {
    sessionsFailed,
    analyzing: resolving,
    content,
  } = resolveDashboardState({
    analyticsLoaded,
    analyticsError,
    sessionsError: sessionsQuery.isError,
    sessionSourceUnavailable: sessionSource.unavailable,
    sessionImportActive: sessionSource.importInProgress,
    retrying,
    sessionsCountFresh,
    sessionsTotal,
    dateRange,
    windowSessionCount,
    viewerHasSessions,
  });

  // ISS-8351 / PLN-1875 Step 9: the two tour-seen records, reconciled through
  // the one definition in `dashboard-tour-completion.ts`. The server record is
  // authoritative across devices, so a reader who finished the tour in the web
  // app is not shown it again here; `localSeen` is this install's same-device
  // fast path, read once at mount like `firstLaunch` beside it, and it keeps
  // suppressing with no server round trip at all when the snapshot is gated off,
  // unreadable, or this device is offline.
  //
  // `analysisStarted` is true and measured, not assumed: this component only
  // renders after desktop's local analysis has produced the dashboard it is
  // drawing. It reaches no guard the tour's own two writes take, but the wire
  // contract asks the caller rather than guessing server-side, so it gets the
  // honest answer.
  //
  // ISS-9728 read this through `readDashboardTourRecord` instead of the plain
  // flag accessor. Same answer — the record module is equivalent to
  // `readFlag(dashboardTourSeenStorageKey)` by construction — but for a guest
  // this record is now the WHOLE decision, with no server record able to arrive
  // and correct it, so the safe fold is stated and tested there rather than
  // resting on an inline comparison.
  const [localTourSeen, setLocalTourSeen] = useState(
    () => readDashboardTourRecord() === DashboardTourRecord.Dismissed
  );
  const { deferTour, finishTour, tourStanding } = useGuidedDashboardTour({
    analysisStarted: true,
    host: OnboardingHost.Desktop,
    localSeen: localTourSeen,
  });

  // ISS-11204: use the rows already available while parsing continues. The
  // tour resolves its anchored steps on activation; import completion is not
  // an admission requirement.
  const runHasAnchoredBeat = content === DesktopDashboardContent.Ready;

  const isTourStepReady = (anchor: DashboardTourAnchor) =>
    isDashboardTourStepReady(anchor, {
      sectionFailed,
      sectionLoading,
      sessionsLoading: sessionsQuery.isLoading,
    });

  // ISS-10570: this page mounts BEHIND the guided-onboarding takeover, which is
  // a shell sibling, so the arm needs to know before it spends its one shot.
  const blockingModalOpen = useBlockingOnboardingModalOpen();

  // ISS-11315 Defect 4: the takeover also closes when the account run hands off
  // to the system browser, which is NOT the end of onboarding. The auth state
  // machine already distinguishes the two, so the arm holds on its in-flight
  // statuses rather than reading the close as a finish and playing the tour's
  // opening animation at a reader who is being redirected away.
  const { state: desktopAuthState } = useDesktopAuth();
  const handoffPending = isDesktopAuthHandoffPending(desktopAuthState.status);

  // No `?? 0` fallback: REVEAL_AT is exhaustive over this parameter's type, so
  // every key resolves to a real threshold. That fallback is what silently
  // revealed `frustration` immediately while its entry was missing.
  // ISS-11204 (tamsinb review): gated on an OWED tour, NOT on `firstLaunch`.
  // `motion` is already `firstLaunch && !prefersReduced`, so a `firstLaunch`
  // disjunct reduces to `runHasAnchoredBeat` — which is `content === Ready`, the
  // condition under which these rows render at all — and made `isShown`
  // unconditionally true, deleting the staggered reveal for every first-launch
  // reader. Only the reader whose spotlight has to open immediately needs the
  // rows up front; a reader with no tour standing still gets the reveal.
  // `tourActive` cannot serve here: the tour measures these anchors to arm, so
  // gating them on it would keep the reveal from ever completing.
  const isShown = (
    tour: DashboardRowTour | typeof DashboardTourAnchor.Sessions
  ) =>
    !motion ||
    (tourStanding === DashboardTourStanding.Owed && runHasAnchoredBeat) ||
    tick >= REVEAL_AT[tour];

  useTourArming({
    blockingModalOpen,
    handoffPending,
    // The reveal's FIRST beat, not its completion — `arm()` needs one anchor in
    // the DOM and a staggered reveal has none at the moment `content` is Ready.
    hasRenderedAnchor: isShown(FIRST_REVEALED_ROW),
    firstBeatReady: isTourStepReady(DashboardTourAnchor.Stats),
    runHasAnchoredBeat,
    firstLaunch,
    tourStanding,
    content,
    deferTour,
    completedRef,
    setTourActive,
  });

  // ISS-10409: whether the first-launch reveal is still drawing rows in. Not an
  // input to `content`, so `Ready` is reachable while the page is still
  // animating and its tour anchors are not laid out yet.
  const revealPending = motion && tick < 100;
  // "Analyzing" treatment: the state machine's own unresolved-count /
  // running-import verdict, plus the first-launch reveal. Taken from the state
  // machine rather than from raw readiness (ISS-6002 review), so the Recent
  // Sessions caption does not stay on "analyzing" after the import settles.
  // Since ISS-10651 the page draws parsed rows while the import continues.
  const analyzing = resolving || revealPending;
  const closeTour = (reason: TourCloseReason) => {
    setTourActive(false);
    // `Unshown` is the run reporting it had no steps, so nothing was ever shown.
    // Spending the tour-seen flag on it would retire the tour for a reader who
    // never got it, and the guest ask below would open the Account step over
    // nothing — which is what `TourCloseReason` exists to let a host avoid.
    // Which of the two a close reason is comes from
    // `dashboard-tour-completion.ts`, so desktop and web cannot disagree about
    // what finishing means (PLN-1875 Step 9).
    //
    // ISS-10546 made this branch REACHABLE on desktop, where it used to be
    // dead. Desktop prepended an intro summary card to every run, so a run
    // always had at least that one step and could never resolve empty; with
    // that card retired, desktop resolves the same anchors-only run web does
    // and an unanchored page now reports `Empty` here exactly as web's does.
    //
    // ISS-9728: `runHasAnchoredBeat` is the SAME non-event arriving by the
    // other road — a run that rang nothing must not be recorded as the tour,
    // because that would retire it for a reader who was never shown a beat of
    // it, and for a guest nothing can arrive to correct that. Re-measured at
    // close rather than captured at open on purpose: the direction it can be
    // wrong in costs one extra tour, which is the fold `guest-tour-record.ts`
    // already chose.
    if (
      !runHasAnchoredBeat ||
      dashboardTourOutcome(reason) === DashboardTourOutcome.Unshown
    ) {
      deferTour();
      return;
    }
    writeFlag(dashboardTourSeenStorageKey);
    // ISS-11480: the standing follows the record just written. A takeover that
    // later opens and closes over this page (a resumed Account step) re-arms
    // the tour from `tourStanding`, which would replay the walk just finished.
    setLocalTourSeen(true);
    // The same completion, told to the server, so the OTHER device stops
    // offering it. A no-op when there is no guided run to record it against —
    // the legacy branch, a guest, or an unreadable snapshot — which is what
    // keeps this working offline.
    finishTour();
    // ISS-10929 retired the Tour control from this row, so a skip has no
    // button left to point a "the walkthrough lives here" hint at. Skipping now
    // simply ends the run.
    if (reason === TourCloseReason.Skip) {
      return;
    }
    // Finishing as a guest is the moment an account buys something (team
    // insights, collaborators), so it is the moment to ask. `requestAccount`
    // is the SAME value `tourCompleteLabel` reads for the button's text, so
    // what the last press says and what it does cannot disagree.
    requestAccount?.();
  };

  return (
    <PageShell
      actions={
        <DashboardHeaderActions
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          onScopeChange={setScope}
          refreshing={refreshing}
          scope={scope}
          scopeAvailable={orgScopeAvailable}
        />
      }
      description={DASHBOARD_PAGE_DESCRIPTION}
      fullWidth
      title={DASHBOARD_PAGE_TITLE}
    >
      <DashboardBody
        agents={agents}
        analyzing={analyzing}
        content={content}
        deltaLabel={deltaLabel}
        getTileAvailability={getTileAvailability}
        handleRetry={handleRetry}
        isShown={isShown}
        motion={motion}
        onShowAllTime={() => setDateRange(DateRange.AllTime)}
        periodLabel={periodLabel}
        readsCloud={readsCloud}
        recentItems={recentItems}
        sectionFailed={sectionFailed}
        sectionLoading={sectionLoading}
        sectionStale={sectionStale}
        sections={sections}
        sessionsFailed={sessionsFailed}
        sessionsLoading={sessionsQuery.isLoading}
        source={source}
        utilization={utilization}
      />

      {/* ISS-10570 — see {@link DASHBOARD_TOUR_LAYER_Z}. `fixed` rather than
          `relative` so this adds no box to the flow, and it is not a containing
          block for the tour's own fixed layers, so their geometry is untouched;
          `pointer-events: none` because it spans the viewport whether or not a
          run is open, and the callout re-enables its own. */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{ zIndex: DASHBOARD_TOUR_LAYER_Z }}
      >
        <Tour
          active={tourActive && !blockingModalOpen}
          completeLabel={tourCompleteLabel(requestAccount !== undefined)}
          isStepReady={isTourStepReady}
          onClose={closeTour}
          resolveSteps={resolveDashboardTourSteps}
        />
      </div>
    </PageShell>
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

function DashboardBody({
  content,
  handleRetry,
  onShowAllTime,
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
  readsCloud,
  recentItems,
  analyzing,
  sectionLoading,
  sectionFailed,
  sectionStale,
}: {
  /**
   * WHICH branch the page draws, as the one closed value `dashboard-state.ts`
   * already folded. Read here instead of re-running its precedence over three
   * booleans, which is how the arm's answer and the rendered screen drifted.
   */
  content: DesktopDashboardContent;
  handleRetry: () => void;
  /** ISS-11927: widen the range to all time from the date-range empty. */
  onShowAllTime: () => void;
  motion: boolean;
  isShown: (
    tour: DashboardRowTour | typeof DashboardTourAnchor.Sessions
  ) => boolean;
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
  /** ISS-6972: the empty state may only claim this Mac is empty if it read it. */
  readsCloud: boolean;
  recentItems: Parameters<typeof SyncedSessionsTable>[0]["items"];
  analyzing: boolean;
  sectionLoading: Record<InsightsSection, boolean>;
  /**
   * ISS-10486: which sections reached terminal error. Threaded to the shared
   * `AiImpactSlot` so that card resolves its own verdict from the SAME inputs on
   * both shells. This shell still refuses the whole page on any errored section
   * (ISS-10408 owns splitting that), so today every entry here is false by the
   * time the body renders — passing it anyway is what keeps the two shells from
   * drifting when that split lands.
   */
  sectionFailed: Record<InsightsSection, boolean>;
  /** ISS-10414: sections still answering for the previous range/scope. */
  sectionStale: Record<InsightsSection, boolean>;
}) {
  // ISS-5061 (ISS-4779 closed-by-default): resolved before the early returns
  // (rules-of-hooks) and threaded into BOTH the row order and the row renderer,
  // so the desktop shell gates the Agent Collaboration Network row from exactly
  // the same value the web shell does — no surface can draw it while the other
  // hides it.
  const rowGates = useDashboardRowGates();
  if (content === DesktopDashboardContent.Loading) {
    return <DashboardLoading />;
  }
  if (content === DesktopDashboardContent.Error) {
    return <DashboardError onRetry={handleRetry} />;
  }
  if (content === DesktopDashboardContent.Empty) {
    return (
      <DashboardEmptySurface
        getTileAvailability={getTileAvailability}
        githubConnect={source.githubConnect}
        readsCloud={readsCloud}
      />
    );
  }
  if (content === DesktopDashboardContent.RangeHidden) {
    return <DashboardRangeEmptyBody onShowAllTime={onShowAllTime} />;
  }
  const visibleRows = visibleDashboardRows({
    gates: rowGates,
    sections,
    sectionLoading,
  });
  const recentSessionsAnchor = recentSessionsAnchorRow(visibleRows);
  return (
    <div className="flex flex-col gap-5">
      {visibleRows.map((row) => (
        <Reveal
          delay={0}
          key={row.tour}
          motion={motion}
          show={isShown(row.tour)}
        >
          <div data-tour={ROW_TOUR_ANCHORS[row.tour]}>
            {isRowLoading(row, sectionLoading) ? (
              <DashboardRowSkeleton row={row} />
            ) : (
              <DashboardRowContent
                agentPipeline={agents.data?.charts.agentPipeline}
                autonomySeries={agents.data?.charts.autonomyTrend}
                deltaLabel={deltaLabel}
                frustrationSeries={agents.data?.charts.frustrationTrend}
                gates={rowGates}
                getTileAvailability={getTileAvailability}
                githubConnect={source.githubConnect}
                heatmap={utilization.data?.charts.activityHeatmap}
                modelSeries={agents.data?.charts.modelUsageOverTime}
                modelTokenSeries={agents.data?.charts.modelTokensOverTime}
                periodLabel={periodLabel}
                row={row}
                sections={sections}
                stale={isRowStale(row, sectionStale)}
              />
            )}
          </div>
          {row.tour === DashboardRowTour.Stats ? (
            <div className="mt-5" data-tour={DashboardTourAnchor.Impact}>
              <AiImpactSlot
                getTileAvailability={getTileAvailability}
                githubConnect={source.githubConnect}
                sectionFailed={sectionFailed}
                sectionLoading={sectionLoading}
                sectionStale={sectionStale}
                sections={sections}
              />
            </div>
          ) : null}
          {row.tour === recentSessionsAnchor &&
          isShown(DashboardTourAnchor.Sessions) ? (
            <div className="mt-5">
              <RecentSessions
                isError={sessionsFailed}
                isLoading={sessionsLoading}
                items={recentItems}
                parsing={analyzing}
                readsCloud={readsCloud}
              />
            </div>
          ) : null}
        </Reveal>
      ))}
    </div>
  );
}

/**
 * The earliest row on the reveal's beat list. `arm()` needs SOME anchor in the
 * DOM, so this row appearing is the moment the page first has one.
 */
const FIRST_REVEALED_ROW = "stats" as const;

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
  readsCloud,
}: {
  items: Parameters<typeof SyncedSessionsTable>[0]["items"];
  isLoading: boolean;
  isError: boolean;
  parsing: boolean;
  readsCloud: boolean;
}) {
  const localDescription = parsing
    ? DESKTOP_PARSING_SESSIONS_DESCRIPTION
    : DESKTOP_RECENT_SESSIONS_DESCRIPTION;
  return (
    <div data-tour={DashboardTourAnchor.Sessions}>
      <DashboardCard
        description={
          readsCloud ? DESKTOP_SYNCED_SESSIONS_DESCRIPTION : localDescription
        }
        title={
          readsCloud
            ? DESKTOP_SYNCED_SESSIONS_TITLE
            : DESKTOP_RECENT_SESSIONS_TITLE
        }
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
    // Not awaited: `retrying` is cleared by the isFetching observation below,
    // and a failed refetch surfaces through the insights queries' error state.
    queryClient
      .invalidateQueries({ queryKey: insightsKeys.all })
      .catch(() => undefined);
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
// ISS-10414: this answers "is anything still in flight", which is NOT the same
// question as "is this row's data the selection I just made" — the sections
// settle minutes apart, so `sectionStale` and `DashboardRowUpdatingNotice` above
// answer the second one per row while this keeps answering the first.
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

/**
 * The stacking layer the first-launch tour is confined to (ISS-10570).
 *
 * `Tour` paints its own fixed layers at 60-62 against the design system's
 * `z-50` dialog overlay and content, and nothing between them made a stacking
 * context — `SidebarInset` is `relative` with no `z-index` — so the tour painted
 * OVER the guided-onboarding takeover, with a live Skip control above a modal
 * the reader had not answered. Confined here, those 60-62 resolve inside this
 * element and the whole run sits at this layer in the root context, matching the
 * normative prototype's blocker, ring and scrim.
 *
 * ISS-11150: a live takeover no longer has a run underneath it to paint over —
 * the arm refuses to open one while the blocking modal is up — so this layer's
 * remaining job is containment, and the reader it protects is the one a dialog
 * opens over a tour already running. The tour's controls are unchanged; only
 * the layer they sit on moved: each one declares its own `pointer-events`, so
 * the layer's `none` (which it needs, or an empty layer would swallow the page)
 * takes the mouse from none of them.
 *
 */
const DASHBOARD_TOUR_LAYER_Z = 40;
