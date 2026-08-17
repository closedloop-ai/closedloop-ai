import { costFilterIncludesUnknown } from "@repo/api/src/agent-session-filters";
import { SessionsRecoveryAction } from "@repo/app/agents/components/sessions/sessions-recovery-action";
import { SessionsSummaryCards } from "@repo/app/agents/components/sessions/sessions-summary-cards";
import { SessionsToolbar } from "@repo/app/agents/components/sessions/sessions-toolbar";
import {
  useAgentSessionAnalytics,
  useAgentSessionsPageData,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { useHasConnectedAgent } from "@repo/app/agents/hooks/use-has-connected-agent";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import {
  hasAnyActiveSessionFacet,
  parseSessionFacetFilterParams,
  type SessionFacetFilters,
  writeSessionFacetFilterParams,
} from "@repo/app/agents/lib/session-filter-adapter";
import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import { sessionsRangeReadout } from "@repo/app/agents/lib/sessions-range-readout";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useReplaceListParams } from "@repo/app/shared/hooks/use-replace-list-params";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
  dateRangeToLookbackDays,
  getStableUtcDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import { TablePaginationFooter } from "@closedloop-ai/design-system/components/ui/table-pagination-footer";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData } from "@tanstack/react-query";
import { Profiler, useCallback, useEffect, useRef, useState } from "react";
import {
  DesktopAuthStatus,
  type DesktopBrowserSignInResult,
} from "../../../shared/contracts";
import {
  DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
  DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
} from "../../../shared/feature-flags";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../shared/local-session-source-status";
import { RendererRenderView } from "../../../shared/render-commit-event";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { signInFailureMessage } from "../../shared-agent-sessions/desktop-sign-in-copy";
import { DASHBOARD_METRIC_CARD_CLASS_NAME } from "../layout/page-shell";
import { AgentCoachingTips } from "./agent-coaching-tips";
import { SessionsFileAccessBanner } from "./sessions-file-access-banner";
import {
  buildSessionsRenderModel,
  canFetchSessionsAuxiliaryData,
  needsAnalyticsRepositoryFallback,
  PAGE_SIZE,
} from "./sessions-render-model";
import {
  deriveSessionsAvailability,
  resolveLocalSummaryCardsProps,
  resolveSummaryCardsErrored,
  type SessionsDisplayState,
  useSessionsImportProgress,
} from "./sessions-summary-cards-state";
import {
  isSessionComparisonEnabled,
  resolveSessionSummaryDeltas,
  sessionComparisonQuery,
  sessionSummaryScopeKey,
  useSessionComparisonSuppressed,
} from "./sessions-summary-comparison";
import { SessionsSyncProgressBanner } from "./sessions-sync-progress-banner";
import { SessionsTableBody } from "./sessions-table-body";
import {
  areTransientRetriesExhausted,
  classifyListReadErrorState,
  readUsageErrorFlags,
  useUsageTransientRecovery,
} from "./sessions-transient-read-state";
import {
  collapseStartingWhenDataHeld,
  getSessionsDisplayState,
  useLocalSessionSourceStatus,
  useSessionsReadGate,
} from "./sessions-view-source-status";
import { useDesktopLinkedEntityColumns } from "./use-desktop-linked-entity-columns";
import { useLocalAgentSessionUsage } from "./use-local-agent-session-usage";
import {
  resolveSessionsListCause,
  type SessionsListCauseInputs,
  useRenderCommitInstrumentation,
} from "./use-render-commit-instrumentation";
import { useSessionsListRecovery } from "./use-sessions-list-recovery";

const PAGE_PARAM = "page";
// The list-URL search term (a global search box outside this view writes it).
// Named so the read site and the clear-filters strip reference the same key.
const SEARCH_PARAM = "search";
// Five summary cards (FEA-4126, reverting FEA-3574's six-card set back to the
// FEA-3937 layout: Sessions, Total Tokens, Cost, PRs Shipped, LOC / $).
// Median PR Size was removed from the Sessions bar — six cards wrapped to a second
// row at the desktop viewport and read as broken; it stays on the Branches bar.
//
// ISS-4787 follow-up: the column count is DERIVED from the shared
// `--summary-card-min` floor that `SummaryCardRow` publishes, not pinned at three
// then five. The hard tiers squeezed each card under that floor, so
// "Non-subscription Cost" broke onto a third line and its value fell a line below
// the rest of the rank. The strip's track arithmetic and every width it derives
// from live on `src/shared/window-defaults.ts`; do not restate them here.

