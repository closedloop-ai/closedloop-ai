"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type {
  InsightsScope,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  InsightsScope as InsightsScopeValues,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { DegradedState } from "@repo/app/agents/components/shared/degraded-state";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { SESSIONS_GLANCEABLE_COLUMNS } from "@repo/app/agents/hooks/use-sessions-view-state";
import { SessionSortKey } from "@repo/app/agents/lib/session-sort-group";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { useDashboardRange } from "@repo/app/insights/hooks/use-dashboard-range";
import {
  useAgentsInsights,
  useDeliveryInsights,
  useInsightsSectionRetry,
  useUtilizationInsights,
} from "@repo/app/insights/hooks/use-insights";
import {
  DASHBOARD_DATE_RANGES,
  type DashboardDateRange,
  WEB_DASHBOARD_RANGE_SURFACE,
} from "@repo/app/insights/lib/dashboard-range";
import {
  dashboardRangeHidesSessions,
  utilizationWindowSessionCount,
} from "@repo/app/insights/lib/dashboard-range-hides-sessions";
import {
  type DashboardSessionVolumeReport,
  deriveDashboardSessionVolumeReport,
} from "@repo/app/insights/lib/dashboard-session-volumes";
import { getSectionGitHubProvenance } from "@repo/app/insights/lib/github-provenance";
import { resolveMissingSourceTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { DateRangeFilter } from "@repo/app/shared/components/date-range-filter";
import { useFeatureFlagGateOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useResolvedOrDeadline } from "@repo/app/shared/hooks/use-resolved-or-deadline";
import { DASHBOARD_DEFERRED_FIRST_PAINT_READS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  DATE_RANGE_LABELS,
  DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { Clock3Icon, LayersIcon } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { AiImpactSlot, resolveAiImpactState } from "./ai-impact-slot";
import { DashboardCard } from "./dashboard-card";
import {
  type DashboardContentState,
  resolveDashboardContentState,
} from "./dashboard-content-state";
import { DashboardRangeEmptyBody } from "./dashboard-range-empty-body";
import {
  DashboardRefreshingIndicator,
  useDashboardRefreshing,
} from "./dashboard-refreshing";
import {
  DashboardRowState,
  isRowRetrying,
  isRowStale,
  ROW_SECTIONS,
  recentSessionsAnchorRow,
  resolveDashboardRowState,
  visibleDashboardRows,
} from "./dashboard-row-sections";
import { DashboardRowSlot } from "./dashboard-row-slot";
import { DashboardRowContent } from "./dashboard-rows";
import { DashboardScopeControl } from "./dashboard-scope-control";
import { DashboardRowTour } from "./dashboard-tiles";
import {
  DashboardTourAnchor,
  ROW_TOUR_ANCHORS,
} from "./dashboard-tour-anchors";
import { WEB_RECENT_SESSIONS_TITLE } from "./recent-sessions-copy";
import { useDashboardRowGates } from "./use-dashboard-row-gates";
import { useDashboardScope } from "./use-dashboard-scope";

// FEA-2232: the overview window is user-driven via the shared date-range picker
// (defaults to the shared `DEFAULT_DATE_RANGE`, 7d — `format-utils.ts`; this
// comment claimed 90d until ISS-7185, and the pinned-window disclosure below
// only makes sense against the real default). The selection is persisted under a
// dashboard-specific localStorage key, independent of the Sessions / Branches
// tabs. KPI totals cover the full selected range; trend sparklines stay capped at
// 90 days by the insights service, which the "all" caption reflects.
const RECENT_SESSIONS_LIMIT = 8;
// ISS-7514: the loading placeholder's height, mirroring the resolved table the
// way `dashboard-skeletons.tsx` mirrors every other row — a header strip plus
// RECENT_SESSIONS_LIMIT rows at the shared sessions-list band, so nothing below
// this card is shoved down when the read lands.
const RECENT_SESSIONS_SKELETON_HEIGHT = 320;
// ISS-7514: how long the deferral will wait on the insights sections before
// issuing the Recent Sessions read regardless. Its own constant rather than the
// flag gate's `FEATURE_FLAG_RESOLUTION_DEADLINE_MS`, per that hook's contract —
// the two answer to different services. Longer than that 3s because this one is
// waiting on the very reads the deferral exists to stay out of, so it must not
// expire during an ordinary slow first paint and re-create the concurrent burst.
export const DEFERRED_SESSIONS_RELEASE_DEADLINE_MS = 8000;
// Match the Sessions page default window so "Recent Sessions" is a strict
// prefix of that list (same lastActivityAt window + ordering); see FEA-2180.
const RECENT_SESSIONS_RANGE: DateRange = "7d";
/**
 * ISS-7185: this card is PINNED to {@link RECENT_SESSIONS_RANGE} while every KPI
 * above it follows the page range picker, so it has to say which window it is
 * showing. They agree only on a FIRST visit — the picker persists per surface to
 * localStorage, so a returning reader who ever widened it arrives with the tiles
 * on 90d and this card on 7d, which is exactly the reader this ticket is about.
 * Undisclosed, the card then reads as the same cohort as the tiles above, or as
 * a stale one. "Always" is the word that marks it fixed rather than merely
 * current.
 *
 * The window itself comes from the canonical label map, never a second copy of
 * the number, so the caption cannot drift from the range it describes.
 *
 * BEFORE YOU TRIM THIS: on the default view it reads as redundant, because the
 * picker, the heatmap caption and this one all say seven days at once. They are
 * three different claims that merely coincide at the default — the picker states
 * a SELECTION, the heatmap a window that FOLLOWS it, and this one a window that
 * does NOT. Shortening it back to the window alone makes this card
 * indistinguishable from the heatmap's, which is the bug ISS-7185 fixed.
 */
export const RECENT_SESSIONS_DESCRIPTION = `Always ${DATE_RANGE_LABELS[
  RECENT_SESSIONS_RANGE
].toLowerCase()} · latest synced agent runs`;
/**
 * ISS-9727 review: the page size of the all-time existence read. Nothing renders
 * its rows — only its `total` is read — so this is as small as a list request
 * can be while still being one.
 */
const ORG_SESSION_HISTORY_LIMIT = 1;

export type InsightsOverviewDashboardProps = {
  /**
   * The control the empty state offers, when the surface has one to give
   * (ISS-9727). Optional and route-owned for the same reason `getSessionHref`
   * is: the destination is a URL shape this component must not know. Absent, the
   * empty state draws no control rather than one that goes nowhere (ISS-7866).
   */
  emptyStateAction?: ReactNode;
  /**
   * The empty state's description (ISS-11261). Host-supplied for the same reason
   * `emptyStateAction` is route-owned: the honest ask depends on where the card is
   * mounted.
   */
  emptyStateDescription: string;
  /** Route href for a session row; each surface owns its URL shape. */
  getSessionHref: (item: AgentSessionListItem) => string;
  /**
   * Reports which of the three render outcomes this dashboard is showing
   * (PLN-1875 Step 8). A surface that anchors something to the dashboard — the
   * spotlight tour is the one today — cannot tell a page mid-load from a page
   * with nothing to draw by measuring the DOM; see `dashboard-content-state.ts`.
   * Optional: the desktop shell composes these rows itself and has its own
   * readiness gate.
   *
   * Need not be referentially stable — an inline arrow is fine. It is called
   * once per change of state, never once per render of the caller.
   */
  onContentStateChange?: (state: DashboardContentState) => void;
  /**
   * Reports the session-volume facts the utilization payload already carries,
   * once that read settles (PRD-736 / ISS-10501: the dashboard `page_viewed`
   * buckets are derived from data the tiles already load — no extra query). A
   * failed read publishes an all-null report, so a subscriber can emit its
   * event without volume properties rather than waiting forever. Same
   * stability contract as `onContentStateChange`.
   */
  onSessionVolumeReport?: (report: DashboardSessionVolumeReport) => void;
  /**
   * The scope the dashboard STARTS on, before the reader touches the Me /
   * Organization control in the header row. Defaults to the current user, which
   * is the scope both shells now start on by operator ruling (Marisol Ashgrove,
   * 2026-09-30: "both should default to 'Me'").
   *
   * A starting scope rather than a fixed one since the control was added by
   * operator instruction (Marisol Ashgrove, 2026-09-30: "We need to also do
   * [PR #8213] this for web; add it in. We can do it as a separate PR"). A host
   * that passes one keeps it until a reader changes it.
   */
  scope?: InsightsScope;
};

/**
 * Surface-agnostic overview dashboard body: a fixed, read-only layout built
 * from the shared Insights tile catalog (KPIs, activity heatmap, recent
 * sessions, model usage, autonomy trend, PR throughput, distributions). The web
 * shell mounts this inside `WebInsightsDataSourceProvider`; the desktop shell
 * composes the same rows with its own first-launch reveal + guided tour.
 */
export function InsightsOverviewDashboard({
  emptyStateAction,
  emptyStateDescription,
  getSessionHref,
  onContentStateChange,
  onSessionVolumeReport,
  scope: initialScope = InsightsScopeValues.Me,
}: Readonly<InsightsOverviewDashboardProps>) {
  const source = useInsightsDataSource();
  // The operator's gate, in web's terms: the toggle renders only where the
  // source advertises `org`, and `useDashboardScope` clamps the effective scope
  // to `Me` everywhere it does not — one clamp, shared with the desktop shell,
  // rather than a second copy of the rule (Marisol Ashgrove, 2026-09-30: "the
  // selector of course should only appear on desktop if I'm logged in and have
  // 'org' data to display — otherwise it's hidden and just shows my local").
  const { scope, orgScopeAvailable, setScope } = useDashboardScope(
    source.availableScopes,
    initialScope
  );
  // FEA-2232: user-driven window (persisted, dashboard-local selection).
  const { dateRange, setDateRange, period, periodLabel, deltaLabel } =
    useDashboardRange(WEB_DASHBOARD_RANGE_SURFACE);
  const delivery = useDeliveryInsights(period, scope, undefined);
  const utilization = useUtilizationInsights(period, scope, undefined);
  const agents = useAgentsInsights(period, scope, undefined);
  // Memoized: getStartDateForRange returns a fresh ms-precision ISO string per
  // call, so an unmemoized value would change the query key every render and
  // drive a refetch/skeleton-flash loop (same reason as the Sessions page).
  const startDate = useMemo(
    () => getStartDateForRange(RECENT_SESSIONS_RANGE),
    []
  );
  // FEA-3534: derive the session-read viewer scope from the dashboard's Me/Org
  // scope prop and thread it into the Recent Sessions query. Without this the
  // card issued a bare `GET /agent-sessions` (no scope), so after the PLN-1138
  // cloud swap the "Me" dashboard silently showed org-wide sessions. `me` maps
  // to `self` (server-enforced to the authenticated user); every other scope
  // stays org-wide, preserving the Org view. Team drill-down is not wired on
  // this card (it passes no teamId, exactly like the KPI queries above), so it
  // resolves to the org view rather than an unscoped team read.
  const viewerScope =
    scope === InsightsScopeValues.Me
      ? AgentSessionViewerScope.Self
      : AgentSessionViewerScope.Organization;

  const analyticsAllSucceeded =
    delivery.isSuccess && utilization.isSuccess && agents.isSuccess;
  // ISS-10486: EVERY section, not any. A page with two working sections is not a
  // failed page, and replacing it with the whole-body Retry card deleted two
  // sections' worth of data the reader could already have been looking at. A
  // single failure degrades its own rows instead (`sectionFailed` below).
  const analyticsAllFailed =
    delivery.isError && utilization.isError && agents.isError;

  // ISS-7514: Recent Sessions paints below the KPI and chart rows and nothing
  // above it reads the result, so its scan does not have to run against the
  // same API/database while all three insights sections are in flight — the
  // slowest moment, and the one this ticket is about.
  //
  // The trigger is the FIRST section landing, not all three. Waiting for all
  // three would make the whole-page "No agent sessions yet" short-circuit
  // (which needs `analyticsAllSucceeded` AND this read) resolve strictly AFTER the
  // rows paint, so a zero-data org would watch a dashboard of zeros draw and
  // then be replaced. Releasing on the first section keeps that a race, as it
  // is today, while still keeping the scan out of the concurrent burst.
  //
  // Settled, not success (ISS-10486). While one errored section blanked the
  // whole page, a request released by it landed on a card that was never
  // rendered, so this asked for a success. The page now draws through that
  // failure, so an errored section is a released gate like any other terminal
  // one — waiting for a success it will never get would park Recent Sessions
  // behind the 8s deadline on a dashboard that had already painted.
  const anySectionSettled =
    delivery.isSuccess ||
    delivery.isError ||
    utilization.isSuccess ||
    utilization.isError ||
    agents.isSuccess ||
    agents.isError;
  // Bounded, for the reason `useResolvedOrDeadline` exists: a deferral that
  // waits forever is not a safety net, it is a new way for the card to never
  // load. A hung `/insights/*` never resolves and never errors, so it neither
  // releases this gate nor trips the `DegradedState` short-circuit — leaving a
  // healthy `/agent-sessions` unread behind a permanent skeleton, which is the
  // "widgets load independently" line in `packages/app/AGENTS.md`. Past the
  // deadline the read is issued anyway: the worst case is the ungated
  // behaviour this ticket started from, one extra concurrent read, never a
  // card that never fills.
  const sectionsLoadedOrDeadline = useResolvedOrDeadline(
    anySectionSettled,
    DEFERRED_SESSIONS_RELEASE_DEADLINE_MS
  );
  // The OPTIONAL gate for the same reason `useDashboardRowGates` uses the
  // optional adapter — this component also mounts without a flag provider. The
  // readiness half is what makes the deferral real: `useFeatureFlagEnabled*`
  // reports an unresolved PostHog flag as `false`, so keying the read off the
  // bare boolean would issue it on mount and let the flip merely disable a
  // request already in flight (FEA-1626).
  const deferralGate = useFeatureFlagGateOptional(
    DASHBOARD_DEFERRED_FIRST_PAINT_READS_FEATURE_FLAG_KEY
  );
  // Mirror the Sessions page default view exactly — same window, same sort —
  // so "Recent Sessions" is a strict prefix of that list on every surface
  // (FEA-2180). Both must sort by last activity, not start time / cursor order.
  const sessionsQuery = useAgentSessions(
    {
      limit: RECENT_SESSIONS_LIMIT,
      startDate,
      sortBy: SessionSortKey.LastActivity,
      sortDir: "desc",
      viewerScope,
    },
    {
      enabled:
        deferralGate.isReady &&
        (!deferralGate.enabled || sectionsLoadedOrDeadline),
    }
  );
  // The honest "no answer yet" signal, and the reason the deferral cannot make
  // the card lie. TanStack reports `isLoading` as FALSE for a query it has not
  // been allowed to start (pending + idle), so passing `isLoading` here would
  // render the table's "No recent sessions" empty state for a read that was
  // never issued. Settled-or-not covers both the deferred window and the
  // in-flight one, and is identical to `isLoading` when nothing is deferred.
  const recentSessionsPending = !(
    sessionsQuery.isSuccess || sessionsQuery.isError
  );
  // Empty = every section resolved and the pinned-window sessions query
  // genuinely returned no rows (guarding against the sessions query still
  // loading after insights resolve from cache). Per-section skeletons cover the
  // in-flight window, so we only short-circuit to the empty state once nothing
  // is left to load — never mid-load.
  //
  // A STATEMENT ABOUT THE WINDOW, NOT ABOUT THE ORG. `sessionsQuery` is pinned
  // to RECENT_SESSIONS_RANGE, so this is zero for an org that onboarded a month
  // ago and paused exactly as it is for one that has never synced anything.
  // Which one it is is the read below.
  //
  // EVERY SECTION SUCCEEDED is the load-bearing term now that a failure no
  // longer returns above this (ISS-10486). A partially failed page must not be
  // called empty: "No agent sessions yet" would replace the body — and with it
  // the degraded row's Retry — on the strength of a fan-out that did not finish
  // answering.
  const empty =
    analyticsAllSucceeded &&
    sessionsQuery.isSuccess &&
    (sessionsQuery.data?.total ?? 0) === 0;
  // ISSUED ONLY ON A PAGE THAT IS ALREADY EMPTY, so an ordinary dashboard adds
  // no request at all. See {@link useOrgSessionHistory} for why the answer
  // cannot be inferred from the read above.
  const { emptyBody, orgHasNeverSynced, orgSessionHistoryPending } =
    useDashboardEmptyVerdict({
      dateRange,
      empty,
      utilization,
      viewerScope,
    });

  // Per-section loading gates. Below (after the error early-return) each row
  // draws its own skeleton until the sections it reads from resolve, so a slow
  // query only holds its own rows — not the whole page — behind a placeholder.
  // A section is "loading" here when it is neither settled-success nor errored.
  const sectionLoading = {
    [InsightsSection.Delivery]: !delivery.isSuccess,
    [InsightsSection.Utilization]: !utilization.isSuccess,
    [InsightsSection.Agents]: !agents.isSuccess,
  } as const;
  // The fact `sectionLoading` cannot carry: it is built as `!isSuccess`, so a
  // terminally errored section is indistinguishable from a pending one there.
  // Without this split, a row reading a failed section skeletons for the life of
  // the window instead of offering the reader a way out.
  const sectionFailed = {
    [InsightsSection.Delivery]: delivery.isError,
    [InsightsSection.Utilization]: utilization.isError,
    [InsightsSection.Agents]: agents.isError,
  } as const;

  // One press recovers THE SECTIONS THAT ROW READS, and no others.
  // `staleTime: Infinity` with every refetch disabled means an errored section
  // never retries on its own, so this control is the only way back — but a
  // dashboard that degrades per row has several of them on screen at once, and
  // a press that re-read all three would throw away the sections the reader can
  // still see (see {@link useInsightsSectionRetry}). Offered at row scale by
  // `DashboardRowSlot` and at page scale by nothing — the page-level degraded
  // copy asks for a refresh, which is the only recovery a page with no section
  // left to read can honestly offer.
  const retrySections = useInsightsSectionRetry(period, scope);
  // A degraded row is byte-identical before and during its refetch: TanStack
  // keeps `status: "error"` and flips only `fetchStatus`, so without this the
  // press produces no visible change at all. The header indicator cannot cover
  // it either — that one gates on the user-driven request key, which a retry
  // does not change. Per section for the same reason the invalidation is: read
  // across all three, one row's press reports every other degraded row busy.
  const sectionFetching = {
    [InsightsSection.Delivery]: delivery.isFetching,
    [InsightsSection.Utilization]: utilization.isFetching,
    [InsightsSection.Agents]: agents.isFetching,
  } as const;
  // ISS-10413/ISS-10414: which sections are answering for the PREVIOUS range or
  // scope. `placeholderData: keepPreviousData` re-renders every section with the
  // last key's payload the instant the selection changes, and TanStack reports
  // that as settled success — so `sectionLoading` above is false and the row
  // draws its content rather than its skeleton. The sections do not land
  // together (Delivery in a beat, Utilization and Agents minutes behind on a
  // large corpus), so this is per section, and the row-level disclosure below is
  // what stops one settled half making the other half read as current.
  const sectionStale = {
    [InsightsSection.Delivery]: delivery.isPlaceholderData,
    [InsightsSection.Utilization]: utilization.isPlaceholderData,
    [InsightsSection.Agents]: agents.isPlaceholderData,
  } as const;

  // FEA-4020: a single header "Refreshing" indicator for the whole dashboard.
  // ISS-10414 kept it and added the per-row `sectionStale` notice beside it: one
  // says something is in flight, the other says WHICH rows are still drawing the
  // previous key's payload. Neither substitutes for the other.
  // Every section query is keyed on the same range (period) + scope, so a change
  // to either refetches all of them at once — one range change is one refresh,
  // and it reads as one indicator rather than a spinner dimmed over every row.
  // The indicator is gated on the user-driven request key changing (not raw
  // `isFetching`), so it never flashes for a background refetch at the same
  // range. It shows only past the first load (all sections settled once), so it
  // never competes with the per-row skeletons.
  const analyticsAllSettled =
    (delivery.isSuccess || delivery.isError) &&
    (utilization.isSuccess || utilization.isError) &&
    (agents.isSuccess || agents.isError);
  const refreshing = useDashboardRefreshing({
    requestKey: `${period}:${scope}`,
    anyFetching:
      delivery.isFetching || utilization.isFetching || agents.isFetching,
    settled: analyticsAllSettled,
  });

  const sections = useMemo(
    () => ({
      [InsightsSection.Delivery]: delivery.data,
      [InsightsSection.Utilization]: utilization.data,
      [InsightsSection.Agents]: agents.data,
    }),
    [agents.data, delivery.data, utilization.data]
  );
  const sourceGetTileAvailability = source.getTileAvailability;
  const getTileAvailability = useMemo(
    () => (tile: TileDescriptor) => {
      const payloadAvailability = sections[tile.section]?.tileAvailability;
      const payloadGitHubProvenance = getSectionGitHubProvenance(
        sections[tile.section]
      );
      if (!sourceGetTileAvailability) {
        return resolveMissingSourceTileAvailability({
          tileId: tile.id,
          section: tile.section,
        });
      }
      return sourceGetTileAvailability({
        tileId: tile.id,
        section: tile.section,
        scope,
        payloadAvailability,
        payloadGitHubProvenance,
      });
    },
    [scope, sections, sourceGetTileAvailability]
  );

  const recentItems = sessionsQuery.data?.items ?? [];

  // ISS-5061 (ISS-4779 closed-by-default): resolve the row gates ONCE and thread
  // the same value through the row ORDER and the render boundary, so the two
  // cannot disagree about whether a row exists. `visibleDashboardRows` drops a
  // gated-off row from the order, so the rows below close up instead of leaving
  // a blank slot; `DashboardRowContent` re-checks at the render boundary for a
  // caller that maps `DASHBOARD_ROWS` directly. Nothing else needs the gates:
  // a row that is not in the order never reaches the loading or skeleton path.
  const rowGates = useDashboardRowGates();
  const visibleRows = visibleDashboardRows({
    gates: rowGates,
    sections,
    sectionFailed,
    sectionLoading,
  });
  // The card under the stats row reads a DIFFERENT set of sections than that
  // row does, so it resolves its own verdict rather than borrowing one.
  const aiImpactState = resolveAiImpactState(sectionLoading, sectionFailed);
  const recentSessionsAnchor = recentSessionsAnchorRow(visibleRows);

  // Published from an effect, so a subscriber is told what this dashboard has
  // COMMITTED rather than what it is about to render: a listener that anchors
  // to the rows (the spotlight tour) measures the DOM, and the DOM only holds
  // them after the commit this runs at the end of.
  const contentState = resolveDashboardContentState({
    analyticsAllFailed,
    analyticsAllSettled,
    empty,
    emptyBodyShown: emptyBody !== null,
    orgHasNeverSynced,
    orgSessionHistoryPending,
    recentSessionsPending,
  });
  // An effect event, so the publish below fires on a change of STATE and never
  // on a change of listener. `onContentStateChange` is a public prop of a
  // shared component: today's only caller happens to pass a stable `setState`,
  // but an inline arrow is what the next one reaches for, and with the callback
  // in the deps that re-published the same state on every parent render.
  const publishContentState = useEffectEvent((state: DashboardContentState) => {
    onContentStateChange?.(state);
  });
  useEffect(() => {
    publishContentState(contentState);
  }, [contentState]);

  // Published once the utilization read settles either way, so a subscriber's
  // page_viewed is delayed by data, never held hostage by a failed read. An
  // effect event for the same listener-identity reason as the publish above.
  const utilizationSettled = utilization.isSuccess || utilization.isError;
  const utilizationData = utilization.data;
  const publishSessionVolumeReport = useEffectEvent(
    (report: DashboardSessionVolumeReport) => {
      onSessionVolumeReport?.(report);
    }
  );
  useEffect(() => {
    if (utilizationSettled) {
      publishSessionVolumeReport(
        deriveDashboardSessionVolumeReport(utilizationData, scope)
      );
    }
  }, [utilizationSettled, utilizationData, scope]);

  // The three bodies this page can draw, chosen here rather than by an early
  // return, so the header controls below render above ALL of them. They used to
  // sit inside the populated branch only, which left a reader whose PERSONAL
  // scope is empty on the empty state with no scope control — no way to reach
  // org data that the source was advertising (whitlockk, review of #8221). With both
  // shells defaulting to `Me` that is the first-load path for every light user,
  // and withholding the control that switches cohort because the current cohort
  // came back empty is exactly the affordance deletion root `AGENTS.md` forbids.
  let body: ReactNode;
  // Whether the chosen body grows to fill the page. Set in the branch that
  // needs it rather than re-derived beside the wrapper, so the two can't drift.
  let bodyFillsPage = false;
  if (analyticsAllFailed) {
    // Only when there is nothing at all to draw. Every other failure shape is a
    // row-level degradation below (ISS-10486).
    body = (
      <DegradedState message="Dashboard metrics are temporarily unavailable. Refresh to try again." />
    );
  } else if (emptyBody === null) {
    body = visibleRows.map((row) => {
      // Resolved ONCE per row: the slot below and the AI-impact card beside it
      // need the same answer, and two derivations are two answers.
      const rowState = resolveDashboardRowState(
        row,
        sectionLoading,
        sectionFailed
      );
      return (
        <div className="min-w-0" key={row.tour}>
          {/* The row anchor wraps the ROW and nothing else, matching the
                desktop shell. It used to sit on the keyed block above, which
                made the AI impact card and the Recent Sessions table children of
                it — so the `stats` spotlight measured all three at once and,
                with the heatmap absent, rang most of the page for a beat that
                says "start with the headline metrics". Nothing could see that
                until the tour had a client to open it (ISS-8351 / PLN-1875
                Step 8). */}
          <div
            // Withheld for a degraded row, the same way the sessions anchor
            // below is withheld for a failed read: `resolveDashboardTourSteps`
            // measures anchors, so a present one over an error card rings a
            // beat about data that is not there — and the tour host stamps
            // that run finished, permanently.
            data-tour={
              rowState === DashboardRowState.Failed
                ? undefined
                : ROW_TOUR_ANCHORS[row.tour]
            }
          >
            <DashboardRowSlot
              onRetry={() => retrySections(ROW_SECTIONS[row.tour])}
              retrying={isRowRetrying(row, sectionFetching)}
              row={row}
              state={rowState}
            >
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
            </DashboardRowSlot>
          </div>
          {row.tour === DashboardRowTour.Stats ? (
            <div
              className="mt-5"
              // The same withholding the rows above do, for the same reason:
              // `resolveDashboardTourSteps` MEASURES anchors and the host then
              // stamps the run finished, so a beat about how cost translates
              // into shipped value must not ring over a placeholder or over a
              // card two of whose four tiles are a `—`.
              data-tour={
                aiImpactState === DashboardRowState.Ready
                  ? DashboardTourAnchor.Impact
                  : undefined
              }
            >
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
          {row.tour === recentSessionsAnchor ? (
            <div
              className="mt-5"
              // The beat behind this anchor says "Open any session for the full
              // story". A failed read draws an error treatment where the table
              // would be, so the anchor is withheld rather than the whole run
              // cancelled: `resolveDashboardTourSteps` measures anchors, so a
              // missing one drops exactly that step and leaves the rest.
              data-tour={
                sessionsQuery.isError ? undefined : DashboardTourAnchor.Sessions
              }
            >
              <RecentSessions
                getSessionHref={getSessionHref}
                isError={sessionsQuery.isError}
                isLoading={recentSessionsPending}
                items={recentItems}
              />
            </div>
          ) : null}
        </div>
      );
    });
  } else {
    bodyFillsPage = true;
    body = (
      <DashboardReplacedBody
        action={emptyStateAction}
        description={emptyStateDescription}
        kind={emptyBody}
        onShowAllTime={() => setDateRange(DateRange.AllTime)}
      />
    );
  }

  // `min-h-0 flex-1` below only while the empty body is the one drawing: its own
  // wrapper grows an `EmptyState` whose DS primitive carries `flex-1`, and that
  // needs a growing ancestor chain. The populated and failed bodies size to
  // content exactly as they did when each was this component's root.
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-5",
        bodyFillsPage && "min-h-0 flex-1"
      )}
    >
      {/* FEA-2232: window picker — drives the KPI/chart insights only; Recent
          Sessions keeps its own 7d window (RECENT_SESSIONS_RANGE).
          FEA-4020: the single dashboard-wide "Refreshing" indicator sits beside
          the picker; a range/scope change refetches every widget at once, so it
          reads as one indicator here rather than a spinner on every row.
          ONE row, above every body — see the `body` comment above. */}
      <div className="flex min-w-0 items-center justify-start gap-3 overflow-x-auto sm:justify-end">
        <DashboardRefreshingIndicator refreshing={refreshing} />
        <DateRangeFilter
          onChange={setDateRange}
          ranges={DASHBOARD_DATE_RANGES}
          value={dateRange}
        />
        <DashboardScopeControl
          available={orgScopeAvailable}
          onValueChange={setScope}
          scope={scope}
        />
      </div>
      {body}
    </div>
  );
}

/**
 * The body a dashboard with nothing to draw renders.
 *
 * ISS-9727: the anchor the reduced tour rings. A zero-session org draws no row,
 * so without this the page the onboarding tour exists for is the one page it can
 * measure nothing on. The attribute itself renders nothing and the run that
 * reads it is gated at `DashboardTourHost`, so an unenrolled reader sees exactly
 * what they see today — but the WRAPPER is not free. `EmptyState` is the flex
 * child here and the DS `Empty` primitive carries `flex-1`, so a bare div takes
 * that growth away and drops the card back to its `min-h` floor with dead space
 * under it. The wrapper carries the same column so the card fills the page
 * exactly as it did before — which is why its host sets `min-h-0 flex-1` on the
 * page wrapper while this body is the one drawing.
 *
 * Extracted from the branch it used to be written inline in, when that branch
 * stopped being an early return: the host sits on the cognitive-complexity
 * ceiling and this body is pure presentation over two props.
 */
function DashboardEmptyBody({
  action,
  description,
}: Readonly<{ action?: ReactNode; description: string }>) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-tour={DashboardTourAnchor.GettingStarted}
    >
      <EmptyState
        action={action}
        className="min-h-[360px] rounded-xl border border-border/70 bg-card"
        description={description}
        icon={LayersIcon}
        title="No agent sessions yet"
      />
    </div>
  );
}

