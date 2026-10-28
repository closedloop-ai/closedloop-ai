"use client";

import { costFilterIncludesUnknown } from "@repo/api/src/agent-session-filters";
import { SessionsCsvExportMenuItem } from "@repo/app/agents/components/sessions/sessions-csv-export-menu-item";
import { resolveVisibleHiddenCardIds } from "@repo/app/agents/components/sessions/sessions-summary-card-visibility";
import { useSessionsWindowClearFold } from "@repo/app/agents/hooks/use-sessions-window-clear-fold";
import { sessionCustomDateWindowDays } from "@repo/app/agents/lib/session-custom-date-window";
import {
  buildSessionSummaryDeltas,
  isSessionComparisonPending,
  shouldSuppressSessionComparison,
} from "@repo/app/agents/lib/session-summary-deltas";
import { applySessionsHostViewChange } from "@repo/app/agents/lib/sessions-host-view-change";
import type { SessionsHostViewState } from "@repo/app/agents/lib/sessions-list-view-adapter";
import { useCallback, useMemo } from "react";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";
import type { SessionsSurfaceInput } from "./sessions-surface-input";

/**
 * ISS-8221 — the Sessions listing on the Grid Table v2 stack, and everything
 * only that stack needs.
 *
 * The page used to derive all of this beside the v1 equivalents and hand each
 * branch its share, threading the flag boolean through nine read sites to do
 * it. It is derived HERE now, unconditionally, because this component only ever
 * renders on the open-flag branch: there is no v1 behaviour to fall back to, so
 * there is no gate.
 *
 * ISS-10301 deleted its `./sessions-v1-page.tsx` sibling with the `grid-table-v2`
 * key, so this is the only Sessions surface and there is no flag to know about.
 */
