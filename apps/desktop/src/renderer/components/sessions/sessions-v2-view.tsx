import { renderSessionPriorityCell } from "@repo/app/agents/components/sessions/session-priority-cell";
import { SessionsListSurfaceV2 } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { useSessionLinkedEntitySeams } from "@repo/app/agents/components/sessions/use-session-linked-entity-seams";
import { useSessionsBulkTagActions } from "@repo/app/agents/components/sessions/use-sessions-bulk-tag-actions";
import { useSessionsRegisteredBulkActions } from "@repo/app/agents/components/sessions/use-sessions-registered-bulk-actions";
import { useSessionsHostControlledView } from "@repo/app/agents/hooks/use-sessions-host-controlled-view";
import { useSessionsWindowClearFold } from "@repo/app/agents/hooks/use-sessions-window-clear-fold";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { hideSessionGroupedColumn } from "@repo/app/agents/lib/session-grouping";
import {
  isSyncStateFoldActive,
  toSessionTableRowWithSyncFold,
} from "@repo/app/agents/lib/session-status-fold";
import { applySessionsHostViewChange } from "@repo/app/agents/lib/sessions-host-view-change";
import {
  SESSIONS_HOST_GROUP_OPTIONS,
  SESSIONS_HOST_GROUP_OPTIONS_WITHOUT_PRIORITY,
  type SessionsHostViewState,
} from "@repo/app/agents/lib/sessions-list-view-adapter";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import { Profiler, useCallback, useMemo } from "react";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { useRouteScrollerRegistration } from "../../navigation/route-scroller-context";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";
import { useOnlineStatus } from "../../shared-agent-sessions/use-online-status";
import { AgentCoachingTips } from "./agent-coaching-tips";
import { SessionsFileAccessBanner } from "./sessions-file-access-banner";
import {
  DesktopSessionsConnectOutcome,
  useDesktopSessionsGitHubConnectGate,
} from "./sessions-summary-cards-with-github-connect";
import type { DesktopSessionsSurfaceInput } from "./sessions-surface-input";

/**
 * ISS-10585: Same shared footer, fed here from this machine's local store — the only thing
 * distinguishing it from the org spelling (operator ruling, 2026-09-18).
 */
export const SESSIONS_LIST_FOOTER_COUNT_SITE =
  SESSION_COUNT_SITE.SessionsListFooterThisDevice;

/**
 * ISS-9107 — the desktop Sessions listing on the Grid Table v2 stack.
 *
 * ISS-8909 retired the v1 sibling this used to be chosen against, so
 * `SessionsView` mounts this unconditionally. The surface owns the WHOLE
 * listing — toolbar, metric strip, table and pagination — where v1 owned only
 * the table and left the shell to compose the other three, which is why this is
 * one component rather than four regions.
 *
 * The mount was approved while three v1 capabilities had no seam on the surface.
 * All three have since landed — the sidebar `?search=` term (ISS-8966), the
 * FEA-3639 stall escalation (ISS-9105) and the table's loading copy (ISS-9106,
 * merged as #6591) — so this branch WIRES each of them rather than shipping the
 * absence that approval tolerated. The operator's later capability-honest ruling
 * added three more: a visible, clearable custom date window; the full grouping
 * split axis; and row selection suppressed where no bulk operation exists.
 */