function RecentSessions({
  items,
  isLoading,
  isError,
  getSessionHref,
}: {
  items: AgentSessionListItem[];
  isLoading: boolean;
  isError: boolean;
  getSessionHref: (item: AgentSessionListItem) => string;
}) {
  return (
    <DashboardCard
      description={RECENT_SESSIONS_DESCRIPTION}
      title={WEB_RECENT_SESSIONS_TITLE}
    >
      {isLoading ? (
        // ISS-7514: a height-matched placeholder, like every rowmate's skeleton
        // — a centred line of text here would have been the one card on the
        // screen that resizes when it resolves, and the deferral makes it
        // resolve last rather than alongside. `aria-label` because the pulse is
        // purely visual, so a screen reader would otherwise be told nothing at
        // all about a card that is still filling.
        <Skeleton
          aria-label="Loading recent sessions"
          className="w-full rounded-lg"
          role="status"
          style={{ height: `${RECENT_SESSIONS_SKELETON_HEIGHT}px` }}
        />
      ) : null}
      {isError ? (
        <div className="py-8 text-center text-destructive text-sm">
          Recent sessions are temporarily unavailable.
        </div>
      ) : null}
      {isLoading || isError ? null : (
        <SyncedSessionsTable
          emptyState={
            <EmptyState
              className="py-12"
              description="No synced sessions have arrived yet."
              icon={Clock3Icon}
              title="No recent sessions"
            />
          }
          getSessionHref={getSessionHref}
          items={items}
          visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
        />
      )}
    </DashboardCard>
  );
}