export function SessionsV2Page({ input }: { input: SessionsSurfaceInput }) {
  const {
    columnOrder,
    columnWidths,
    customDateWindow,
    dateRange,
    handleTimezoneModeChange,
    timezoneMode,
    effectiveFacetFilters,
    effectivePageIndex,
    errorRecoveryAction,
    facetFilters,
    getIssueHref,
    getSessionHref,
    githubConnectGate,
    groupBy,
    handleCustomDateWindowChange,
    handleScopeChange,
    hasConnectedAgent,
    hasSessionsOutsideWindow,
    hiddenSummaryCards,
    honestLoadingEnabled,
    isListPending,
    isPlaceholderPage,
    isSessionsReadReady,
    isSummaryLoading,
    isSummaryLoadingError,
    items,
    listReadState,
    listFilters,
    markPageReset,
    onboardingAction,
    onPageSizeChange,
    pageInfo,
    pageSize,
    projectFacetEnabled,
    replacePage,
    resetView,
    search,
    selectedUserId,
    setColumnOrder,
    setColumnWidth,
    setGroupBy,
    secondarySorts,
    setScrollContainer,
    setSecondarySorts,
    setSort,
    sortDir,
    sortKey,
    summaryComparisonRead,
    summaryUsage,
    toggleColumn,
    toggleSummaryCard,
    total,
    visibleColumns,
  } = input;

  // FEA-4217: the per-card hide menu is on this surface, so the strip and the
  // menus both read the reader's stored set.
  const hiddenSummaryCardIds = resolveVisibleHiddenCardIds(
    true,
    hiddenSummaryCards
  );
  // FEA-4202 (Grid Parity): the cadence captions (WoW/MoM/QoQ) and the
  // `PRs Shipped` chip are this strip's, so they are asked for outright.
  const summaryDeltas = buildSessionSummaryDeltas({
    comparisonV2Enabled: true,
    current: summaryUsage,
    // FEA-4201: an explicit window names its OWN span, because that is what the
    // producer compared against — a preset caption over a one-day drill-down
    // would read "vs. prior 90 days" beside a one-day delta.
    customWindowDays: sessionCustomDateWindowDays(customDateWindow),
    dateRange,
    // ISS-7422: asked separately from `suppressed`, which folds the errored arm
    // in: the CARDS take the narrower `isLoadingError`, so a failed refetch
    // holding last-good data renders as a settled card rather than a shimmer
    // over a fetch that has already stopped.
    pending: isSessionComparisonPending(summaryComparisonRead),
    suppressed: shouldSuppressSessionComparison(
      summaryComparisonRead,
      honestLoadingEnabled
    ),
  });

  // ISS-8037: the `?userId=` scope as the v2 view-state AXIS, derived ONCE for
  // both the state the surface renders from and the `current` its change is
  // diffed against. Two derivations of the same URL param is how a removal comes
  // to be measured against a scope the surface was never handed.
  //
  // ISS-10301: UNCONDITIONAL. This read used to be gated on
  // `sessions-owner-scope-chip`, whose OFF arm had exactly one renderer — the v1
  // host's "User filtered" badge plus its "Showing sessions for the selected
  // user." sentence — and that host is gone. Left gated, a reader without the key
  // (which is every signed-out or unassigned reader, by construction) got a list
  // the `?userId=` param had narrowed with NOTHING on screen naming the narrower
  // and no way to remove it, and — because the v2 surface counts `scopeUserId`
  // rather than the page's `hasActiveFilters` when it decides narrowed-vs-empty —
  // a filtered-away result labelled "No sessions yet" at an org with plenty.
  //
  // So this is the migration's own last arm, collapsed onto v2 the way the
  // operator ruling (2026-09-17) prescribes for the rest, not a rollout decision:
  // the chip is what the badge became, and it is strictly the better half — the
  // badge named a filter it gave the reader no way to remove.
  const scopeUserId = selectedUserId;

  // ISS-9822 — "Clear all" drops the explicit `?from=`/`?to=` window in the SAME
  // write as the cleared facets. The fold is the shared one desktop reads, so
  // the microtask rule that makes every write in one synchronous click strip has
  // a single implementation rather than a second hand-written copy here.
  //
  // `handleCustomDateWindowChange` is already gated on the page
  // (`gateCustomDateWindowChange`), so a viewer without the window's key hands
  // the fold `undefined`, gets an `undefined` surface callback, and the toolbar
  // renders no Custom control — today's behaviour, byte for byte.
  const {
    onSurfaceCustomWindowChange,
    readPendingWindowClear,
    readPendingWindowPick,
  } = useSessionsWindowClearFold(handleCustomDateWindowChange);

  // ISS-7052 Part A: this page's view state in the shape the v2 surface's
  // controller speaks. The page keeps OWNING it — the surface reports changes
  // back through `handleHostViewChange` and stores nothing.
  const hostView: SessionsHostViewState = useMemo(
    () => ({
      sortKey,
      sortDir,
      secondarySorts,
      groupBy,
      facets: effectiveFacetFilters,
      dateRange,
      scopeUserId,
      // PRD-721: the `?search=` term the toolbar sets; the list route applies it.
      search,
      visibleColumns,
      // `effectivePageIndex`, NOT `urlPageIndex` (davetho review): every
      // other consumer of the page index on this route already reads the
      // effective one — the query's `offset`, the range readout, the scroll
      // key, and the stale-page clamp. Handing the surface the URL value
      // instead left the v2 paginator as the only thing on screen still
      // rendering page N through the window where a filter/sort/page-size
      // reset has moved the query to page 1 and the router replace has not
      // reconciled into the search-params snapshot yet — a pager disagreeing
      // with the readout beside it and with the rows beneath it.
      page: effectivePageIndex,
    }),
    [
      sortKey,
      sortDir,
      secondarySorts,
      groupBy,
      effectiveFacetFilters,
      dateRange,
      scopeUserId,
      search,
      visibleColumns,
      effectivePageIndex,
    ]
  );
  // Routed through the page's EXISTING handlers rather than the raw setters, so
  // the v2 path inherits every side effect the v1 controls already carry — the
  // page reset that a filter or sort change owes, and the `?range=` strip that
  // must land in the SAME history write as its page reset (ISS-5355).
  const handleHostViewChange = useCallback(
    (next: SessionsHostViewState) => {
      // Read ONCE per interaction, at the top, exactly as the desktop host does:
      // the fold holds the clear for the whole synchronous event, so every write
      // in one "Clear all" click strips, and a per-write re-read would be the
      // same answer asked several times.
      const clearWindow = readPendingWindowClear();
      // The index the interaction has ALREADY reached, which after a window PICK
      // is not the one this closure can see. The pick wrote the URL itself — the
      // new `?from=`/`?to=` and its page reset in one `replaceListParams` — and
      // `markPageReset()` made the effective index 0 with it, through a state
      // setter that cannot land inside the same synchronous event. Left at the
      // stale pre-click value, the trailing `replacePage` below reads a page
      // move that already happened and fires a SECOND write off the same
      // pre-click snapshot, carrying no window params: applying a custom window
      // from page 2+ landed the reader on page 1 with their pick silently gone.
      const pageIndex = readPendingWindowPick() ? 0 : effectivePageIndex;
      applySessionsHostViewChange(
        next,
        {
          dateRange,
          facets: effectiveFacetFilters,
          groupBy,
          pageIndex,
          scopeUserId,
          search,
          secondarySorts,
          sortDir,
          sortKey,
          visibleColumns,
        },
        {
          markPageReset,
          onScopeChange: (delta) => {
            handleScopeChange({ ...delta, clearWindow });
          },
          replacePage,
          setGroupBy,
          setSecondarySorts,
          setSort,
          toggleColumn,
        },
        // Clearing the window ALONE moves no other scope axis, so the shared
        // router would report no delta and nothing would write the URL. It
        // synthesizes one rather than this page issuing a second
        // `replaceListParams`: two writes in one click both start from the
        // pre-click snapshot and the later one restores what the earlier removed.
        { pendingScopeClear: clearWindow }
      );
    },
    [
      sortKey,
      sortDir,
      secondarySorts,
      groupBy,
      dateRange,
      effectiveFacetFilters,
      scopeUserId,
      search,
      visibleColumns,
      effectivePageIndex,
      markPageReset,
      readPendingWindowClear,
      readPendingWindowPick,
      setSecondarySorts,
      setSort,
      setGroupBy,
      handleScopeChange,
      toggleColumn,
      replacePage,
    ]
  );

  /* ISS-7052 Part A: the v2 surface owns the whole listing — toolbar, metric
  strip, table and pagination — so it replaces all four regions of the v1
  branch rather than swapping the table inside them. */
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SessionsListV2Host
        columnOrder={columnOrder}
        columnWidths={columnWidths}
        customDateWindow={customDateWindow}
        errorRecoveryAction={errorRecoveryAction}
        // FEA-4217: the export is scoped by the SAME base filters the list read
        // uses, so the CSV describes the rows on screen. `listFilters` is passed
        // whole rather than re-derived — the export route's schema ignores the
        // pagination/sort keys it carries.
        //
        // Gated on `isSessionsReadReady`, the SAME signal the two reads wait on
        // (whitlockk review). The saved view restores in a post-mount effect, so
        // before that gate opens `listFilters` still carries the module DEFAULT
        // window and sort — an export clicked in that window would hand the
        // reader a file for a range the table was never showing, named as the
        // view they were looking at. The row is absent rather than disabled for
        // the same reason the desktop drops it in local mode: an offered action
        // that cannot answer honestly is worse than one that is not offered yet.
        exportItem={
          isSessionsReadReady ? (
            <SessionsCsvExportMenuItem filters={listFilters} />
          ) : undefined
        }
        getIssueHref={getIssueHref}
        getSessionHref={getSessionHref}
        hasConnectedAgent={hasConnectedAgent}
        hasSessionsOutsideWindow={hasSessionsOutsideWindow}
        hiddenSummaryCards={hiddenSummaryCardIds}
        hostView={hostView}
        isListPending={isListPending}
        isPlaceholderPage={isPlaceholderPage}
        items={items}
        listReadState={listReadState}
        onboardingAction={onboardingAction}
        onColumnOrderChange={setColumnOrder}
        onColumnWidthChange={setColumnWidth}
        onCustomDateWindowChange={onSurfaceCustomWindowChange}
        onHostViewChange={handleHostViewChange}
        onPageSizeChange={onPageSizeChange}
        onResetView={resetView}
        onTimezoneModeChange={handleTimezoneModeChange}
        onToggleSummaryCard={toggleSummaryCard}
        pageInfo={pageInfo}
        pageSize={pageSize}
        projectFacetEnabled={projectFacetEnabled}
        summaryCards={{
          // ISS-7866: the v2 strip lives INSIDE the shared surface, so the
          // Connect-GitHub ask reaches it through this passthrough rather than
          // by swapping the component the way the v1 host does. Same gate, so
          // the two branches cannot disagree about the ask.
          ...githubConnectGate,
          costUnknownActive: costFilterIncludesUnknown(
            facetFilters.costBuckets
          ),
          deltas: summaryDeltas,
          isError: isSummaryLoadingError,
          // ISS-11472: the rank is the band's, not this host's. The shared prop
          // set pins `wrapBelow: false` for every bar and the passthrough Omits
          // the key, so the two shells cannot answer it differently — which is
          // what this comment used to have to ask for by hand. ISS-10314's
          // reason for the value is unchanged: the wrapping grid stacks five
          // cards ~530px tall at 390px, and this band's only sibling that can
          // absorb the overflow is `GridTableListSurface`'s `flex-1` scroller,
          // whose scaled shrink factor is zero, so it resolves to 0px instead
          // and takes the row links with it.
        }}
        summaryIsLoading={isSummaryLoading}
        tableScrollRef={setScrollContainer}
        timezoneMode={timezoneMode}
        total={total}
        usage={summaryUsage}
      />
    </div>
  );
}