/** Desktop wrapper for the shared sessions list content and local adapter. */
export function SessionsView() {
  const agentCoachingTipsEnabled = useFeatureFlagEnabled(
    DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY
  );
  // ISS-4901: gates the horizontal scroll affordance on the list's scroll
  // region, under the same key as the rest of the Sessions fold legibility pass.
  const foldLegibilityEnabled = useFeatureFlagEnabled(
    DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY
  );
  // ISS-6041: the shared Grid Parity key gates the summary cards' delta chips
  // here, closed by default like every other perceivable desktop addition. It is
  // the same key the web page resolves `comparisonV2Enabled` from, but web is not
  // gated identically — see `isSessionComparisonEnabled` for exactly what that
  // does and does not make equal.
  const gridTableV2Enabled = useFeatureFlagEnabled(
    DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY
  );
  const searchParams = useSearchParamsValue();
  const search = searchParams.get(SEARCH_PARAM)?.trim() || undefined;
  const page = parseSessionsPage(searchParams.get(PAGE_PARAM));
  // FEA-3560: seeded from the list URL (the facet params are mirrored into the
  // URL on every change below). Opening a session detail unmounts this view, so
  // returning via the breadcrumb's `lastNavHref` — which preserves the list
  // query — restores the active facet filters along with page/search.
  const [facetFilters, setFacetFilters] = useState<SessionFacetFilters>(() =>
    parseSessionFacetFilterParams(searchParams)
  );
  const { dateRange, setDateRange } = useSharedDateRange("desktop");
  // FEA-3722: thread the selected 7d/30d/90d/All range into the coaching /
  // Coding-Wrap analytics load so the Wrap windows to the same range (null =
  // all-time) and re-loads when the top selector changes.
  const coachingLookbackDays = dateRangeToLookbackDays(dateRange);
  const {
    sortKey,
    sortDir,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    setSort,
    toggleColumn,
    resetView,
    groupBy,
    setGroupBy,
  } = useSessionsViewState("sessions:desktop");
  const { status: localSessionSourceStatus, recheck: recheckLocalSource } =
    useLocalSessionSourceStatus();
  const canReadLocalSessions =
    localSessionSourceStatus === LOCAL_SESSION_SOURCE_STATUSES.ready;
  // PLN-1138 Phase 2: in cloud mode the Sessions views read the HTTP source over
  // the D-G bridge, not the local SQLite monitor — so cloud reads must NOT be
  // gated on local-monitor readiness (an unavailable/initializing local monitor
  // would otherwise block an authenticated+online user from cloud rows).
  // `canReadSessions` is the mode-aware read gate; `localSessionSourceStatus`
  // still drives the local-mode "starting"/"unavailable" display states below.
  const mode = useDesktopAppCoreMode();
  const isCloudMode = mode === DesktopAppCoreMode.Cloud;
  // FEA-4128 / ISS-4444: poll the shared boot-import progress ("Importing your
  // agent history N/M" + the "N transcripts couldn't be read" quarantine count)
  // in BOTH modes. ISS-4772 (wongk cid 3696061972 / logical-QA): keep this read
  // active while the local source is still "starting", not only once reads are
  // enabled — the poll wrapper resets its snapshot to null whenever disabled, so
  // gating it behind the read gate made the `ingestComplete` heal arm below
  // unreachable in the exact latched-"starting" state it targets. Polling during
  // "starting" lets the boot-import-complete signal actually land. The poll
  // self-terminates once the import settles, so this adds no runaway polling.
  const ingestProgress = useSessionsImportProgress(
    isCloudMode ||
      canReadLocalSessions ||
      localSessionSourceStatus === LOCAL_SESSION_SOURCE_STATUSES.starting
  );
  const ingestComplete = ingestProgress?.complete === true;
  // ISS-4772 (wongk/codex/logical-QA): the mode-aware read gate, latched open once
  // the local source is proven up (ever-ready OR boot-import-complete) so it does
  // not flap off when a healthy source latches back to "starting" after a dropped
  // `getAgentMonitorUrl` transition. The gate latches on the SAME two signals that
  // collapse the display state below, so the read and the display can never
  // disagree about whether the source is up (a "ready" label over a disabled query
  // that never read is exactly the false-empty this closes).
  const canReadSessions = useSessionsReadGate({
    isCloudMode,
    canReadLocalSessions,
    ingestComplete,
  });
  // FEA-3574: the cloud-only delivery cards' auth axis is the durable session,
  // NOT the app-core mode. `Authenticated` (independent of connectivity) means
  // signing in wouldn't unlock more data, so authenticated-but-offline lands the
  // delivery cards in the neutral no-CTA empty (state 3), not the signed-out CTA
  // (state 2) — matching `resolveDesktopAppCoreMode`, which drops an offline
  // authenticated renderer back to Local. `beginSignIn` powers the state-2 CTA;
  // web is always inside an authenticated route so it never passes either prop.
  //
  // Only the TERMINAL signed-out statuses route the delivery cards to the
  // sign-in CTA (state 2). The transient statuses — `Loading` (pre-restore) and
  // the in-flight `OpeningBrowser`/`AwaitingRedirect`/`Exchanging` — are NOT
  // signed-out: showing the CTA there would tell a restoring user to sign in on
  // startup, and leave all three CTA buttons live mid-OAuth (a second click only
  // yields `already_in_progress`). Treat every non-terminal-signed-out status as
  // "not signed out" so those states render the neutral empty (state 3) instead.
  const { state: authState, beginSignIn } = useDesktopAuth();
  const isAuthenticated = !isDesktopAuthSignedOut(authState.status);
  // FEA-4209 / FEA-4210 (wongk review): the linked-entity columns' host opt-in.
  // Cloud mode reads the same HTTP list the web app does, so its rows carry
  // `project` and `linkedArtifacts`; local mode's producer emits neither. The
  // gate is therefore the MODE, not the surface.
  const linkedEntityColumns = useDesktopLinkedEntityColumns(
    isCloudMode,
    authState
  );
  // FEA-4037 (P2 review): on `RefreshFailed` the app-level
  // `DesktopSessionExpiredBanner` already owns the sign-in ask globally, so the
  // Sessions bar must NOT hoist a second banner beneath it. Suppress the hoisted
  // prompt there (the delivery cards still fall to their neutral dash); the plain
  // `SignedOut` case keeps its single hoisted banner.
  const signInPromptSuppressed = isDesktopSessionExpired(authState.status);
  // FEA-3574 review (ZVH): the KPI-card sign-in CTA + its retryable error state.
  // The error is gated to the signed-out state inside the hook, so a success
  // (which flips `isAuthenticated`) drops any stale copy.
  const { signInError, handleSummarySignIn } = useDesktopSummarySignIn(
    beginSignIn,
    isAuthenticated
  );
  // PRD-536 §5: onboarding-vs-filters empty state. In cloud mode we probe the
  // org-scoped compute-target list (an empty org has never connected an agent).
  // In local mode the local monitor *is* the connected agent, so an empty local
  // list is a filters/date result, never an un-onboarded org — force `true` and
  // skip the cloud probe (a local-only desktop has no authenticated cloud read).
  const hasConnectedAgent = useDesktopHasConnectedAgent(isCloudMode);
  // FEA-3560: one shared writer for every list-URL write. It re-asserts the
  // facet params on each call (from the filters argument), so a pagination or
  // sort click landing right after a facet change cannot copy a stale snapshot
  // and silently drop the facets from the hash URL.
  const replaceListParams = useReplaceListParams(
    writeSessionFacetFilterParams,
    writeSessionsPage
  );
  const setPage = useCallback(
    (nextPage: number) => replaceListParams(facetFilters, nextPage),
    [replaceListParams, facetFilters]
  );

  // Reset pagination when dateRange changes — covers both local toolbar changes
  // AND cross-tab StorageEvent updates from Dashboard/Branches.
  const dateRangeRef = useRef(dateRange);
  useEffect(() => {
    if (dateRangeRef.current !== dateRange) {
      dateRangeRef.current = dateRange;
      setPage(0);
    }
  }, [dateRange, setPage]);

  // UTC-day quantization keeps the query identity stable across remounts while
  // recalculating on render lets a mounted view advance after a UTC rollover.
  const { startDate, endDate } = getStableUtcDateWindowForRange(dateRange);

  // PLN-1034: the default sort is now lastActivity-desc, so `sortBy`/`sortDir`
  // are sent on the initial render (not only after a header click). A null
  // `sortKey` (e.g. a restored saved view) still omits them and keeps the local
  // source on its fast paginated path.
  const facetQuery = buildFacetQuery(facetFilters);
  // FEA-4157: the Sessions table and its prop-driven summary metric cards share
  // ONE combined list + usage read (mirroring the Branches view's
  // `useBranchesPageData`), so the paginated list and the facet-scoped summary
  // aggregate come from one raw scan instead of two independent IPC reads of the
  // same rows. The usage half aggregates the whole filtered set — the desktop
  // metadata-only SQL COUNT/SUM/GROUP BY, never a full-corpus hydrate — and
  // ignores the list's pagination/sort fields, so the same `listFilters` drives
  // both halves. FEA-4192: the combined read reconciles the summary session COUNT
  // with the quality-gated list total — see the rationale (and the desktop-vs-web
  // basis asymmetry) at the source in `getSharedAgentSessionsPageData`
  // (shared-agent-sessions-api.ts). `keepPreviousData` keeps the last page + cards
  // on screen while a filter/page/sort change loads.
  // ISS-6041: whether this surface compares periods at all — the producer axis
  // (Cloud reads the same HTTP source the web page does; the local SQLite
  // producer has no prior-window read) and the Grid Parity rollout axis. See the
  // helper for why both are load-bearing.
  const sessionComparisonEnabled = isSessionComparisonEnabled({
    isCloudMode,
    comparisonV2Enabled: gridTableV2Enabled,
  });
  const pageDataFilters = {
    ...facetQuery,
    endDate,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    search,
    startDate,
    ...(sortKey ? { sortBy: sortKey, sortDir } : {}),
    ...sessionComparisonQuery(sessionComparisonEnabled),
  };
  const pageDataQuery = useAgentSessionsPageData(pageDataFilters, {
    enabled: canReadSessions,
    placeholderData: keepPreviousData,
  });
  // ISS-6041: a page turn or a re-sort churns this query's key without changing
  // the summary scope the comparison describes, so the held snapshot stays
  // honest across it — see the hook for why desktop needs the narrowing web gets
  // for free.
  const comparisonSuppressed = useSessionComparisonSuppressed({
    read: pageDataQuery,
    summaryScopeKey: sessionSummaryScopeKey(pageDataFilters),
  });
  // List-shaped view over the combined read for the table + pagination glue.
  const sessionsQuery = {
    data: pageDataQuery.data?.list,
    isLoading: pageDataQuery.isLoading,
    isError: pageDataQuery.isError,
    isFetching: pageDataQuery.isFetching,
    isPlaceholderData: pageDataQuery.isPlaceholderData,
  };
  // ISS-6005 scope 4: the toolbar's read-source pill is a strict drop, so this
  // view no longer derives badge copy for it. `useCloudReadCutoverBadge` itself
  // stays — the Dashboard header still mounts it, and the underlying cutover
  // DECISION machinery (ISS-5714) is untouched.
  // ISS-4483: classify a settled list read error as TRANSIENT (the local db-host
  // child crash-looping / restarting mid-backfill — ISS-4476 / ISS-4474 / ISS-4410)
  // vs a genuine persistent failure, and fold that into both the table's
  // syncing-vs-error routing and the summary cards' error signal (see the helper).
  // The shared query client already auto-retries a transient error with bounded
  // backoff; once it settles still-errored we route it to the quiet "reconnecting /
  // still importing" surface instead of the hard error card. Only a persistent
  // failure surfaces the hard error + Retry.
  // ISS-4483 (review cid 3679535437): the quiet reconnecting surface must have a
  // way out. A transient error only stays "syncing" (no error chrome, no Retry)
  // while the shared query client is still auto-retrying it. Once the bounded
  // retries are exhausted and the read has settled still-errored with no fetch in
  // flight, it is a wedged transient — fall through to the hard error + Retry so
  // the user has a move to make instead of an infinite skeleton.
  const transientRetriesExhausted = areTransientRetriesExhausted({
    isError: pageDataQuery.isError,
    fetchStatus: pageDataQuery.fetchStatus,
    failureCount: pageDataQuery.failureCount,
  });
  // ISS-4483 (review cid 3679616168, wongk): a TRANSIENT usage-half failure (the
  // list won the race, so the combined read RESOLVED with `usage` omitted and
  // `usageErrorTransient: true`) is recovered by a bounded manual refetch OUTSIDE
  // react-query's own retry — see the hook. Its `usageRecoveryExhausted` closes the
  // transient-usage window (mirroring the list path's `transientRetriesExhausted`)
  // so a wedged transient usage failure falls through to the honest dash instead of
  // an infinite reconnecting skeleton. The candidate is the raw transient-usage
  // condition before exhaustion, so the hook owns the edge without a cycle.
  const usageErrorFlags = readUsageErrorFlags(pageDataQuery.data);
  const { usageRecoveryExhausted } = useUsageTransientRecovery({
    usageError: usageErrorFlags.usageError,
    usageErrorTransient: usageErrorFlags.usageErrorTransient,
    refetch: pageDataQuery.refetch,
  });
  const { isListErrorTransient, metricReadErrored, transientReadWithoutUsage } =
    classifyListReadErrorState({
      isListError: pageDataQuery.isError,
      listError: pageDataQuery.error,
      usageError: usageErrorFlags.usageError,
      hasSummaryUsage: usageErrorFlags.hasSummaryUsage,
      usageErrorTransient: usageErrorFlags.usageErrorTransient,
      transientRetriesExhausted,
      usageRecoveryExhausted,
    });

  const canFetchAuxiliaryData = canFetchSessionsAuxiliaryData({
    canReadSessions,
    hasSessionsData: Boolean(sessionsQuery.data),
    isFetching: sessionsQuery.isFetching,
    isPlaceholderData: sessionsQuery.isPlaceholderData,
  });

  // ISS-5283 (wongk review): the facet-option lists read the ACTIVE-FILTER usage
  // half of the combined page read. They used to read a separate, facet-
  // UNFILTERED request instead — the only way, before this, to stop an active
  // Owner selection collapsing the Owner options — but that made every OTHER
  // facet's counts describe the unfiltered corpus while the table described the
  // filtered one. `getSharedAgentSessionsPageData` now scopes each filtered
  // facet's breakdown to every OTHER active filter while lifting its own
  // dimension (`shared-agent-sessions-facet-usage.ts`, the twin of the cloud
  // service's `facet-count-where.ts`), so one response serves both halves and
  // the second request — with its own warm-up window where the toolbar had to
  // fall back to stale data mid-interaction — is gone. ONE value now feeds both
  // the summary cards and the facet option lists.
  const summaryUsage = pageDataQuery.data?.usage;
  // ISS-6041: the producer's period-over-period percentages, mapped onto the same
  // shared cards the web page hands them to — or nothing, on a surface that does
  // not compare.
  const summaryDeltas = resolveSessionSummaryDeltas({
    dateRange,
    enabled: sessionComparisonEnabled,
    suppressed: comparisonSuppressed,
    usage: summaryUsage,
  });
  const metricUsageQuery = pageDataQuery;
  // In Cloud mode the delivery `usage` above reads the cloud HTTP source, and the
  // table beneath aggregates that same cloud population. Read the LOCAL SQLite
  // totals SEPARATELY here — straight from the local IPC source, regardless of the
  // mode-swapped delivery source — and pass them as the always-available cards'
  // FAILURE FALLBACK (ISS-4429): the cards read the cloud `usage` so they reconcile
  // with the visible rows, and use these local totals ONLY when the cloud read has
  // failed (FEA-3574's intent — a cloud read failure never blanks a metric SQLite
  // can compute — without the earlier steady-state divergence where local totals
  // overrode a healthy cloud read and blanked the cards to 0 while the table was
  // full). Only needed in Cloud mode: in Local mode the delivery `usage` IS the
  // local source already.
  //
  // ISS-4429 (wongk review): the fallback must be REACHABLE on a fresh cloud
  // failure. `canFetchAuxiliaryData` gates on the cloud list having SETTLED with
  // data, so when the cloud `pageData` REJECTS on first load it stays false and
  // the local read would never fire — leaving the cards with neither cloud
  // `usage` nor `localUsage`, so they dash instead of falling back. Drive the
  // enable from the actual fallback state: fetch the local totals whenever the
  // cloud aux read is ready to warm the cache OR the cloud metric read has
  // ERRORED (the exact moment the cards need the fallback). `canReadSessions`
  // still bounds it so a not-yet-authorized surface issues no read.
  const localFallbackReadEnabled =
    isCloudMode &&
    canReadSessions &&
    (canFetchAuxiliaryData || metricReadErrored);
  const localSummaryUsageQuery = useLocalAgentSessionUsage(
    { ...facetQuery, search, startDate },
    { enabled: localFallbackReadEnabled }
  );
  const localSummaryCards = resolveLocalSummaryCardsProps({
    isCloudMode,
    canFetchAuxiliaryData,
    localUsageData: localSummaryUsageQuery.data,
    localUsageIsError: localSummaryUsageQuery.isError,
    ingestProgress,
  });
  // The Repository filter facet needs a per-repository rollup. Usage OWNS it
  // (FEA-4299); the analytics aggregate (FEA-2038) resolves the same identity
  // and survives only as the legacy fallback for a usage summary that reports
  // no repositories at all. Window-scoped but facet-unfiltered so the options
  // stay stable as the user toggles filters.
  //
  // ISS-5273: gate the read on the fallback actually being consumed. This is the
  // same predicate `buildSessionsRenderModel` folds with, so a usage summary that
  // already owns repositories issues no analytics read instead of paying for one
  // it discards — measured at 27.1s (`syncSource.aggregateAnalytics`) on a real
  // 4,285-session corpus, landing squarely on the first page turn. When the
  // fallback IS needed the read still fires immediately: the facet has no options
  // without it, so deferring that case would only withhold data the user needs.
  const analyticsQuery = useAgentSessionAnalytics(
    { search, startDate },
    {
      enabled:
        canFetchAuxiliaryData && needsAnalyticsRepositoryFallback(summaryUsage),
      placeholderData: keepPreviousData,
    }
  );

  const handleFiltersChange = (next: SessionFacetFilters) => {
    setFacetFilters(next);
    replaceListParams(next, 0);
  };
  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    setPage(0);
  };
  // FEA-4181: is any filter narrowing the list — a non-default date window, a
  // facet selection, or a search term? Drives the filtered-vs-genuinely-empty
  // distinction in the honest empty state.
  const hasActiveSessionFilters =
    dateRange !== DEFAULT_DATE_RANGE ||
    Boolean(search) ||
    hasAnyActiveSessionFacet(facetFilters);
  const handleSort = (column: string, direction: SortDirection) => {
    setSort(column as SessionSortKey, direction as SessionSortDir);
    setPage(0);
  };

  // Cloud mode has no local monitor to be "starting"/"unavailable"; the cloud
  // query's own isLoading/isError/data drive the table, so collapse to "ready".
  // ISS-4772: in local mode, collapse a latched "starting" to "ready" once the
  // page-data read already holds rows (or the boot import has been observed
  // complete). After long uptime a dropped `getAgentMonitorUrl` transition can
  // leave `localSessionSourceStatus` stuck on "starting" while the backend and
  // the query are healthy — which blanks the whole body to an infinite "Loading"
  // even though the data is in hand. Held data always wins over the stale label;
  // the "unavailable"/errored branch is untouched (never overridden to "ready").
  const rawDisplayState = isCloudMode
    ? "ready"
    : getSessionsDisplayState(localSessionSourceStatus);
  const displayState = collapseStartingWhenDataHeld({
    rawDisplayState,
    // ISS-4772 (wongk review): only rows in hand from the ACTIVE query key count
    // as held data. `keepPreviousData` keeps the prior key's rows on screen as
    // `isPlaceholderData` while a filter/page change loads — promoting on those
    // would let the table claim "ready" over a scope it has not read yet.
    hasHeldListData:
      sessionsQuery.data !== undefined && !sessionsQuery.isPlaceholderData,
    ingestComplete,
  });
  const renderModel = buildSessionsRenderModel({
    displayState,
    sessionsData: sessionsQuery.data,
    facetUsage: summaryUsage,
    repositoryBreakdown: analyticsQuery.data?.byRepository,
  });
  const isListRefreshingWithPreviousData =
    sessionsQuery.isPlaceholderData && sessionsQuery.isFetching;

  // FEA-1998: render-commit timing for the sessions list. The cause is derived
  // from which of these tracked inputs changed since the previous commit; the
  // item count is the number of rows being committed.
  const renderCommitInputs: SessionsListCauseInputs = {
    page,
    search,
    statuses: facetFilters.statuses,
    repositories: facetFilters.repositories,
    sortKey,
    sortDir,
    dateRange: String(dateRange),
    isBackgroundRefetch: isListRefreshingWithPreviousData,
  };
  const onRenderCommit = useRenderCommitInstrumentation({
    view: RendererRenderView.SessionsList,
    itemCount: renderModel.sessions.length,
    causeInputs: renderCommitInputs,
    resolveCause: resolveSessionsListCause,
  });
  const tableLoadingLabel = getSessionsTableLoadingLabel({
    displayState,
    hasData: renderModel.hasRenderableData,
    isInitialLoading: sessionsQuery.isLoading,
    isRefreshingWithPreviousData: isListRefreshingWithPreviousData,
    search,
  });
  const isMetricDataRefreshing = getMetricDataRefreshingState({
    canFetchAuxiliaryData,
    hasData: Boolean(summaryUsage),
    isError: metricReadErrored,
    isFetching: metricUsageQuery.isFetching,
    isPlaceholderData: metricUsageQuery.isPlaceholderData,
  });
  useEffect(() => {
    if (!canReadSessions || sessionsQuery.isFetching || !sessionsQuery.data) {
      return;
    }

    const clampedPage = clampSessionsPage(page, renderModel.total, PAGE_SIZE);
    if (clampedPage !== page) {
      setPage(clampedPage);
    }
  }, [
    canReadSessions,
    page,
    sessionsQuery.data,
    sessionsQuery.isFetching,
    setPage,
    renderModel.total,
  ]);

  // FEA-3937: the shared summary bar skeletons while the local source is still
  // starting or the metric read is in its initial load; the "—" placeholder is
  // set when the local source is unavailable.
  // FEA-4177 parity: the card skeleton is gated on the summary read's OWN state
  // (`isMetricDataRefreshing`), NOT on the table's loading state. The summary
  // aggregate is scope-stable across pagination/sort/search, so folding in the
  // table's loading state grey-flashed all five cards on every page/sort/search
  // click even though their numbers cannot change — matching the web page, which
  // drives the cards off the summary query's own `isLoading` independent of the
  // table.
  //
  // wongk review: `isMetricDataRefreshing` drops the one true initial-load
  // signal. While the combined `pageData` read is on its FIRST fetch,
  // `canFetchAuxiliaryData` is still false (it gates on the list having settled),
  // so `getMetricDataRefreshingState` short-circuits to false and the cards
  // render zeroed Sessions/Total Tokens beside a loading table. Gate on
  // `pageDataQuery.isLoading` directly for that first load — it is the summary
  // read's own initial-load flag and stays false for the page/sort placeholder
  // refetches this parity change is meant to quiet.
  // ISS-4483: a settled TRANSIENT read error (db-host restarting mid-backfill) is
  // excluded from `metricReadErrored` so the always-available cards don't dash to a
  // destructive "—". `transientReadWithoutUsage` (from `classifyListReadErrorState`)
  // holds them instead: review cid 3679535439 asks us to HOLD THE LABELS and
  // skeleton only the values, so it feeds the value-only skeleton
  // (`alwaysAvailableLoading`) below, NOT the full-row `isLoading` (five grey slabs
  // that drop the labels and reflow the row on recovery). Each card keeps its label
  // + info popover and shimmers only its number; if we already hold `summaryUsage`
  // we keep rendering it (like the table keeping last-good rows). The read
  // auto-retries, so the skeleton clears on its own.
  const areSummaryCardsLoading =
    displayState === "starting" ||
    pageDataQuery.isLoading ||
    isMetricDataRefreshing;
  const areSummaryCardsErrored = resolveSummaryCardsErrored({
    displayState,
    metricReadErrored,
    hasSummaryUsage: summaryUsage !== undefined,
  });
  // FEA-4181: the table body's unavailable/syncing/loading trio (see the helper
  // for the errored-vs-syncing split) — derived out of the JSX.
  const {
    isUnavailable: isSessionsUnavailable,
    isSyncing: isSessionsSyncing,
    isTableLoading: isSessionsTableLoading,
  } = deriveSessionsAvailability({
    displayState,
    isListError: sessionsQuery.isError,
    isListErrorTransient,
    isListLoading: sessionsQuery.isLoading,
  });

  // FEA-3639: bound the blocking (no-rows-yet) load so it can never sit on an
  // infinite skeleton — the reported stall. Reuses the FEA-4181 availability
  // signals: `isBlockingLoad` is the exact condition under which the table shows
  // a full-body spinner — loading, no rows to fall back on, and NOT the settled
  // unavailable/error state (which owns its own honest-empty surface). The
  // keep-previous refresh (still has rows) is excluded; it never blanks the table.
  const isBlockingLoad =
    isSessionsTableLoading &&
    !renderModel.hasRenderableData &&
    !isSessionsUnavailable;
  // ISS-4534 / FEA-3639: the list-recovery concern (Clear filters, Retry, and the
  // soft/hard stall escalation) lives in its own hook so this grandfathered view
  // stays small. `handleClearFilters` is the honest "reload" behind the errored
  // empty's recovery Link; `handleRetry` re-arms the stall detector for a wedged
  // load; `stallPhase` drives the spinner→retry→error escalation.
  const { handleClearFilters, handleRetry, stallPhase } =
    useSessionsListRecovery({
      isBlockingLoad,
      recheckLocalSource,
      refetchPageData: pageDataQuery.refetch,
      replaceListParams,
      searchParam: SEARCH_PARAM,
      setDateRange,
      setFacetFilters,
    });
  // ISS-4534: the errored-empty recovery affordance — the single primary action
  // for a settled read error, "Clear filters and reload". A plain click clears
  // this view's facet/date/search state, re-issuing the read via the query-key
  // change (NOT a `refetch()` on the pre-clear key, which would re-run the failing
  // narrowed scope the user is escaping); the `href` (the clean `hrefForNavId`
  // Sessions root) still opens a working list in a new tab on a modified click,
  // which the shared component guards so it never wipes the current tab's scope.
  const sessionsRecoveryAction = (
    <SessionsRecoveryAction
      href={hrefForNavId(NavId.Sessions)}
      onClearFilters={handleClearFilters}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Filter bar — flush to the top of the content area with a full-width
          bottom border. Fixed (outside the scroll region) so it always stays. */}
      <div className="shrink-0 border-b px-4 py-3">
        <SessionsToolbar
          dateRange={dateRange}
          filters={facetFilters}
          groupBy={groupBy}
          // FEA-4209 / FEA-4210 (wongk review): the View-menu entries for the
          // linked-entity columns follow the same mode gate the columns
          // themselves do, so the menu can never offer a toggle for a track this
          // surface will not render.
          includeLinkedEntityColumns={
            linkedEntityColumns.showLinkedEntityColumns
          }
          onClearFilters={handleClearFilters}
          onDateRangeChange={handleDateRangeChange}
          onFiltersChange={handleFiltersChange}
          onGroupByChange={setGroupBy}
          // ISS-5975: no manual Refresh control here any more. One combined read
          // still backs both the table and the cards, so they cannot land on
          // different populations — what re-triggers it is the
          // `desktop:db:changed` push bridge plus the FEA-2187 list poll, which
          // this surface has always had, rather than a button.
          onResetView={resetView}
          onToggleColumn={toggleColumn}
          usage={renderModel.usage}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* FEA-3639: pinned prompt when the OS is blocking reads of a harness
          transcript root — an explicit "waiting on file access" instead of a
          silently empty list. Renders nothing when nothing is blocked. */}
      <SessionsFileAccessBanner />

      {/* ISS-5489 (PLN-1694 M2): acknowledges the sync the post-auth consent
          takeover just authorized — the level chosen, the org it goes to, and
          the real backlog draining. Renders nothing on every launch that did not
          answer that question, which is every launch once it has been answered
          and all of them while the `guest-onboarding` flag is off. */}
      <SessionsSyncProgressBanner />

      {/* Scroll region — cards + table share one bounded scroll container (both
          axes). The cards scroll up and away; the GridTable's sticky column
          header then pins to the top of the region, right under the filter bar.
          ISS-4901: the horizontal scrollbar is what tells the user the table
          continues past the pane, and on macOS default settings it is an overlay
          bar that is INVISIBLE at rest — so this region is gated onto the same
          `scrollbar-overlay` utility the app sidebar and this table's other host
          (`synced-sessions-table.tsx`) already use, which styles the thumb and
          keeps it on screen. */}
      <div
        aria-busy={
          tableLoadingLabel && stallPhase !== "hard" ? "true" : undefined
        }
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          // The desktop pane is narrower than the web content area, so MORE of
          // the table lives past the fold here. Same gate as web (byte-equal
          // key, Labs toggle) so the cue can't appear on one surface and not the
          // other.
          foldLegibilityEnabled && "scrollbar-overlay"
        )}
      >
        {/* `sticky left-0` pins the cards to the left during horizontal scroll
            (so the wide table scrolls under them) while they still scroll away
            vertically. */}
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          {agentCoachingTipsEnabled ? (
            <AgentCoachingTips lookbackDays={coachingLookbackDays} />
          ) : null}

          <SessionsSummaryCards
            alwaysAvailableLoading={localSummaryCards.alwaysAvailableLoading}
            authenticated={isAuthenticated}
            cardClassName={DASHBOARD_METRIC_CARD_CLASS_NAME}
            // ISS-4481: honest-empty the Cost tile when the Unknown cost facet is
            // active (every row shows "—"), matching the web adapter (stage review).
            costUnknownActive={costFilterIncludesUnknown(
              facetFilters.costBuckets
            )}
            couldNotImportLabel={localSummaryCards.couldNotImportLabel}
            deltas={summaryDeltas}
            importInProgress={localSummaryCards.importInProgress}
            isError={areSummaryCardsErrored}
            isLoading={areSummaryCardsLoading}
            isLocalError={localSummaryCards.isLocalError}
            localUsage={localSummaryCards.localUsage}
            onSignIn={handleSummarySignIn}
            signInError={signInError}
            signInPromptSuppressed={signInPromptSuppressed}
            transientRecovering={transientReadWithoutUsage}
            usage={summaryUsage}
            wrapBelow
          />
        </div>

        <Profiler id="sessions_list" onRender={onRenderCommit}>
          <SessionsTableBody
            columnOrder={columnOrder}
            emptySignals={{
              isUnavailable: isSessionsUnavailable,
              hasActiveFilters: hasActiveSessionFilters,
            }}
            errorRecoveryAction={sessionsRecoveryAction}
            getIssueHref={linkedEntityColumns.getIssueHref}
            groupBy={groupBy}
            hasConnectedAgent={hasConnectedAgent}
            hasData={renderModel.hasRenderableData}
            hostScroll
            isLoading={isSessionsTableLoading}
            isSyncing={isSessionsSyncing}
            loadingLabel={tableLoadingLabel}
            onClearFilters={handleClearFilters}
            onColumnOrderChange={setColumnOrder}
            onRetry={handleRetry}
            onSort={handleSort}
            sessions={renderModel.sessions}
            showLinkedEntityColumns={
              linkedEntityColumns.showLinkedEntityColumns
            }
            sortBy={sortKey}
            sortDir={sortDir}
            stallPhase={stallPhase}
            visibleColumns={visibleColumns}
          />
        </Profiler>
      </div>

      {/* Fixed footer — page controls, always visible (8px horizontal padding).
          ISS-4681: the shared `TablePaginationFooter` shell, with the desktop
          list's tighter padding and `shrink-0` as the only delta. No readout —
          this list has no settled total it could state honestly. */}
      {/* ISS-5315: the footer now carries the prototype's range readout. The
          ISS-4681 note that this list "has no settled total it could state
          honestly" no longer holds — `renderModel.total` is the same figure
          `totalPages` is derived from, so stating it is strictly more honest
          than deriving a page count from it silently. Rendered whenever a total
          has settled, so page 1 of 1 still says how many sessions matched. A
          zero total keeps the footer off entirely — the empty state below
          already says there is nothing, and "Showing 0 of 0" under it would just
          be the same non-fact in a second voice. */}
      {tableLoadingLabel || renderModel.total === 0 ? null : (
        <TablePaginationFooter
          className="shrink-0 px-2 py-2"
          onPageChange={setPage}
          page={page}
          readout={sessionsRangeReadout({
            // #4480: `page` moves on click while these rows and this total are
            // still the previous page's, held by `keepPreviousData` — the
            // readout drops out for that window rather than asserting a range
            // that contradicts the rows underneath it.
            isPlaceholderPage: sessionsQuery.isPlaceholderData,
            pageIndex: page,
            pageSize: PAGE_SIZE,
            rowsOnPage: renderModel.sessions.length,
            total: renderModel.total,
          })}
          totalPages={renderModel.totalPages}
        />
      )}
    </div>
  );
}