/** ISS-11927: which body replaces the rows, when one does. */
const DashboardEmptyBodyKind = {
  /** The never-synced "No agent sessions yet" (or an unanswered count). */
  NoSessions: "no-sessions",
  /** The selected range hides sessions the reader has; offers "Show all time". */
  RangeHidesSessions: "range-hides-sessions",
} as const;
type DashboardEmptyBodyKind =
  (typeof DashboardEmptyBodyKind)[keyof typeof DashboardEmptyBodyKind];

/** The body that replaces the rows, picked by {@link useDashboardEmptyVerdict}. */
function DashboardReplacedBody({
  action,
  description,
  kind,
  onShowAllTime,
}: Readonly<{
  action?: ReactNode;
  description: string;
  kind: DashboardEmptyBodyKind;
  onShowAllTime: () => void;
}>) {
  if (kind === DashboardEmptyBodyKind.RangeHidesSessions) {
    return <DashboardRangeEmptyBody onShowAllTime={onShowAllTime} />;
  }
  return <DashboardEmptyBody action={action} description={description} />;
}

/**
 * The empty half of the page's verdict: the all-time read below, and what the
 * page draws once the pinned seven-day read has come back empty.
 *
 * ISS-11927. The range-hides-sessions body is only reachable on a page that is
 * already `empty` — a seven-day zero is implied by any wider window's zero, and
 * requiring it keeps that body from ever replacing a Recent Sessions card with
 * rows. The utilization KPI answers for the SELECTED range, which the pinned
 * seven-day read cannot. And a dormant org whose selected range DOES have
 * sessions (a pick wider than seven days, the KPI says so) draws its rows: the seven-day zero
 * used to replace them with "No agent sessions yet", which is also where "Show
 * all time" would otherwise have landed.
 */