export function SessionsV2View({
  input,
}: {
  input: DesktopSessionsSurfaceInput;
}) {
  const {
    coachingLookbackDays,
    columnOrder,
    columnWidths,
    customDateWindow,
    customFields,
    dateRange,
    handleCustomDateWindowChange,
    handleTimezoneModeChange,
    timezoneMode,
    errorRecoveryAction,
    facetFilters,
    favorites,
    getIssueHref,
    groupBy,
    handleRetry,
    handleScopeChange,
    hasConnectedAgent,
    hasSessionsOutsideWindow,
    hiddenSummaryCardIds,
    isAuthenticated,
    isListPlaceholderPage,
    listReadState,
    isSessionsSyncing,
    isSessionsTableLoading,
    stallPhase,
    tableLoadingLabel,
    isSummaryLoading,
    items,
    maxOffset,
    onColumnOrderChange,
    onColumnWidthChange,
    onPageSizeChange,
    onRenderCommit,
    page,
    pageInfo,
    pageSize,
    renderTags,
    resetView,
    search,
    secondarySorts,
    sessionsExportItem,
    setGroupBy,
    setPage,
    setSecondarySorts,
    setSort,
    showLinkedEntityColumns,
    showPriorityColumn,
    sortDir,
    sortKey,
    summaryCards,
    summaryUsage,
    toggleColumn,
    toggleSummaryCard,
    total,
    visibleColumns,
  } = input;

  // The same clock and the same mapper `SyncedSessionsTable` uses, so no two
  // Sessions stacks can disagree about a row. The staleness fold and the
  // Duration cell both read `now`, so the mapping is not a pure function of
  // `items` and TanStack's structural sharing would otherwise freeze both at
  // mount.
  const now = useCoarseNow(SESSION_DURATION_TICK_MS);
  // ISS-12471: the shell's scroll memory measures the content viewport, which
  // this route cannot overflow -- the grid band is the real scroller.
  const registerRouteScroller = useRouteScrollerRegistration();
  const foldActive = isSyncStateFoldActive(
    hideSessionGroupedColumn(visibleColumns, groupBy)
  );
  const rows = useMemo(
    () =>
      items.map((item) =>
        toSessionTableRowWithSyncFold(item, foldActive, { now })
      ),
    [items, foldActive, now]
  );

  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  // The same offline gate Desktop Branches applies to its tag writes.
  const isOnline = useOnlineStatus();
  const tagActions = useSessionsBulkTagActions(rows, !isOnline);
  const bulkActions = useSessionsRegisteredBulkActions({
    favorites,
    items,
    readOnly: !(isOnline && showLinkedEntityColumns),
    tagActions,
  });
  const { renderIssues, renderProjects } = useSessionLinkedEntitySeams({
    getIssueHref,
    itemById,
    rows,
    showLinkedEntityColumns,
  });

  // ISS-7869: the same connect ask the v1 strip carries. The surface OWNS the
  // strip on this branch, so the gate reaches it through `summaryCards` — the
  // shape the web v2 page already uses — and only the outcome banner stays out
  // here, where this branch's other pinned banners live.
  const { connectState, githubConnect, githubConnected } =
    useDesktopSessionsGitHubConnectGate(isAuthenticated);
  // Read HERE, in the branch that swaps on it, for the reason
  // `SessionsSummaryBand` records: the v1 band resolves its own gate rather than
  // taking a threaded boolean. That band cannot be reused as-is — it wraps the
  // strip, which now lives inside the surface — so this branch renders the tips
  // alone above it and drops the band's padding with them.
  const coachingTipsEnabled = useFeatureFlagEnabled(
    DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY
  );

  // ISS-9107 AC7 / ISS-9822 — a window change reaches the URL in ONE write.
  // "Clear filters" drops the explicit window in the SAME write as the cleared
  // facets, and a window PICK, which writes its own params and page reset, is
  // not followed by a second. Held in the shared host library so the web v2 host
  // reads this fold rather than hand-writing a second copy of the microtask rule
  // — the non-obvious half, and the way one click would come to resolve
  // differently on the two surfaces.
  const {
    onSurfaceCustomWindowChange,
    readPendingWindowClear,
    readPendingWindowPick,
  } = useSessionsWindowClearFold(handleCustomDateWindowChange);

  const searchTerm = search ?? "";
  const hostView: SessionsHostViewState = useMemo(
    () => ({
      dateRange,
      facets: facetFilters,
      groupBy,
      page,
      // The desktop shell has no `?userId=` scope: it shows one signed-in
      // reader's own sessions, so there is no owner to scope away and nothing
      // for the surface to chip.
      scopeUserId: null,
      search: searchTerm,
      secondarySorts,
      sortDir,
      sortKey,
      visibleColumns,
    }),
    [
      dateRange,
      facetFilters,
      groupBy,
      page,
      searchTerm,
      secondarySorts,
      sortDir,
      sortKey,
      visibleColumns,
    ]
  );

  const handleHostViewChange = useCallback(
    (next: SessionsHostViewState) => {
      const clearWindow = readPendingWindowClear();
      // The page a window PICK has already made true. The pick wrote the URL
      // itself — `?from=`/`?to=` and page 0 in one `replaceListParams` — but
      // `page` is read off the hash snapshot this render was handed, so inside
      // the same click it still names the pre-click page. Left there, the
      // surface's trailing `page: 0` reads as a move still to make, and the
      // router's `replacePage` writes again off that pre-click snapshot with no
      // window on it: a window picked from page 2+ was silently dropped.
      const pageIndex = readPendingWindowPick() ? 0 : page;
      applySessionsHostViewChange(
        next,
        {
          dateRange,
          facets: facetFilters,
          groupBy,
          pageIndex,
          scopeUserId: null,
          search: searchTerm,
          secondarySorts,
          sortDir,
          sortKey,
          visibleColumns,
        },
        {
          onScopeChange: (delta) => {
            handleScopeChange({ ...delta, clearWindow });
          },
          replacePage: setPage,
          setGroupBy,
          setSecondarySorts,
          setSort,
          toggleColumn,
        },
        // Clearing the window alone moves no other scope axis, so
        // the shared router would report no delta and nothing would write the
        // URL. It synthesizes one instead of this shell issuing a second
        // `replaceListParams`: two writes in one click both start from the
        // pre-click snapshot and the later one restores what the earlier removed.
        { pendingScopeClear: clearWindow }
      );
    },
    [
      dateRange,
      facetFilters,
      groupBy,
      handleScopeChange,
      page,
      readPendingWindowClear,
      readPendingWindowPick,
      searchTerm,
      secondarySorts,
      setGroupBy,
      setPage,
      setSecondarySorts,
      setSort,
      sortDir,
      sortKey,
      toggleColumn,
      visibleColumns,
    ]
  );

  /**
   * ISS-9107 AC8 / ISS-12455 — the surface speaks `SessionsListViewState`; this
   * shell speaks the host vocabulary its saved view persists. Converted at the
   * seam, in both directions, by the shared host store, which also HOLDS the
   * axes `SessionsHostViewState` cannot carry (the grouping sub-level, the
   * custom-field facet selections, the custom-field columns switched off) and
   * rejoins them onto the persisted half each render.
   *
   * Shared rather than re-written here: this shell previously held `grouping`
   * alone, so `toSessionsListViewState` fed the surface a built-in-only
   * `visibleColumnIds` and every custom-field header was filtered out against
   * it — the columns could not be shown, and `toSessionsHostViewState` stripped
   * the id again on each View-menu toggle, so they could not be turned on
   * either.
   */
  const { controlledView, resetLocalView } = useSessionsHostControlledView({
    customFields,
    hostView,
    listReadState,
    onHostViewChange: handleHostViewChange,
    total,
  });

  /**
   * A Reset that restores some of the view is the same lie as a control that
   * does not work: the reconcilers only drop the host-local copy when the
   * persisted PRIMARY dimension moves, and a reset from None back to None moves
   * nothing. So the host's half is cleared first, then the shell's own.
   */
  const handleResetView = useCallback(() => {
    resetLocalView();
    resetView();
  }, [resetLocalView, resetView]);

  const resolveSessionHref = useCallback(
    (row: { id: string }) => {
      const item = itemById.get(row.id);
      // A row we cannot match to an item gets the plain name, never a styled
      // link to nowhere.
      return item ? desktopSessionDetailHref(item) : null;
    },
    [itemById]
  );

  return (
    <>
      {/* FEA-3639 / ISS-5489: the two pinned banners are the shell's, not the
          table stack's, so they render on both branches. */}
      <SessionsFileAccessBanner />
      <DesktopSessionsConnectOutcome state={connectState} />
      {coachingTipsEnabled ? (
        <div className="px-4 pt-4 pb-3">
          <AgentCoachingTips lookbackDays={coachingLookbackDays} />
        </div>
      ) : null}

      {/* The v1 branch marks its scroll region busy while the list read is in
          flight; a reader on a screen reader must not lose that by turning the
          flag on. Keyed on the read itself rather than on v1's loading LABEL,
          which is the capability ISS-9106 restores and this branch does not
          have. */}
      <div
        aria-busy={
          isSessionsTableLoading && stallPhase !== "hard" ? "true" : undefined
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        <Profiler id="sessions_list" onRender={onRenderCommit}>
          <SessionsListSurfaceV2
            bulkActions={bulkActions.actions}
            className="min-h-0 flex-1"
            columnOrder={columnOrder}
            columnWidths={columnWidths}
            controlledView={controlledView}
            customDateWindow={customDateWindow}
            customFields={customFields}
            errorRecoveryAction={errorRecoveryAction}
            exportItem={sessionsExportItem}
            favorites={favorites}
            getSessionHref={resolveSessionHref}
            groupOptions={
              showPriorityColumn
                ? SESSIONS_HOST_GROUP_OPTIONS
                : SESSIONS_HOST_GROUP_OPTIONS_WITHOUT_PRIORITY
            }
            hasConnectedAgent={hasConnectedAgent}
            hasSessionsOutsideWindow={hasSessionsOutsideWindow}
            hiddenSummaryCards={hiddenSummaryCardIds}
            isLoading={isSummaryLoading}
            isPending={isSessionsTableLoading}
            isPlaceholderPage={isListPlaceholderPage}
            isSyncing={isSessionsSyncing}
            loadingLabel={tableLoadingLabel}
            maxOffset={maxOffset}
            /* ISS-9107 (whitlockk review): `SessionsView` sends this source only
               `sortBy`/`sortDir`, so a second rule would be persisted and shown
               over rows SQLite ordered by the first alone. Capped until the
               local query resolves the ordered list — ISS-8679, which makes the
               desktop source REFUSE a multi-rule request rather than answer it
               wrong, is the other half of this seam. */
            maxSortRules={1}
            onColumnOrderChange={onColumnOrderChange}
            onColumnWidthChange={onColumnWidthChange}
            onCustomDateWindowChange={onSurfaceCustomWindowChange}
            onPageSizeChange={onPageSizeChange}
            onResetView={handleResetView}
            onRetry={handleRetry}
            onTimezoneModeChange={handleTimezoneModeChange}
            onToggleSummaryCard={toggleSummaryCard}
            pageInfo={pageInfo}
            pageSize={pageSize}
            renderIssues={renderIssues}
            renderPriority={
              showPriorityColumn ? renderSessionPriorityCell : undefined
            }
            renderProjects={renderProjects}
            renderTags={renderTags}
            rows={rows}
            stallPhase={stallPhase}
            summaryCards={{
              ...summaryCards,
              authenticated: isAuthenticated,
              githubConnect,
              githubConnected,
              // ISS-11472: the rank is the band's, not this host's — the shared
              // set pins `wrapBelow: false` for every bar, and the passthrough
              // Omits the key so this shell cannot answer it differently from
              // the web one. ISS-10314's reason for that value is unchanged.
            }}
            tableScrollRef={registerRouteScroller}
            timezoneMode={timezoneMode}
            usage={summaryUsage}
          />
        </Profiler>
      </div>
      {bulkActions.confirmationDialog}
    </>
  );
}