/**
 * The shared facet query fields the list and summary-usage reads both carry.
 * Extracted so the two call sites stay in lockstep and the component body avoids
 * duplicating the facet spread.
 */
function buildFacetQuery(facetFilters: SessionFacetFilters) {
  // FEA-4192: `quality` is deliberately omitted, so the read fails open to `all`
  // (`coerceSessionQuality`). This is load-bearing for the summary row: desktop
  // can only quality-gate the Sessions COUNT, not the all-quality token/cost
  // cards, so a non-`all` segment would split the row across two populations
  // (gated count beside an all-quality token denominator). Pinning `all` keeps
  // all three cards on ONE population on screen. A future quality toggle here must
  // also caption the token/cost cards on their own basis — see
  // `getSharedAgentSessionsPageData` in shared-agent-sessions-api.ts.
  return {
    statuses: facetFilters.statuses,
    userIds: facetFilters.userIds,
    repositories: facetFilters.repositories,
    harnesses: facetFilters.harnesses,
    models: facetFilters.models,
    autonomyTiers: facetFilters.autonomyTiers,
    costBuckets: facetFilters.costBuckets,
    changePresence: facetFilters.changePresence,
    prAssociation: facetFilters.prAssociation,
  };
}

/**
 * PRD-536 §5: resolve the empty-state onboarding signal for the desktop
 * Sessions view. Cloud mode consults the org-scoped compute-target probe; local
 * mode is always "connected" (the local monitor is the agent) and never fires
 * the authenticated cloud read. Extracted so the view body stays under the
 * cognitive-complexity budget.
 */