function useDashboardEmptyVerdict({
  dateRange,
  empty,
  utilization,
  viewerScope,
}: {
  dateRange: DashboardDateRange;
  empty: boolean;
  utilization: {
    data?: UtilizationInsightsResponse;
    isPlaceholderData: boolean;
  };
  viewerScope: AgentSessionViewerScope;
}): {
  emptyBody: DashboardEmptyBodyKind | null;
  orgHasNeverSynced: boolean;
  orgSessionHistoryPending: boolean;
} {
  const {
    hasSessions: orgHistoryHasSessions,
    neverSynced: orgHasNeverSynced,
    pending: orgSessionHistoryPending,
  } = useOrgSessionHistory(viewerScope, empty);
  const windowSessionCount = utilizationWindowSessionCount(
    utilization.data,
    utilization.isPlaceholderData
  );
  // `undefined` = this render cannot decide; `null` = the rows.
  let decided: DashboardEmptyBodyKind | null | undefined = null;
  if (!empty) {
    decided = null;
  } else if (
    dashboardRangeHidesSessions({
      dateRange,
      windowSessionCount,
      hasSessionsOutsideWindow: orgHistoryHasSessions,
    })
  ) {
    decided = DashboardEmptyBodyKind.RangeHidesSessions;
  } else if (!orgHistoryHasSessions) {
    decided = DashboardEmptyBodyKind.NoSessions;
  } else if (utilization.isPlaceholderData) {
    // The org HAS sessions and the selected range's read is still in flight
    // (`keepPreviousData` keeps it isSuccess with the previous range's
    // payload). "No agent sessions yet" would be false, and the count cannot
    // answer yet, so the body the reader was looking at stays until it does —
    // the frame right after "Show all time", or after 7d to 30d (marisolashgrove,
    // review of #8982).
    decided = undefined;
  } else if (!((windowSessionCount ?? 0) > 0)) {
    // Rows only on a POSITIVE answer for the selected range. A settled payload
    // with no sessions KPI proves nothing, so the body stays as it was.
    decided = DashboardEmptyBodyKind.NoSessions;
  }
  const [held, setHeld] = useState<DashboardEmptyBodyKind | null>(null);
  if (decided !== undefined && decided !== held) {
    setHeld(decided);
  }
  const emptyBody = decided === undefined ? held : decided;
  return { emptyBody, orgHasNeverSynced, orgSessionHistoryPending };
}

