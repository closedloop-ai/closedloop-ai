"use client";

import type {
  AgentSessionListItem,
  AgentSessionUsageSummary,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionListPageInfo } from "@repo/api/src/types/agent-session-list-contract";
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { renderSessionPriorityCell } from "@repo/app/agents/components/sessions/session-priority-cell";
import { renderSessionTagsCell } from "@repo/app/agents/components/sessions/session-tags-cell";
import { SessionsListSurfaceV2 } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { useSessionLinkedEntitySeams } from "@repo/app/agents/components/sessions/use-session-linked-entity-seams";
import { useSessionsBulkTagActions } from "@repo/app/agents/components/sessions/use-sessions-bulk-tag-actions";
import { useSessionsFavoritesController } from "@repo/app/agents/components/sessions/use-sessions-favorites-controller";
import { useSessionsRegisteredBulkActions } from "@repo/app/agents/components/sessions/use-sessions-registered-bulk-actions";
import { useSessionOwnerNameResolver } from "@repo/app/agents/hooks/use-session-owner-name-resolver";
import { useSessionProjectNameResolver } from "@repo/app/agents/hooks/use-session-project-name-resolver";
import { useSessionsCustomFieldsController } from "@repo/app/agents/hooks/use-sessions-custom-fields-controller";
import { useSessionsHostControlledView } from "@repo/app/agents/hooks/use-sessions-host-controlled-view";
import type { SessionCustomDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { hideSessionGroupedColumn } from "@repo/app/agents/lib/session-grouping";
import {
  isSyncStateFoldActive,
  toSessionTableRowWithSyncFold,
} from "@repo/app/agents/lib/session-status-fold";
import type { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import {
  SESSIONS_HOST_GROUP_OPTIONS,
  type SessionsHostViewState,
} from "@repo/app/agents/lib/sessions-list-view-adapter";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import type { TimezoneMode } from "@repo/app/shared/lib/date-window-timezone-mode";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useMemo } from "react";

/**
 * ISS-10585: This host's cloud read is what makes the shared Sessions footer render the
 * org population; the surface itself cannot tell org from this-device (operator
 * ruling, 2026-09-18).
 */
export const SESSIONS_LIST_FOOTER_COUNT_SITE =
  SESSION_COUNT_SITE.SessionsListFooterOrg;

/**
 * ISS-7052 Part A: the web Sessions listing on the Grid Table v2 stack.
 *
 * Sibling of `./sessions-table.tsx` — that wrapper adapts the page's rows onto
 * the v1 `SyncedSessionsTable`, this one adapts the SAME page state onto
 * `SessionsListSurfaceV2`. Both live here rather than in `@repo/app` because
 * both build org-slug routes, which is a property of the web shell.
 *
 * The v2 surface owns the WHOLE listing — toolbar, metric strip, table,
 * pagination — where v1 owns only the table and leaves the page to compose the
 * other three. That is why this is a host rather than a drop-in table swap, and
 * why the page's flag branch replaces four regions with one component.
 *
 * The page keeps owning the query. It filters, sorts and paginates server-side
 * and persists all of it into a saved view, so it drives the surface through
 * `controlledView` and reports `totalRows` — which is what tells the surface its
 * `rows` are one server page rather than the whole population, so it must not
 * re-filter or re-rank them.
 */
export function SessionsListV2Host({
  columnOrder,
  columnWidths,
  customDateWindow,
  errorRecoveryAction,
  exportItem,
  getSessionHref,
  getIssueHref,
  hasConnectedAgent,
  hasSessionsOutsideWindow,
  hiddenSummaryCards,
  hostView,
  isListPending,
  onTimezoneModeChange,
  timezoneMode,
  isPlaceholderPage,
  listReadState,
  items,
  onColumnOrderChange,
  onColumnWidthChange,
  onCustomDateWindowChange,
  onHostViewChange,
  onPageSizeChange,
  onResetView,
  onToggleSummaryCard,
  onboardingAction,
  onRetry,
  pageInfo,
  pageSize,
  projectFacetEnabled,
  summaryCards,
  summaryIsLoading,
  tableScrollRef,
  total,
  usage,
}: {
  /** FEA-4021: persisted DATA-column order; with the handler, headers reorder. */
  columnOrder?: readonly string[];
  /** ISS-9567: persisted per-column widths; with the handler, a resize survives a reload. */
  columnWidths?: Readonly<Record<string, number>>;
  /**
   * ISS-9822: the explicit `?from=`/`?to=` window the page resolved, paired with
   * {@link onCustomDateWindowChange}. Both or neither: the toolbar renders the
   * Custom control off the HANDLER's presence alone and counts the window as an
   * active narrower off the VALUE alone, so one without the other is either a
   * control that cannot report as active or an active narrower with no control.
   */
  customDateWindow?: SessionCustomDateWindow | null;
  errorRecoveryAction?: ReactNode;
  /** FEA-4217: the CSV export row, which the v1 toolbar's options menu carried. */
  exportItem?: ReactNode;
  getIssueHref?: (artifact: SessionLinkedArtifact) => string | null;
  getSessionHref: (item: AgentSessionListItem) => string;
  hasConnectedAgent?: boolean;
  /** ISS-11913 @see SessionsListSurfaceV2Props.hasSessionsOutsideWindow */
  hasSessionsOutsideWindow?: boolean;
  /**
   * FEA-4217: the summary cards the reader switched off. A top-level prop rather
   * than a `summaryCards` key because the surface's options menus read the same
   * set the strip does — routing it through the strip's passthrough bag would
   * leave the menus reading a second copy.
   */
  hiddenSummaryCards?: ReadonlySet<string>;
  /** The page's persisted view state, in the page's own vocabulary. */
  hostView: SessionsHostViewState;
  isListPending: boolean;
  /**
   * ISS-8635: the rendered rows are the PREVIOUS page's, held by
   * `keepPreviousData` while the page named by the index loads. Query state the
   * surface cannot observe for itself, and ISS-9216 made it the ONLY thing this
   * host says about the readout: the surface states its own range and suppresses
   * it on this signal (#4480), rather than taking a rendered sentence from here.
   */
  isPlaceholderPage?: boolean;
  listReadState: SessionsListReadState;
  items: readonly AgentSessionListItem[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  /** @see customDateWindow */
  onCustomDateWindowChange?: (next: SessionCustomDateWindow | null) => void;
  onHostViewChange: (next: SessionsHostViewState) => void;
  /** ISS-7052 Part A: rows-per-page, which the v1 footer offered under this same flag. */
  onPageSizeChange?: (pageSize: number) => void;
  /** ISS-9555: the list read's own account of which page it served. */
  pageInfo?: AgentSessionListPageInfo;
  /**
   * ISS-7052 Part A (tamsinb review): the page's `resetView`, which the v1 host
   * has always handed its toolbar. The v2 surface replaces that toolbar, so
   * omitting it here is how the flag would take the reader's one-click path back
   * to shipped defaults away rather than swap a table stack.
   */
  onResetView?: () => void;
  onRetry?: () => void;
  /** @see hiddenSummaryCards */
  onToggleSummaryCard?: (cardId: string) => void;
  onboardingAction?: ReactNode;
  pageSize: number;
  /**
   * ISS-5355: the Project facet's own flag. The page keeps sending `projectIds`
   * in its query when it is on, so the facet and its chip have to exist here or
   * a restored/linked project filter narrows the list with nothing naming it.
   */
  /** ISS-9619 — forwarded verbatim; the PAGE owns the gate read. */
  onTimezoneModeChange?: (mode: TimezoneMode) => void;
  /** @see onTimezoneModeChange */
  timezoneMode?: TimezoneMode;
  projectFacetEnabled?: boolean;
  /** ISS-7355: the full summary-card prop set the page already assembles. */
  summaryCards?: ComponentProps<typeof SessionsListSurfaceV2>["summaryCards"];
  /**
   * The summary strip's own loading gate — the surface decides this one, so it
   * is not in `summaryCards`. FEA-4177: the page folds `isPlaceholderData` in
   * here so a filter-scope change never shows the old scope's totals beside the
   * new scope's rows.
   */
  summaryIsLoading: boolean;
  /**
   * ISS-7052 Part A: the surface's scrolling table band, so the page's
   * `useSessionsHistoryScroll` observes the region that actually scrolls. The v1
   * host exposed its own scroll container for the same reason.
   */
  tableScrollRef?: (node: HTMLElement | null) => void;
  /** Rows the SERVER matched across every page — see `controlledView.totalRows`. */
  total: number;
  usage: AgentSessionUsageSummary | undefined;
}) {
  // The same clock the v1 adapter passes in, for the same reason: the staleness
  // fold and the Duration cell both read `now`, so the row mapping is not a pure
  // function of `items` and TanStack's structural sharing would otherwise freeze
  // both at mount. See `SESSION_DURATION_TICK_MS`.
  const now = useCoarseNow(SESSION_DURATION_TICK_MS);
  const foldActive = isSyncStateFoldActive(
    hideSessionGroupedColumn(hostView.visibleColumns, hostView.groupBy)
  );
  const rows = useMemo(
    () =>
      items.map((item) =>
        toSessionTableRowWithSyncFold(item, foldActive, { now })
      ),
    [items, foldActive, now]
  );

  const customFields = useSessionsCustomFieldsController(items);

  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  // This host reads the CLOUD list, whose rows carry `project` and
  // `linkedArtifacts`, so it can fill both columns.
  const { renderIssues, renderProjects } = useSessionLinkedEntitySeams({
    getIssueHref,
    itemById,
    rows,
    showLinkedEntityColumns: true,
  });

  // ISS-4974: the same resolver the chip row uses, so an Owner with no usage row
  // in the active window is never named two different ways. ISS-8037: read off
  // `hostView`, the same value the controlled view carries, so the name and the
  // chip that wears it cannot be derived from two different scopes.
  const resolveOwnerName = useSessionOwnerNameResolver({
    scopeUserId: hostView.scopeUserId,
    selectedUserIds: hostView.facets.userIds,
    usage,
  });
  // ISS-5355: the Project counterpart, so a project the active window has no
  // usage row for is named rather than rendered as a raw uuid. Gated on the same
  // flag that decides whether the facet exists at all, so a viewer without it
  // issues no project read.
  const resolveProjectName = useSessionProjectNameResolver({
    enabled: projectFacetEnabled === true,
    selectedProjectIds: hostView.facets.projectIds,
    usage,
  });

  // ISS-8037: `scopeUserId` rides this controller like every other axis, which
  // is what makes its chip's remove real. The page owns `?userId=` as a URL
  // param, so the removal is a param STRIP rather than a facet write — but the
  // surface still reports it as one settled view state per event (its `staged`
  // ref composes "Clear all"'s several synchronous writes into that), so the
  // page performs the strip inside the SAME `replaceListParams` call that
  // carries the cleared facets. A remover wired beside this controller instead
  // would be a second write off the pre-click search-params snapshot, putting
  // `?userId=` back over a chip row that had just dropped it.
  /**
   * ISS-8335 / FEA-4222 / ISS-8216: the axes the page's saved view has no
   * column for — the sub-group level, the custom-field facet selections, and
   * the custom-field columns the reader switched off.
   *
   * `SESSIONS_VIEW_STATE_AXIS_OWNERS` classifies each of them, and
   * `useSessionsHostControlledView` is where they are held and rejoined onto
   * the page's persisted half, for every shell that mounts this surface. They
   * were not "unimplemented" before that store existed — the surface rendered
   * every one of their controls, reported every change, and
   * `toSessionsHostViewState` dropped the value on the floor, so the sub-group
   * level and the second sort rule each moved and snapped straight back.
   *
   * Component state rather than the URL deliberately, for the axes that remain:
   * persisting them is a schema change to the saved view that belongs to whoever
   * owns that schema, and a sub-group level does not change which ROWS the
   * server returns — it rearranges rows the query already produced.
   *
   * The second SORT rule was there too and is not any more (codex review
   * PRRT_kwDOQ4gDpM6dLntW). It is the one axis that store could not honestly
   * hold: the surface is server-driven, so a rule the host merely remembered
   * reached no query and reordered nothing, and the toolbar advertised "Status,
   * then Owner" over rows the Owner rule had never touched. It now rides
   * `SessionsHostViewState.secondarySorts` into the page's saved view and onto
   * the wire, where the server applies it — see `session-sort-rules.ts`.
   */
  const { controlledView, resetLocalView } = useSessionsHostControlledView({
    customFields,
    hostView,
    listReadState,
    onHostViewChange,
    total,
  });

  /**
   * ISS-8335 (codex review cid 3880961540): "Reset view" has to reach BOTH
   * stores.
   *
   * The page's handler restores what the page persists, and passing it through
   * unchanged left every host-local axis exactly where the reader had put it —
   * the sub-group kept banding the table, a hidden custom column stayed hidden.
   * The reconcilers cannot cover this: they drop the host's copy only when the
   * page's PRIMARY dimension MOVES, and a reset from `groupBy: None` back to
   * `groupBy: None` moves nothing. A reset that restores some of the view is
   * the same lie as a control that does not work.
   */
  const handleResetView = useCallback(() => {
    resetLocalView();
    onResetView?.();
  }, [onResetView, resetLocalView]);

  const tagActions = useSessionsBulkTagActions(rows);
  /**
   * ISS-8335: the row star, which the surface has always rendered for a host
   * that hands it a controller and silently omits for one that does not.
   *
   * ISS-12691 (marisolashgrove review cid 4327728360): the mechanics moved into
   * `useSessionsFavoritesController`, which Desktop's host now calls too.
   * `true` is this host's claim that its cloud list projection's session ids
   * ARE artifact ids — the precondition `SessionsFavoriteController`
   * documents.
   */
  const favorites = useSessionsFavoritesController(true);
  const bulkActions = useSessionsRegisteredBulkActions({
    favorites,
    items,
    tagActions,
  });

  const resolveSessionHref = useCallback(
    (row: { id: string }) => {
      const item = itemById.get(row.id);
      // FEA-4051: a row we cannot match to an item gets the plain name, never a
      // styled link to nowhere.
      return item ? getSessionHref(item) : null;
    },
    [itemById, getSessionHref]
  );

  return (
    <>
      <SessionsListSurfaceV2
        bulkActions={bulkActions.actions}
        columnOrder={columnOrder}
        columnWidths={columnWidths}
        controlledView={controlledView}
        customDateWindow={customDateWindow}
        customFields={customFields}
        errorRecoveryAction={errorRecoveryAction}
        exportItem={exportItem}
        favorites={favorites}
        getSessionHref={resolveSessionHref}
        // ISS-7052 Part A: only the dimensions `toSessionsHostViewState` can store.
        // The page persists ONE `SessionGroupBy`, so offering Model — which that
        // adapter coerces back to None — would be a control that snaps back.
        groupOptions={SESSIONS_HOST_GROUP_OPTIONS}
        hasConnectedAgent={hasConnectedAgent}
        hasSessionsOutsideWindow={hasSessionsOutsideWindow}
        hiddenSummaryCards={hiddenSummaryCards}
        includeProjectFilter={projectFacetEnabled}
        isLoading={summaryIsLoading}
        isPending={isListPending}
        isPlaceholderPage={isPlaceholderPage}
        maxOffset={SESSION_LIST_MAX_OFFSET}
        onboardingAction={onboardingAction}
        onColumnOrderChange={onColumnOrderChange}
        onColumnWidthChange={onColumnWidthChange}
        onCustomDateWindowChange={onCustomDateWindowChange}
        onPageSizeChange={onPageSizeChange}
        onResetView={onResetView ? handleResetView : undefined}
        onRetry={onRetry}
        onTimezoneModeChange={onTimezoneModeChange}
        onToggleSummaryCard={onToggleSummaryCard}
        pageInfo={pageInfo}
        pageSize={pageSize}
        renderIssues={renderIssues}
        // ISS-10332: the cloud projection carries `priority` and this host's HTTP
        // source writes it back, so the editor is mounted; shown by default
        // (operator ruling 5, 2026-09-21).
        renderPriority={renderSessionPriorityCell}
        renderProjects={renderProjects}
        // ISS-8712: same opt-in as the v1 host — this surface is fed by the cloud
        // projection the tag cell reads, and is where the write can complete.
        renderTags={renderSessionTagsCell}
        resolveOwnerName={resolveOwnerName}
        resolveProjectName={resolveProjectName}
        rows={rows}
        summaryCards={summaryCards}
        tableScrollRef={tableScrollRef}
        timezoneMode={timezoneMode}
        usage={usage}
      />
      {bulkActions.confirmationDialog}
    </>
  );
}