function useDesktopHasConnectedAgent(
  isCloudMode: boolean
): boolean | undefined {
  const hasConnectedAgentQuery = useHasConnectedAgent({ enabled: isCloudMode });
  return isCloudMode ? hasConnectedAgentQuery.data : true;
}

/**
 * FEA-3574 review (ZVH): the Sessions KPI-card sign-in CTA action plus its
 * retryable error state. Previously `beginSignIn`'s `{ ok: false, reason }` and
 * rejection were swallowed, so a failed browser sign-in left the card unchanged
 * with no explanation. Now a failure (other than an explicit cancel) surfaces
 * the shared `signInFailureMessage` copy — mirroring the Settings account flow —
 * and the CTA stands as the retry. A success flips the main-process auth status,
 * which re-renders these cards through the pushed state; the renderer never sees
 * the credential. Extracted so the view body stays under the complexity budget.
 */
function useDesktopSummarySignIn(
  beginSignIn: () => Promise<DesktopBrowserSignInResult>,
  isAuthenticated: boolean
): {
  signInError: string | null;
  handleSummarySignIn: () => void;
} {
  const [signInError, setSignInError] = useState<string | null>(null);
  const handleSummarySignIn = useCallback(() => {
    // Clear any prior error the moment a retry is fired.
    setSignInError(null);
    beginSignIn()
      .then((result) => {
        if (!(result.ok || result.reason === "cancelled")) {
          setSignInError(signInFailureMessage(result.reason));
        }
      })
      .catch(() => {
        setSignInError("Sign-in could not be completed. Try again.");
      });
  }, [beginSignIn]);
  // Only surface the error on the signed-out cards: once a sign-in succeeds
  // (`isAuthenticated`) those cards leave state 2, so any stale copy is gated off
  // rather than lingering under an authenticated card.
  return {
    signInError: isAuthenticated ? null : signInError,
    handleSummarySignIn,
  };
}

