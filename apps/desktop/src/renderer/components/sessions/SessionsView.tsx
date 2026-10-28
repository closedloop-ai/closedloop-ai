import { costFilterIncludesUnknown } from "@repo/api/src/agent-session-filters";
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { renderSessionTagsCell } from "@repo/app/agents/components/sessions/session-tags-cell";
import {
  getSessionsTableLoadingLabel,
  isSessionsReadInitiallyLoading,
} from "@repo/app/agents/components/sessions/sessions-list-loading-labels";
import { resolveVisibleHiddenCardIds } from "@repo/app/agents/components/sessions/sessions-summary-card-visibility";
import { useSessionsFavoritesController } from "@repo/app/agents/components/sessions/use-sessions-favorites-controller";
import { useAgentSessionsDataSource } from "@repo/app/agents/data-source/provider";
import { refetchAsUser } from "@repo/app/agents/hooks/read-initiator";
import {
  useAgentSessionAnalytics,
  useAgentSessionsPageData,
  useCancelAgentSessionsPageData,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { useSessionsCustomDateWindow } from "@repo/app/agents/hooks/use-sessions-custom-date-window";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import {
  resolveSessionDateWindow,
  sessionCustomDateWindowDays,
} from "@repo/app/agents/lib/session-custom-date-window";
import {
  hasAnyActiveSessionFacet,
  parseSessionFacetFilterParams,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import {
  SESSIONS_PAGE_PARAM as PAGE_PARAM,
  parseSessionsPageIndex,
} from "@repo/app/agents/lib/session-pagination";
import { isSessionComparisonPending } from "@repo/app/agents/lib/session-summary-deltas";
import { SESSIONS_SEARCH_PARAM } from "@repo/app/agents/lib/session-url-scope-params";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import { useSharedTimezoneMode } from "@repo/app/shared/hooks/use-shared-timezone-mode";
import { useTablePageSizeOptions } from "@repo/app/shared/hooks/use-table-page-size-options";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  DEFAULT_DATE_RANGE,
  dateRangeToLookbackDays,
  getStableDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { gateRestoredRead } from "@repo/app/shared/query/gate-restored-read";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../shared/local-session-source-status";
import { RendererRenderView } from "../../../shared/render-commit-event";
import { isBootImportSettled } from "../../hooks/ingest-progress-terminal";
import { isDesktopCloudPrimaryAgentSessionsDataSource } from "../../shared-agent-sessions/desktop-agent-sessions-data-source";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { isDesktopAuthSignedOut } from "../../shared-agent-sessions/desktop-auth-signed-out";
import { resolveDesktopSessionsSourcePresentation } from "../../shared-agent-sessions/desktop-sessions-source-presentation";
import { resolveDesktopSessionsCapabilityPresentation } from "./desktop-sessions-capability-presentation";
import { useSessionsExportItem } from "./sessions-csv-export-availability";
import { buildSessionsPageDataFilters } from "./sessions-page-data-filters";
import { renderSessionsRecoveryAction } from "./sessions-recovery-affordance";
import {
  buildSessionsRenderModel,
  canFetchSessionsAuxiliaryData,
  needsAnalyticsRepositoryFallback,
} from "./sessions-render-model";
import {
  deriveSessionsAvailability,
  resolveLocalSummaryCardsProps,
  resolveSummaryCardsErrored,
  useSessionsImportProgress,
} from "./sessions-summary-cards-state";
import {
  isSessionComparisonEnabled,
  resolveSessionSummaryDeltas,
  sessionComparisonQuery,
  sessionSummaryScopeKey,
  useSessionComparisonSuppressed,
} from "./sessions-summary-comparison";
import type { DesktopSessionsSurfaceInput } from "./sessions-surface-input";
import {
  areTransientRetriesExhausted,
  classifyListReadErrorState,
  readUsageErrorFlags,
  useUsageTransientRecovery,
} from "./sessions-transient-read-state";
import { SessionsV2View } from "./sessions-v2-view";
import {
  buildFacetQuery,
  getMetricDataRefreshingState,
  resolveDesktopSessionsListReadState,
} from "./sessions-view-read-state";
import {
  hasCurrentListData,
  useDesktopHasConnectedAgent,
  useDesktopSessionsOutsideWindow,
} from "./sessions-view-signals";
import {
  collapseStartingWhenDataHeld,
  getSessionsDisplayState,
  isSessionsSourceStarting,
  useLocalSessionSourceStatus,
  useSessionsReadGate,
} from "./sessions-view-source-status";
import { useDesktopLinkedEntityColumns } from "./use-desktop-linked-entity-columns";
import { useDesktopSessionsCustomFieldsController } from "./use-desktop-sessions-custom-fields-controller";
import { useDesktopSessionsListParams } from "./use-desktop-sessions-list-params";
import { useLocalAgentSessionUsage } from "./use-local-agent-session-usage";
import {
  resolveSessionsListCause,
  type SessionsListCauseInputs,
  useRenderCommitInstrumentation,
} from "./use-render-commit-instrumentation";
import { useSessionsListDeadEndTelemetry } from "./use-sessions-dead-end-telemetry";
import { useSessionsListRecovery } from "./use-sessions-list-recovery";
import { useSessionsPageClamp } from "./use-sessions-page-clamp";
import { useSessionsPageSizeUrlState } from "./use-sessions-page-size-url-state";

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

/**
 * Desktop wrapper for the shared sessions list content and local adapter.
 * `isActive` is whether this tree is the content ON SCREEN (keep-alive keeps
 * hidden pages mounted; a detail route covers the nav map), so a dead end
 * nobody saw is never counted as one they hit (ISS-7249, whitlockk review).
 */
export function SessionsView({
  isActive = true,
}: Readonly<{ isActive?: boolean }> = {}) {
  // ISS-6041: the shared Grid Parity key gates the summary cards' delta chips
  // here, closed by default like every other perceivable desktop addition. It is
  // the same key the web page resolves `comparisonV2Enabled` from, but web is not
  // gated identically — see `isSessionComparisonEnabled` for exactly what that
  // does and does not make equal.
  // ISS-7422: the desktop half of the shared honest-loading gate, so the strip's
  // pending comparison state cannot be on for web viewers and off here.
  const summaryHonestLoadingEnabled = useFeatureFlagEnabled(
    DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  const listSearchEnabled = useFeatureFlagEnabled(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const searchParams = useSearchParamsValue();
  const routePath = usePath();
  const search = searchParams.get(SESSIONS_SEARCH_PARAM)?.trim() || undefined;
  const page = parseSessionsPageIndex(searchParams.get(PAGE_PARAM));
  const {
    selectedPageSize,
    settlePageSizeWrite,
    stagePageSizeChange,
    writePageWithPageSize,
  } = useSessionsPageSizeUrlState({ searchParams });
  // FEA-3560: seeded from the list URL (the facet params are mirrored into the
  // URL on every change below). Opening a session detail unmounts this view, so
  // returning via the breadcrumb's `lastNavHref` — which preserves the list
  // query — restores the active facet filters along with page/search.
  const [facetFilters, setFacetFilters] = useState<SessionFacetFilters>(() =>
    parseSessionFacetFilterParams(searchParams)
  );
  const { dateRange, setDateRange } = useSharedDateRange("desktop");
  // ISS-9619: same surface key as the range above, so this shell's Sessions and
  // Branches lists keep agreeing about the window the way they already do.
  const { timezoneMode, setTimezoneMode, isTimezoneModeReady } =
    useSharedTimezoneMode("desktop");
  // FEA-3722: thread the selected 7d/30d/90d/All range into the coaching /
  // Coding-Wrap analytics load so the Wrap windows to the same range (null =
  // all-time) and re-loads when the top selector changes.
  const coachingLookbackDays = dateRangeToLookbackDays(dateRange);
  const {
    sortKey,
    sortDir,
    isViewReady,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    secondarySorts,
    setSecondarySorts,
    setSort,
    toggleColumn,
    resetView,
    groupBy,
    setGroupBy,
    hiddenSummaryCards,
    toggleSummaryCard,
  } = useSessionsViewState("sessions:desktop");
  const { isReady: isPageSizeReady, pageSize: resolvedUrlPageSize } =
    useTablePageSizeOptions(selectedPageSize);
  const effectivePageSize = resolvedUrlPageSize;
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
  const maxOffset = isCloudMode ? SESSION_LIST_MAX_OFFSET : undefined;
  // FEA-4128 / ISS-4444: poll the shared boot-import progress ("Importing your
  // agent history N/M" + the "N transcripts couldn't be read" quarantine count)
  // in BOTH modes. ISS-4772 (whitlockk cid 3696061972 / logical-QA): keep this read
  // active while the local source is still "starting", not only once reads are
  // enabled — the poll wrapper resets its snapshot to null whenever disabled, so
  // gating it behind the read gate made the `ingestSettled` heal arm below
  // unreachable in the exact latched-"starting" state it targets. Polling during
  // "starting" lets the boot-import-complete signal actually land. The poll
  // self-terminates once the import settles, so this adds no runaway polling.
  const ingestProgress = useSessionsImportProgress(
    isCloudMode ||
      canReadLocalSessions ||
      localSessionSourceStatus === LOCAL_SESSION_SOURCE_STATUSES.starting
  );
  // ISS-6207: ANY terminal boot-import state is the evidence this heal arm wants
  // (the source came up and was written to), not completion specifically — a
  // degraded terminal is exactly when a stranded "starting" is most likely. Not
  // behind the Labs gate — see `isBootImportSettled`: this ticket's main-process
  // half is unconditional, so latching on `complete` alone no longer reproduces
  // the old behaviour, it just never latches.
  const ingestSettled = isBootImportSettled(ingestProgress);
  // ISS-4772 (whitlockk/codex/logical-QA): the mode-aware read gate, latched open once
  // the local source is proven up (ever-ready OR boot-import-complete) so it does
  // not flap off when a healthy source latches back to "starting" after a dropped
  // `getAgentMonitorUrl` transition. The display collapse below also accepts a
  // current list response; that signal clears stale copy for this render without
  // latching the broader read gate.
  const canReadSessions = useSessionsReadGate({
    isCloudMode,
    canReadLocalSessions,
    ingestSettled,
  });
  // FEA-3574: the cloud-only delivery cards' auth axis is the durable session,
  // NOT the app-core mode. `Authenticated` (independent of connectivity) means
  // signing in wouldn't unlock more data, so authenticated-but-offline lands the
  // delivery cards in the neutral no-CTA empty, not the gated connect ask —
  // matching `resolveDesktopAppCoreMode`, which drops an offline authenticated
  // renderer back to Local.
  //
  // Only the TERMINAL signed-out statuses gate the delivery cards. The transient
  // statuses — `Loading` (pre-restore) and the in-flight `OpeningBrowser`/
  // `AwaitingRedirect`/`Exchanging` — are NOT signed-out: gating there would put
  // an ask in front of a restoring user on startup, and leave the CTAs live
  // mid-OAuth. Treat every non-terminal-signed-out status as "not signed out" so
  // those states render the neutral empty instead. ISS-7866: this ONE value now
  // feeds the connect wrapper too, which used to re-derive a stricter one.
  const { state: authState } = useDesktopAuth();
  const isAuthenticated = !isDesktopAuthSignedOut(authState.status);
  // ISS-10332: the priority editor's host opt-in is the data-source SEAM, not
  // the mode. Cloud mode's HTTP source offers `updatePriority`, and so does the
  // local store (PLN-2086 Milestone 3) when its preload carries the write.
  const sessionsDataSource = useAgentSessionsDataSource();
  const sourcePrecedenceActive =
    isDesktopCloudPrimaryAgentSessionsDataSource(sessionsDataSource);
  // PRD-536 §5: onboarding-vs-filters empty state. In cloud mode we probe the
  // org-scoped compute-target list (an empty org has never connected an agent).
  // In local mode the local monitor *is* the connected agent, so an empty local
  // list is a filters/date result, never an un-onboarded org — force `true` and
  // skip the cloud probe (a local-only desktop has no authenticated cloud read).
  const hasConnectedAgent = useDesktopHasConnectedAgent(isCloudMode);
  const {
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handlePageSizeChange,
    handleScopeChange,
    handleSort,
    replaceListParams,
    setPage,
  } = useDesktopSessionsListParams({
    effectivePageSize,
    facetFilters,
    page,
    searchParam: SESSIONS_SEARCH_PARAM,
    setDateRange,
    setFacetFilters,
    setSort,
    settlePageSizeWrite,
    stagePageSizeChange,
    writePageWithPageSize,
  });

  // Reset pagination when dateRange changes — covers both local toolbar changes
  // AND cross-tab StorageEvent updates from Dashboard/Branches.
  const dateRangeRef = useRef(dateRange);
  useEffect(() => {
    if (dateRangeRef.current !== dateRange) {
      dateRangeRef.current = dateRange;
      setPage(0);
    }
  }, [dateRange, setPage]);

  // FEA-4201: the explicit `?from=`/`?to=` window supersedes the rolling preset
  // while the URL carries a valid pair AND this renderer has the Labs toggle.
  // Resolved through the same shared seam the web listing calls, so one URL
  // cannot mean two windows across the two surfaces.
  const {
    customDateWindow,
    gateCustomDateWindowChange,
    isCustomDateWindowReady,
  } = useSessionsCustomDateWindow(
    DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY,
    searchParams,
    routePath
  );

  // UTC-day quantization keeps the query identity stable across remounts while
  // recalculating on render lets a mounted view advance after a UTC rollover.
  // ISS-9619: one window under the chosen boundary, feeding the combined list +
  // usage read below, so the table and its summary cards cannot disagree.
  const { startDate, endDate } = resolveSessionDateWindow(
    customDateWindow,
    getStableDateWindowForRange(dateRange, timezoneMode)
  );

  // PLN-1034: the default sort is now lastActivity-desc, so `sortBy`/`sortDir`
  // are sent on the initial render (not only after a header click). A null
  // `sortKey` (e.g. a restored saved view) still omits them and keeps the local
  // source on its fast paginated path.
  const facetQuery = buildFacetQuery(facetFilters);
  // FEA-4157: one combined read keeps the table and summary on one raw scan.
  // `keepPreviousData` retains the previous result while its scope changes.
  // ISS-6041/ISS-8909: whether this surface compares periods at all. One axis
  // now the Grid Parity gate is retired — Cloud reads the same HTTP source the
  // web page does; the local SQLite producer has no prior-window read.
  const sessionComparisonEnabled = isSessionComparisonEnabled({ isCloudMode });
  const pageDataFilters = buildSessionsPageDataFilters({
    comparison: sessionComparisonQuery(sessionComparisonEnabled),
    endDate,
    facetQuery,
    // ISS-13035: the cloud list route narrows by the term only under
    // `gridview-adoption`; closed, the term stays the local-only hint it was.
    listSearch: listSearchEnabled ? search : undefined,
    maxOffset,
    page,
    pageSize: effectivePageSize,
    search,
    sortDir,
    sortKey,
    startDate,
  });
  // ISS-6382/ISS-8055: restore saved view state first, and keep desktop's hidden
  // keep-alive tree quiet until it has a viewer. Fails OPEN after
  // `VIEW_RESTORE_AUTH_DEADLINE_MS`, so a stalled identity degrades open.
  // FEA-4201 (whitlockk review): also wait on the window gate. An unresolved flag reads
  // as OFF, so a flagged `?from=`/`?to=` link would otherwise read the preset
  // window first and refetch the requested one once the flag answered. Only a URL
  // that names a window waits — see `useSessionsCustomDateWindow`.
  // ISS-9692: and on the page-size ladder, for the same reason — unresolved, it
  // could resolve a URL 500 down to 100 before refetching at the size the
  // reader actually requested.
  // ISS-9619 (whitlockk + codex review): and on the day-boundary gate, for exactly
  // the reason the custom window above waits. The desktop adapter reports real
  // settled-ness, so an unresolved assignment reads as UTC here just as it does
  // on web — a reader whose stored mode is `local` would read the UTC window
  // first and refetch the Local one once the account's assignment arrived.
  const isPageDataScopeReady =
    isActive &&
    isViewReady &&
    isCustomDateWindowReady &&
    isPageSizeReady &&
    isTimezoneModeReady;
  const canReadPageData = canReadSessions && isPageDataScopeReady;
  // FEA-4217: the Options menu's export row. The module owns why it is an
  // element and why all three terms — including `isViewReady` — gate it.
  const sessionsExportItem = useSessionsExportItem({
    endDate,
    facetQuery,
    isAuthenticated,
    isCloudMode,
    isViewReady,
    startDate,
  });
  const hiddenSummaryCardIds = resolveVisibleHiddenCardIds(
    true,
    hiddenSummaryCards
  );
  const pageDataQuery = useAgentSessionsPageData(pageDataFilters, {
    enabled: canReadPageData,
    placeholderData: keepPreviousData,
  });
  // ISS-12039: Retry and Clear-and-reload are the user's own reads.
  const refetchPageDataQuery = pageDataQuery.refetch;
  const refetchPageDataAsUser = useCallback(
    () => refetchAsUser(refetchPageDataQuery),
    [refetchPageDataQuery]
  );
  // ISS-6382 (tamsinb review): `enabled: false` stops the FETCH; it does not
  // detach the observer from the cache. On a revisit the DEFAULT-view key is
  // already populated, so this read hands back the previous visit's payload for
  // the whole restore window — and `getSessionsTableLoadingLabel` short-circuits
  // on `!hasData`, so the cached rows rendered with no spinner over them. Zeroed
  // HERE rather than at each consumer, because `data` feeds the row model, the
  // loading label, the auxiliary-read gate, and the page clamp; the same helper
  // the web page uses, so the two surfaces cannot drift.
  // Gate on scope readiness, not the local source gate: ISS-4772's data-wins
  // render still holds rows while the source probe is "starting", but cached
  // rows cannot cross saved-view, explicit-window, or page-size readiness.
  const { data: gatedPageData } = gateRestoredRead(
    isPageDataScopeReady,
    pageDataQuery
  );
  const {
    isPaginationTotalKnown,
    isPopulationComplete,
    useCloudCapabilityDefaults,
  } = resolveDesktopSessionsSourcePresentation({
    sourcePrecedenceActive,
    response: gatedPageData?.list,
  });
  // ISS-6382 (tamsinb review, round 2): the read's `isLoading`, NOT the
  // `isPending` `gateRestoredRead` returns. A query disabled indefinitely
  // because `canReadSessions` is false is `pending` forever, and reporting that
  // as an initial load pinned the spinner over the "Getting your sessions ready"
  // holding surface an unavailable source owns — see the helper.
  const isPageDataPending = isSessionsReadInitiallyLoading({
    isViewReady: isPageDataScopeReady,
    isListLoading: pageDataQuery.isLoading,
  });
  // Cancels this exact read. ISS-11204 took it OFF Retry — a pending read is now
  // reused rather than restarted — so the only caller left is the clear-filters
  // reload, which changes the query key and must not leave the old read running.
  const cancelPageDataRead = useCancelAgentSessionsPageData(pageDataFilters);
  // ISS-6041: a page turn or a re-sort churns this query's key without changing
  // the summary scope the comparison describes, so the held snapshot stays
  // honest across it — see the hook for why desktop needs the narrowing web gets
  // for free.
  // ISS-6382: the GATED pending flag, so a read held closed on a warm cache
  // cannot stamp the held snapshot for a scope this mount never fetched. Both
  // comparison questions — may a chip show, and is one on its way — read this
  // one shape, or the strip would print the settled "No prior period" over the
  // restore window it is simultaneously suppressing.
  const gatedComparisonRead = {
    ...pageDataQuery,
    isPending: isPageDataPending,
  };
  const comparisonSuppressed = useSessionComparisonSuppressed({
    honestLoadingEnabled: summaryHonestLoadingEnabled,
    read: gatedComparisonRead,
    summaryScopeKey: sessionSummaryScopeKey(pageDataFilters),
  });
  // List-shaped view over the combined read for the table + pagination glue.
  const sessionsQuery = {
    data: gatedPageData?.list,
    isLoading: pageDataQuery.isLoading,
    isError: pageDataQuery.isError,
    // ISS-7528: the two read failures the table body must tell apart. `isError`
    // is true for a read that never landed AND for a background refetch that
    // failed over one this view still holds (query-core's error reducer keeps
    // `data`, and this read uses `keepPreviousData`); only `isLoadingError`
    // names the first. ISS-7519 (PR #5596, still open) makes the same split on
    // the web page — on `main` today that page still feeds the raw flag.
    isLoadingError: pageDataQuery.isLoadingError,
    isFetching: pageDataQuery.isFetching,
    isPlaceholderData: pageDataQuery.isPlaceholderData,
  };
  // ISS-6005 scope 4: the toolbar's read-source pill is a strict drop, so this
  // view derives no badge copy.
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
  // ISS-4483 (review cid 3679616168, whitlockk): a TRANSIENT usage-half failure (the
  // list won the race, so the combined read RESOLVED with `usage` omitted and
  // `usageErrorTransient: true`) is recovered by a bounded manual refetch OUTSIDE
  // react-query's own retry — see the hook. Its `usageRecoveryExhausted` closes the
  // transient-usage window (mirroring the list path's `transientRetriesExhausted`)
  // so a wedged transient usage failure falls through to the honest dash instead of
  // an infinite reconnecting skeleton. The candidate is the raw transient-usage
  // condition before exhaustion, so the hook owns the edge without a cycle.
  const usageErrorFlags = readUsageErrorFlags(gatedPageData);
  //
  // ISS-6382 (whitlockk review): the recovery takes the SAME effective gate as the
  // read. Its escape hatch is `pageDataQuery.refetch()`, which ignores `enabled`,
  // and its trigger comes from `pageDataQuery.data` — which on a revisit is the
  // CACHED payload. A cached `usageErrorTransient` therefore armed the recovery
  // during a slow auth hydration and fired the default-view read a second later.
  const { usageRecoveryExhausted } = useUsageTransientRecovery({
    readGateOpen: canReadPageData,
    usageError: usageErrorFlags.usageError,
    usageErrorTransient: usageErrorFlags.usageErrorTransient,
    refetch: pageDataQuery.refetch,
  });
  const {
    isListErrorTransient,
    isListErrorTransientSource,
    metricReadErrored,
    transientReadWithoutUsage,
  } = classifyListReadErrorState({
    isListError: pageDataQuery.isError,
    listError: pageDataQuery.error,
    usageError: usageErrorFlags.usageError,
    hasSummaryUsage: usageErrorFlags.hasSummaryUsage,
    usageErrorTransient: usageErrorFlags.usageErrorTransient,
    transientRetriesExhausted,
    usageRecoveryExhausted,
  });

  const canFetchAuxiliaryData = canFetchSessionsAuxiliaryData({
    canReadSessions: canReadPageData,
    hasSessionsData: Boolean(sessionsQuery.data),
    isFetching: sessionsQuery.isFetching,
    isPlaceholderData: sessionsQuery.isPlaceholderData,
  });

  // ISS-5283 (whitlockk review): the facet-option lists read the ACTIVE-FILTER usage
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
  const summaryUsage = gatedPageData?.usage;
  // ISS-6041: the producer's period-over-period percentages, mapped onto the same
  // shared cards the web page hands them to — or nothing, on a surface that does
  // not compare.
  const summaryDeltas = resolveSessionSummaryDeltas({
    // FEA-4201: an explicit window names its OWN span — see the parameter's
    // docblock. Web resolves this identically.
    customWindowDays: sessionCustomDateWindowDays(customDateWindow),
    dateRange,
    enabled: sessionComparisonEnabled,
    // ISS-7422: separate from `suppressed` — see the parameter's docblock.
    pending: isSessionComparisonPending(gatedComparisonRead),
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
  // ISS-4429 (whitlockk review): the fallback must be REACHABLE on a fresh cloud
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
    canReadPageData &&
    (canFetchAuxiliaryData || metricReadErrored);
  // FEA-4201: `endDate` is load-bearing here now. Before the explicit window the
  // preset always ended at end-of-today UTC, so omitting the upper bound picked
  // the same population; an explicit `to` can be a PAST day, and a fallback card
  // aggregating window-start-to-NOW would state a wider population than the rows
  // under it — the exact divergence this fallback exists to avoid.
  const localSummaryUsageQuery = useLocalAgentSessionUsage(
    { ...facetQuery, endDate, search, startDate },
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
    // FEA-4201: bounded above for the same reason as the usage fallback above —
    // unbounded, this offers Repository options for repos outside the window.
    { endDate, search, startDate },
    {
      enabled:
        canFetchAuxiliaryData && needsAnalyticsRepositoryFallback(summaryUsage),
      placeholderData: keepPreviousData,
    }
  );

  // FEA-4181: is any filter narrowing the list — a non-default date window, a
  // facet selection, or a search term? Drives the filtered-vs-genuinely-empty
  // distinction in the honest empty state.
  const hasActiveSessionFilters =
    customDateWindow !== null ||
    dateRange !== DEFAULT_DATE_RANGE ||
    Boolean(search) ||
    hasAnyActiveSessionFacet(facetFilters);

  // Cloud mode has no local monitor to be "starting"/"unavailable"; the cloud
  // query's own isLoading/isError/data drive the table, so collapse to "ready".
  // ISS-4772: in local mode, collapse a latched "starting" to "ready" once the
  // page-data read lands for the active scope (or the boot import has been
  // observed complete). After long uptime a dropped `getAgentMonitorUrl`
  // transition can leave `localSessionSourceStatus` stuck on "starting" while the
  // backend and query are healthy, blanking the body to an infinite "Loading".
  // Current data always wins over the stale label; the "unavailable"/errored
  // branch is untouched (never overridden to "ready").
  const rawDisplayState = isCloudMode
    ? "ready"
    : getSessionsDisplayState(localSessionSourceStatus);
  // ISS-4772 (whitlockk review): only data from the ACTIVE query key counts here.
  // `keepPreviousData` shows the prior key's rows as `isPlaceholderData`, and
  // promoting on those claims "ready" over a scope not read. A current empty
  // response is a real landed read, so it also collapses a stale "starting" label.
  const hasSettledListData = hasCurrentListData({
    isPlaceholderData: sessionsQuery.isPlaceholderData,
    list: sessionsQuery.data,
  });
  const displayState = collapseStartingWhenDataHeld({
    rawDisplayState,
    hasHeldListData: hasSettledListData,
    ingestSettled,
  });
  const renderModel = buildSessionsRenderModel({
    canReadSessions: canReadPageData,
    displayState,
    maxOffset,
    isListError: sessionsQuery.isError,
    isListLoading: isPageDataPending,
    isListLoadingError: sessionsQuery.isLoadingError,
    isPlaceholderData: sessionsQuery.isPlaceholderData,
    isPopulationComplete,
    isPaginationTotalKnown,
    sessionsData: sessionsQuery.data,
    facetUsage: summaryUsage,
    repositoryBreakdown: analyticsQuery.data?.byRepository,
    pageSize: effectivePageSize,
  });
  const isListRefreshingWithPreviousData =
    sessionsQuery.isPlaceholderData && sessionsQuery.isFetching;

  const {
    hasCustomFieldOperands,
    hasLinkedEntityOperands,
    hasTagOperands,
    showPriorityColumn,
  } = resolveDesktopSessionsCapabilityPresentation({
    isCloudMode,
    items: renderModel.sessions,
    sourceSupportsPriority: sessionsDataSource.updatePriority !== undefined,
    sourcePrecedenceActive,
    useCloudCapabilityDefaults,
  });
  const linkedEntityColumns = useDesktopLinkedEntityColumns(
    hasLinkedEntityOperands,
    authState
  );

  // ISS-12455: the legacy path retains its mode-owned seams. The composite
  // path follows selected-row operands because fallback can mix cloud and
  // local rows on the same page.
  const desktopCustomFields = useDesktopSessionsCustomFieldsController(
    hasCustomFieldOperands,
    renderModel.sessions
  );
  const renderTags = optionalSessionsValue(
    hasTagOperands,
    renderSessionTagsCell
  );
  // ISS-12691: a cloud session id is an artifact id, while a local-mode id is
  // not, so only the cloud host supplies the shared favorite controller.
  const desktopFavorites = useSessionsFavoritesController(isCloudMode);

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
    hasData: renderModel.hasRenderableData,
    // ISS-6382: a read held closed by the restore gate reports `isLoading:
    // false` (nothing is in flight), so without this the body fell straight
    // through to the honest-empty surface — the connect-an-agent onboarding CTA
    // over an account that has sessions. `isPageDataPending` is true for BOTH a
    // first fetch and a held-closed read, and `hasData` above is now gated too,
    // which matters because this helper short-circuits on `!hasData`: a warm
    // cache alone would otherwise suppress the label it is asked for here.
    isInitialLoading: isPageDataPending,
    isRefreshingWithPreviousData: isListRefreshingWithPreviousData,
    isSourceStarting: isSessionsSourceStarting(displayState),
    search,
  });
  const isMetricDataRefreshing = getMetricDataRefreshingState({
    canFetchAuxiliaryData,
    hasData: Boolean(summaryUsage),
    isError: metricReadErrored,
    isFetching: metricUsageQuery.isFetching,
    isPlaceholderData: metricUsageQuery.isPlaceholderData,
  });
  useSessionsPageClamp({
    canReadSessions: canReadPageData,
    hasListData: renderModel.totalRowsKnown,
    isFetching: sessionsQuery.isFetching,
    maxOffset,
    page,
    pageSize: effectivePageSize,
    setPage,
    total: renderModel.total,
  });
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
  // whitlockk review: `isMetricDataRefreshing` drops the one true initial-load
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
  // ISS-6382: `isPageDataPending` replaces this read's own `isLoading`, which
  // reports false for a held-closed read — settled cards over a scope never
  // read. It is deliberately NOT folded into `areSummaryCardsErrored` (an unread
  // scope is not a breakage).
  const areSummaryCardsLoading =
    displayState === "starting" || isPageDataPending || isMetricDataRefreshing;
  const areSummaryCardsErrored = resolveSummaryCardsErrored({
    displayState,
    metricReadErrored,
    hasSummaryUsage: summaryUsage !== undefined,
  });
  const outsideWindowProbe = useDesktopSessionsOutsideWindow({
    customDateWindow,
    dateRange,
    facetFilters,
    hasSettledListData,
    knownTotal: renderModel.knownTotal,
    search,
  });
  // FEA-4181: the table body's unavailable/syncing/loading trio (see the helper
  // for the errored-vs-syncing split) — derived out of the JSX.
  const {
    isUnavailable: isSessionsUnavailable,
    isSyncing: isSessionsSyncing,
    isTableLoading: isListTableLoading,
  } = deriveSessionsAvailability({
    displayState,
    isListError: sessionsQuery.isError,
    isListErrorTransient,
    isListErrorTransientSource,
    isListLoadingError: sessionsQuery.isLoadingError,
    // ISS-6382: deliberately NOT `|| !isViewReady`, unlike the loading label
    // above. This feeds `isBlockingLoad`, which arms FEA-3639's stall detector —
    // and that detector's escape hatch calls `pageDataQuery.refetch()`, which in
    // TanStack v5 ignores `enabled` and would drive exactly the default-sort read
    // the gate is holding back. The body still spins during the gate (via the
    // surface's own loading label); the stall budget simply starts when
    // the fetch does, which is what it is measuring.
    isListLoading: sessionsQuery.isLoading,
  });
  // ISS-11913: an empty list has not said whether sessions exist until the
  // outside-window probe lands, so the body holds its loading treatment and,
  // having nothing it can render yet, counts toward the FEA-3639 stall bound.
  const isSessionsTableLoading =
    isListTableLoading || outsideWindowProbe.isPending;
  const hasRenderableData =
    renderModel.hasRenderableData && !outsideWindowProbe.isPending;

  // FEA-3639: bound the blocking (no-rows-yet) load so it can never sit on an
  // infinite skeleton — the reported stall. Reuses the FEA-4181 availability
  // signals: `isBlockingLoad` is the exact condition under which the table shows
  // a full-body spinner — loading, no rows to fall back on, and NOT the settled
  // unavailable/error state (which owns its own honest-empty surface). The
  // keep-previous refresh (still has rows) is excluded; it never blanks the table.
  const isBlockingLoad =
    isSessionsTableLoading && !hasRenderableData && !isSessionsUnavailable;
  // ISS-4534 / FEA-3639: the list-recovery concern (Clear filters, Retry, and the
  // soft/hard stall escalation) lives in its own hook so this grandfathered view
  // stays small. `handleClearFilters` is the honest "reload" behind the errored
  // empty's recovery Link; `handleRetry` re-arms the stall detector for a wedged
  // load; `stallPhase` drives the spinner→retry→error escalation.
  const {
    handleClearFilters,
    handleClearFiltersAndReload,
    handleRetry,
    stallPhase,
  } = useSessionsListRecovery({
    cancelPageDataRead,
    isBlockingLoad,
    // Nothing to clear ⇒ no key moves ⇒ the reload must be issued (ISS-7249).
    isListScopeDefault: !hasActiveSessionFilters && page === 0,
    isPageDataFetching: pageDataQuery.isFetching,
    recheckLocalSource,
    refetchPageData: refetchPageDataAsUser,
    replaceListParams,
    searchParam: SESSIONS_SEARCH_PARAM,
    setDateRange,
    setFacetFilters,
  });
  const sessionsEmptySignals = {
    // ISS-11913: the probe turns the listing's empty into the filtered one, so
    // this classifier must count it to report the treatment actually shown.
    hasActiveFilters:
      hasActiveSessionFilters ||
      outsideWindowProbe.hasSessionsOutsideWindow === true,
    isUnavailable: isSessionsUnavailable,
  };
  // ISS-7249: count the stalled / unavailable / empty treatments this body
  // renders, and hand back the SAME Retry the buttons already called — wrapped,
  // so the attempt and its outcome are recorded without changing what the user
  // sees or does. The page bounds ride along; see `isSessionsPageOutOfRange`.
  const {
    onRetry: handleTrackedRetry,
    onClearFiltersAndReload: handleTrackedRecovery,
  } = useSessionsListDeadEndTelemetry({
    emptySignals: sessionsEmptySignals,
    hasLoadingLabel: Boolean(tableLoadingLabel),
    hasRenderableData,
    hasSettledTotal: renderModel.totalRowsKnown,
    isActive,
    isSyncing: isSessionsSyncing,
    isTableLoading: isSessionsTableLoading,
    listError: pageDataQuery.error,
    maxOffset,
    onClearFiltersAndReload: handleClearFiltersAndReload,
    onRetry: handleRetry,
    page,
    pageSize: effectivePageSize,
    stallPhase,
    total: renderModel.total,
    visibleRowCount: renderModel.sessions.length,
  });

  const input: DesktopSessionsSurfaceInput = {
    coachingLookbackDays,
    columnOrder,
    columnWidths,
    customDateWindow,
    customFields: desktopCustomFields,
    dateRange,
    emptySignals: sessionsEmptySignals,
    errorRecoveryAction: renderSessionsRecoveryAction(handleTrackedRecovery),
    facetFilters,
    favorites: desktopFavorites,
    getIssueHref: linkedEntityColumns.getIssueHref,
    groupBy,
    handleClearFilters,
    handleCustomDateWindowChange: gateCustomDateWindowChange(
      handleCustomDateWindowChange
    ),
    handleDateRangeChange,
    handleFiltersChange,
    handleRetry: handleTrackedRetry,
    handleTimezoneModeChange: setTimezoneMode,
    timezoneMode,
    handleScopeChange,
    handleSort,
    hasConnectedAgent,
    hasRenderableData: renderModel.hasRenderableData,
    hasSessionsOutsideWindow: outsideWindowProbe.hasSessionsOutsideWindow,
    hiddenSummaryCardIds,
    hiddenSummaryCards,
    isAuthenticated,
    isListPlaceholderPage: sessionsQuery.isPlaceholderData,
    listReadState: resolveDesktopSessionsListReadState({
      isUnavailable: isSessionsUnavailable,
      readState: renderModel.readState,
    }),
    isSessionsSyncing,
    isSessionsTableLoading,
    isSummaryLoading: areSummaryCardsLoading,
    items: renderModel.sessions,
    onColumnOrderChange: setColumnOrder,
    onColumnWidthChange: setColumnWidth,
    onRenderCommit,
    onPageSizeChange: handlePageSizeChange,
    page,
    pageInfo: isPaginationTotalKnown ? sessionsQuery.data?.pageInfo : undefined,
    pageSize: effectivePageSize,
    renderTags,
    resetView,
    sessionsExportItem,
    setGroupBy,
    setPage,
    showLinkedEntityColumns: linkedEntityColumns.showLinkedEntityColumns,
    showPriorityColumn,
    search,
    secondarySorts,
    setSecondarySorts,
    setSort,
    sortDir,
    sortKey,
    stallPhase,
    summaryCards: {
      alwaysAvailableLoading: localSummaryCards.alwaysAvailableLoading,
      // ISS-4481: honest-empty the Cost tile when the Unknown cost facet is
      // active (every row shows "—"), matching the web adapter (stage review).
      costUnknownActive: costFilterIncludesUnknown(facetFilters.costBuckets),
      couldNotImportLabel: localSummaryCards.couldNotImportLabel,
      deltas: summaryDeltas,
      importInProgress: localSummaryCards.importInProgress,
      isError: areSummaryCardsErrored,
      isLocalError: localSummaryCards.isLocalError,
      localUsage: localSummaryCards.localUsage,
      transientRecovering: transientReadWithoutUsage,
    },
    // The RAW facet usage, which is what the cards have always aggregated. The
    // toolbar takes `usage` below — the render model's copy, which folds in the
    // FEA-4299 analytics repository fallback so the Repository facet has
    // options. Two values on purpose; collapsing them would either starve the
    // facet or widen what the cards claim to have counted.
    maxOffset,
    summaryUsage,
    tableLoadingLabel,
    toggleColumn,
    toggleSummaryCard,
    total: renderModel.total,
    totalPages: renderModel.totalPages,
    usage: renderModel.usage,
    visibleColumns,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionsV2View input={input} />
    </div>
  );
}

function optionalSessionsValue<T>(
  hasOperand: boolean,
  value: T
): T | undefined {
  return hasOperand ? value : undefined;
}