/**
 * Whether this org has EVER synced a session, read over its whole history.
 *
 * ISS-9727 review (whitlockk, chatgpt-codex-connector). The Recent Sessions read
 * above is pinned to {@link RECENT_SESSIONS_RANGE}, so its zero total is a
 * statement about the last seven days and about nothing else: an org that
 * onboarded three weeks ago and paused produces the identical zero, the
 * identical empty body, and is a completely different population. This read
 * carries no date bound at all, which is the only thing that separates them.
 *
 * `enabled` gates it to a page that has already come back empty, so an ordinary
 * dashboard issues no extra request. `countOnly` marks it count-only for the
 * desktop-local source (the cloud route strips the hint — its `count()` is
 * already cheap); nothing reads its rows.
 *
 * NEVER-SYNCED IS ESTABLISHED, NEVER ASSUMED. A failed or unissued read leaves
 * `neverSynced` false, so the caller resolves to
 * {@link DashboardContentState.Quiet} and no consumer retires anything on a
 * count nobody got; `pending` keeps that caller on `Loading` while the answer is
 * still coming rather than guessing either way.
 */
function useOrgSessionHistory(
  viewerScope: AgentSessionViewerScope,
  enabled: boolean
): { hasSessions: boolean; neverSynced: boolean; pending: boolean } {
  const query = useAgentSessions(
    { countOnly: true, limit: ORG_SESSION_HISTORY_LIMIT, viewerScope },
    { enabled }
  );
  return {
    // ISS-11927: the established opposite — a settled read with rows. A failed
    // or unissued read is neither, and leaves the empty body as it was.
    hasSessions: query.isSuccess && (query.data?.total ?? 0) > 0,
    neverSynced: query.isSuccess && (query.data?.total ?? 0) === 0,
    // Settled-or-not, for the same reason `recentSessionsPending` is: TanStack
    // reports a query it has not been allowed to start as pending-and-idle, so
    // a read that was never ISSUED must not read as one still coming.
    pending: !(query.isSuccess || query.isError),
  };
}