function getMetricDataRefreshingState({
  canFetchAuxiliaryData,
  hasData,
  isError,
  isFetching,
  isPlaceholderData,
}: {
  canFetchAuxiliaryData: boolean;
  hasData: boolean;
  isError: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
}): boolean {
  if (!canFetchAuxiliaryData) {
    return false;
  }
  // FEA-4177 parity: once we hold last-good summary usage, a BACKGROUND refetch
  // (a paging/sort/search change re-running the combined read, or `keepPrevious`
  // placeholder data) must NOT skeleton the cards — the summary aggregate is
  // scope-stable across pagination, so a five-card grey flash on every table
  // click reads as "the numbers are reloading" when they cannot change. Mirror
  // the web page's `isLoading` (initial-load-only) gate: skeleton solely on the
  // true first load, when there is neither data nor a settled error yet.
  if (hasData || isError) {
    return false;
  }
  return isFetching || isPlaceholderData;
}

/**
 * Parses desktop Sessions' one-based page query into the table's zero-based
 * page index. Invalid or absent values intentionally resolve to the first page.
 */
function parseSessionsPage(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page - 1 : 0;
}

/**
 * Writes the canonical page query: page one is the default route and later
 * pages are represented as one-based `page` values in the desktop hash href.
 */
function writeSessionsPage(params: URLSearchParams, pageIndex: number): void {
  if (pageIndex <= 0) {
    params.delete(PAGE_PARAM);
    return;
  }
  params.set(PAGE_PARAM, String(pageIndex + 1));
}

function clampSessionsPage(
  pageIndex: number,
  total: number,
  pageSize: number
): number {
  if (!(Number.isFinite(total) && total > 0 && pageSize > 0)) {
    return 0;
  }
  return Math.min(pageIndex, Math.ceil(total / pageSize) - 1);
}

function getSessionsLoadingLabel(search: string | undefined): string {
  return search ? "Searching sessions..." : "Loading sessions...";
}

/**
 * FEA-3574: is the durable desktop session in a TERMINAL signed-out state — the
 * only states that should route the cloud-only delivery cards to the sign-in CTA
 * (state 2)? `SignedOut` and `RefreshFailed` are terminal signed-out; the
 * transient `Loading` (pre-restore) and in-flight `OpeningBrowser`/
 * `AwaitingRedirect`/`Exchanging` are NOT — treating them as signed out would
 * flash the CTA at a restoring user and keep the CTA live mid-OAuth. Everything
 * else (including `Authenticated`) is "not signed out" → neutral empty (state 3).
 */
function isDesktopAuthSignedOut(status: DesktopAuthStatus): boolean {
  return (
    status === DesktopAuthStatus.SignedOut ||
    status === DesktopAuthStatus.RefreshFailed
  );
}

/**
 * FEA-4037 (P2 review): is this the involuntary-expiry signed-out state that the
 * app-level `DesktopSessionExpiredBanner` already surfaces globally? Only
 * `RefreshFailed` latches that banner; a plain `SignedOut` does not. When true,
 * the Sessions bar suppresses its own hoisted sign-in banner so the two prompts
 * don't stack — the delivery cards still fall to their neutral dash.
 */
function isDesktopSessionExpired(status: DesktopAuthStatus): boolean {
  return status === DesktopAuthStatus.RefreshFailed;
}

function getSessionsTableLoadingLabel({
  displayState,
  hasData,
  isInitialLoading,
  isRefreshingWithPreviousData,
  search,
}: {
  displayState: SessionsDisplayState;
  hasData: boolean;
  isInitialLoading: boolean;
  isRefreshingWithPreviousData: boolean;
  search: string | undefined;
}): string | undefined {
  if (isRefreshingWithPreviousData) {
    return getSessionsLoadingLabel(search);
  }

  if ((displayState === "starting" || isInitialLoading) && !hasData) {
    return getSessionsLoadingLabel(search);
  }

  return undefined;
}
