import { BranchesListBody } from "@repo/app/branches/components/branches-list-body";
import { BranchesSummaryCards } from "@repo/app/branches/components/branches-summary-cards";
import { BranchesToolbar } from "@repo/app/branches/components/branches-toolbar";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import {
  APPROVED_BRANCH_PAGE_SIZE,
  useUrlSyncedBranchFilterState,
} from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchSavedViews } from "@repo/app/branches/hooks/use-branch-saved-views";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import {
  useBranchCohortAnalytics,
  useBranchesPageData,
} from "@repo/app/branches/hooks/use-branches";
import {
  bindApprovedBranchCohortAnalytics,
  buildApprovedBranchCohortRequest,
} from "@repo/app/branches/lib/approved-branch-cohort";
import { resolveBranchListBanner } from "@repo/app/branches/lib/branch-list-banner";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import {
  type BranchSortDir,
  type BranchSortKey,
  filterBranchRowsByWindow,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import { selectVisibleWireRows } from "@repo/app/branches/lib/filtered-branch-analytics";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import {
  type DateRange,
  getStableUtcDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import { TablePaginationFooter } from "@closedloop-ai/design-system/components/ui/table-pagination-footer";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCloudReadCutoverBadge } from "../../shared-agent-sessions/use-cloud-read-cutover-badge";
import { useOnlineStatus } from "../../shared-agent-sessions/use-online-status";
import {
  desktopBranchDetailHref,
  desktopBranchSessionsHref,
} from "../../shared-branches/branch-hrefs";
import { DesktopBranchesSource } from "../../shared-branches/desktop-branches-source";
import { DesktopCloudHydrationStatus } from "../../shared-branches/desktop-cloud-hydration-status";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { DASHBOARD_METRIC_CARD_CLASS_NAME } from "../layout/page-shell";
import { useDesktopGitHubConnect } from "./use-desktop-github-connect";

/**
 * Branches view — desktop counterpart of the web `/branches` page, rendering
 * the shared `BranchesTable` + `BranchesToolbar` from the `@repo/app`
 * branches slice so both surfaces stay identical (PRD-454). Rows come from
 * `useBranchesPageData()` (the authenticated canonical cloud source or the
 * signed-out local `BranchesDataSource`, combined list + analytics read —
 * FEA-3056 follow-up) mapped through
 * `adaptBranchRows` into the render row shape the scaffold expects.
 *
 * Auth-driven source selection (PLN-1138 D-E / Phase 2) lives in
 * `DesktopBranchesSource`: a complete authenticated identity keeps the org
 * cloud source across connectivity changes so a matching canonical cache can
 * remain readable; an uncached offline read pauses. Signed-out or incomplete
 * identity reads the local SQLite source. Both sources return the complete list
 * (no server `limit`/`offset`), so the client-side window → sort → filter →
 * paginate below applies uniformly and the ordering stays identical across
 * modes.
 *
 * Layout: a first-class time window + filter toolbar on top, then the summary
 * cards (which reflect the window), then the table.
 */

// Five summary cards (vs the Sessions view's four), so a five-column top end
// instead of DASHBOARD_GRID_CLASS_NAME's four. Five is odd, so a two-column
// tier reflows to 2+2+1 and orphans the last card (Median PR size) at half
// width with an empty cell beside it (FEA-2935).
//
// ISS-4787 follow-up: the pinned `lg:3 → xl:5` tiers that replaced it are gone
// too — the column count is DERIVED from the shared `--summary-card-min` floor,
// which self-limits at every width and can never squeeze a card under the width
// the strip's two-line label reservation assumes. The Sessions strip one nav click
// away lays out from the same floor, so the two desktop summary strips keep the
// same card rhythm.
//
// Stage review: an earlier version of this note claimed "the web twin already
// derives its columns from the same floor". That is true of web SESSIONS and NOT
// of web BRANCHES — `apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx`
// still pins `grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5` over an 11rem
// per-card floor. Bringing that page onto this floor is tracked separately and
// is deliberately not folded in here rather than being claimed as already done.
const DESKTOP_BRANCHES_LIST_STALE_TIME_MS = 90_000;

export function BranchesView({
  dataSource,
}: {
  /** Test seam; production selects local vs cloud by mode (DesktopBranchesSource). */
  dataSource?: BranchesDataSource;
} = {}) {
  return (
    <DesktopBranchesSource override={dataSource}>
      <BranchesViewContent />
    </DesktopBranchesSource>
  );
}

function BranchesViewContent() {
  const isOnline = useOnlineStatus();
  const { connectState, connectGitHub: handleConnectGitHub } =
    useDesktopGitHubConnect("/branches");
  const { dateRange, setDateRange } = useSharedDateRange("desktop", "30d");
  // The local branches LIST op does not yet window server-side, so the table is
  // windowed client-side on the raw activity timestamp. Rows with no timestamp
  // (hand-built fixtures) pass through. The analytics/usage ops DO honor the
  // window server-side now (FEA-2155), so the summary cards — fed the same
  // `startDate` — reconcile with this windowed table.
  const { startDate, endDate } = getStableUtcDateWindowForRange(dateRange);
  const pageDataFilters = useMemo(
    () => ({ endDate, startDate }),
    [endDate, startDate]
  );
  // Combined list + analytics read (FEA-3056 follow-up): the Branches screen
  // mounts the table and the summary cards together, so one query shares one
  // underlying read instead of each independently re-scanning the same rows.
  const {
    data: pageData,
    isPending,
    isError,
    refetch,
  } = useBranchesPageData(pageDataFilters, {
    // FEA-4177: the combined query only errors when the LIST half fails (the
    // analytics half is best-effort — see `BranchesPageData`), so `isError` drives
    // the table alone. The summary cards get their own error below so an
    // analytics-only failure degrades the cards without blanking the table.
    refetchOnWindowFocus: true,
    staleTime: DESKTOP_BRANCHES_LIST_STALE_TIME_MS,
    // Keep the previous window's rows on screen while an uncached date range
    // loads, instead of blanking the table via isPending on every switch.
    placeholderData: keepPreviousData,
  });
  const data = pageData?.list;
  // ISS-5477: the same cutover explanation the Dashboard and Sessions show.
  const readSourceBadge = useCloudReadCutoverBadge(data?.readSource);
  const rows = useMemo(
    () =>
      adaptBranchRows(data?.items ?? [], {
        preferCanonicalLastActive: true,
      }),
    [data]
  );

  // Every row links into the branch-detail route (`/branches/:id`); the port
  // Link renders it hash-prefixed for the browser-deferred click paths.
  const getBranchHref = desktopBranchDetailHref;
  // FEA-4259: the Linked Sessions count links to the branch detail's Sessions
  // tab (`/branches/:id?tab=sessions-timeline`), which lists exactly that
  // branch's sessions.
  const getSessionsHref = desktopBranchSessionsHref;

  const {
    sortKey,
    sortDir,
    visibleColumns,
    hiddenColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    setSort,
    toggleColumn,
    resetColumns,
    applyArrangement,
  } = useBranchViewState("desktop", true);

  // Column-header clicks set both the sort key and direction.
  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);

  // Every branch (merged, agent-worktree, bot) always shows — the client-side
  // window is the only pre-sort narrowing. Window → sort → filter → paginate.
  const visibleRows = useMemo(
    () => filterBranchRowsByWindow(rows, startDate, endDate),
    [rows, startDate, endDate]
  );

  // Client-side sort feeds the filter/pagination hook (window → sort → filter →
  // paginate).
  const sortedRows = useMemo(
    () => sortBranchRows(visibleRows, sortKey, sortDir, true),
    [visibleRows, sortKey, sortDir]
  );

  // FEA-3560: seed-from-URL + URL write-through live inside the hook, shared
  // with the web Branches page so the glue can't drift per surface.
  const {
    filters,
    page,
    setPage,
    filteredRows,
    pagedRows,
    total,
    totalPages,
    from,
    to,
    handleFiltersChange,
  } = useUrlSyncedBranchFilterState(
    sortedRows,
    APPROVED_BRANCH_PAGE_SIZE,
    true
  );

  // FEA-4180: named saved views (order + visibility + sort + filters). On
  // desktop the time window lives in the SHARED cross-view store
  // (`useSharedDateRange`), not the view-state extras — so applying a switched
  // view routes its `dateRange` through the shared `setDateRange` while sort +
  // columns + order go through `applyArrangement`. Capture reads the same shared
  // `dateRange`, so a saved-then-switched view round-trips the window too.
  const applySavedArrangement = useCallback(
    (arrangement: {
      sortKey: BranchSortKey;
      sortDir: BranchSortDir;
      dateRange: DateRange;
      hiddenColumns: string[];
      columnOrder: string[];
    }) => {
      applyArrangement(arrangement);
      setDateRange(arrangement.dateRange);
    },
    [applyArrangement, setDateRange]
  );
  const savedViews = useBranchSavedViews(
    "desktop",
    {
      sortKey,
      sortDir,
      dateRange,
      hiddenColumns,
      columnOrder: [],
      filters,
    },
    {
      applyArrangement: applySavedArrangement,
      applyFilters: handleFiltersChange,
    },
    true
  );

  const filteredWireRows = useMemo(
    () => selectVisibleWireRows(data?.items ?? [], filteredRows),
    [data?.items, filteredRows]
  );
  const unfilteredWireRows = useMemo(
    () => selectVisibleWireRows(data?.items ?? [], visibleRows),
    [data?.items, visibleRows]
  );
  const cohortRequest = useMemo(
    () =>
      buildApprovedBranchCohortRequest({
        filteredRows: filteredWireRows,
        unfilteredRows: unfilteredWireRows,
        filters,
        dateRange,
        startDate,
        endDate,
      }),
    [
      filteredWireRows,
      unfilteredWireRows,
      filters,
      dateRange,
      startDate,
      endDate,
    ]
  );
  const {
    data: cohortResponse,
    isError: cohortIsError,
    isPending: cohortIsPending,
    refetch: refetchCohort,
  } = useBranchCohortAnalytics(cohortRequest, {
    enabled: pageData?.analytics !== undefined,
    refetchOnWindowFocus: true,
    staleTime: DESKTOP_BRANCHES_LIST_STALE_TIME_MS,
  });

  // ISS-5253: the approved cards read canonical current/prior metrics for the
  // exact date-windowed, facet-filtered Branch IDs before pagination. A missing
  // or mismatched producer response retains only row-provable values and never
  // substitutes whole-list Session spend for the selected cohort.
  const filteredAnalytics = useMemo(
    () =>
      bindApprovedBranchCohortAnalytics({
        analytics: pageData?.analytics,
        filteredRows: filteredWireRows,
        unfilteredRows: unfilteredWireRows,
        filters,
        sessionCostUsd: data?.sessionCostUsd,
        request: cohortRequest,
        response: cohortResponse,
      }),
    [
      pageData?.analytics,
      filteredWireRows,
      unfilteredWireRows,
      filters,
      data?.sessionCostUsd,
      cohortRequest,
      cohortResponse,
    ]
  );

  // FEA-4177: the analytics half is best-effort — when only it fails the combined
  // read still resolves the list (`isError` stays false so the table renders) and
  // flags `analyticsError`. Surface that as the summary cards' own error so they
  // degrade to "Unavailable" while the table keeps rendering. Guard on missing
  // analytics so a partial resolve never renders stale-zero KPIs.
  const summaryAnalyticsErrored =
    ((pageData?.analyticsError ?? false) && !pageData?.analytics) ||
    (cohortRequest !== null && cohortIsError);
  const summaryAnalyticsPending =
    isPending || (cohortRequest !== null && cohortIsPending);

  // Reset pagination when dateRange changes — covers both local toolbar changes
  // AND cross-tab StorageEvent updates from Dashboard/Sessions.
  const dateRangeRef = useRef(dateRange);
  useEffect(() => {
    if (dateRangeRef.current !== dateRange) {
      dateRangeRef.current = dateRange;
      setPage(0);
    }
  }, [dateRange, setPage]);

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
  };

  // Distinguish in-flight / failed reads from a genuinely empty result. Without
  // this, a pending or errored IPC read collapses into "No branches match…" with
  // a "0-0 of 0" counter — reading as "you have no branches" rather than "still
  // loading" / "load failed".
  const isResolved = !(isPending || isError);

  // Informational banner derived from the WIRE rows (not the adapted render
  // rows) via the shared rule: no repo identity → connect-GitHub; repos but no
  // PR linkage → net-new. See `resolveBranchListBanner`.
  const hasRows = rows.length > 0;
  // Depends only on `data`, so memoize alongside rows/sortedRows —
  // otherwise it re-iterates the corpus on every sort/filter/page render.
  const banner = useMemo(
    () => resolveBranchListBanner(data?.items ?? []),
    [data]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">Branches</h1>
      {/* Filter bar — flush to the top of the content area with a full-width
          bottom border. Fixed (outside the scroll region) so it always stays. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <BranchesToolbar
          approved
          dateRange={dateRange}
          filters={filters}
          onDateRangeChange={handleDateRangeChange}
          onFiltersChange={handleFiltersChange}
          onResetView={resetColumns}
          onToggleColumn={toggleColumn}
          readSource={data?.readSource}
          readSourceDetail={readSourceBadge.detail}
          readSourceIncomplete={readSourceBadge.incomplete}
          rows={visibleRows}
          savedViews={savedViews}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Scroll region — cards + banners + table share one bounded scroll
          container (both axes). The cards scroll up and away; the GridTable's
          sticky column header then pins to the top of the region, right under
          the filter bar. The horizontal scrollbar sits at the region's bottom,
          always visible. The cards reflect the window via the shared
          `pageDataFilters`; the "vs. prior 30 days" delta only shows at the
          30-day window. */}
      <section
        aria-label="Branches"
        className="min-h-0 flex-1 overflow-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: COMMON-016 requires the two-axis scroll region itself to be keyboard-focusable.
        tabIndex={0}
      >
        {/* `sticky left-0` pins the cards to the left during horizontal scroll
            (so the wide table scrolls under them) while they still scroll away
            vertically. */}
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          <BranchesSummaryCards
            analytics={filteredAnalytics.analytics}
            approved
            approvedComparisonSuppressedByFilter={
              filteredAnalytics.comparisonSuppressedByFilter
            }
            cardClassName={DASHBOARD_METRIC_CARD_CLASS_NAME}
            isError={isError || summaryAnalyticsErrored}
            isPending={summaryAnalyticsPending}
            onConnectGitHub={handleConnectGitHub}
            showDelta={dateRange === "30d"}
            wrapBelow
          />
          {/* FEA-4177: analytics-only failure (list fine). The cards degrade to
              "Unavailable" above, but a silent dimmed row leaves the user with no
              reason and no way back — mirror the list's own Retry with a short
              honest line plus a retry that re-runs the same combined read. */}
          {summaryAnalyticsErrored ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-[var(--muted-foreground)] text-xs">
              <span>Couldn't load the summary metrics.</span>
              <Button
                onClick={() => {
                  refetch();
                  refetchCohort();
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          ) : null}
          <DesktopConnectStatus state={connectState} variant="list" />
          <DesktopCloudHydrationStatus rows={data?.items ?? []} />
          {isResolved && banner === "connect-github" ? (
            <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2">
              <ConnectGitHubIndicator compact onConnect={handleConnectGitHub} />
            </div>
          ) : null}
          {isResolved && banner === "net-new" ? (
            <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-[var(--muted-foreground)] text-xs">
              These branches are tracked locally with no linked pull request yet
              — the metrics shown are net-new.
            </div>
          ) : null}
        </div>

        <BranchesListBody
          allRows={filteredRows}
          approved
          columnOrder={columnOrder}
          columnWidths={columnWidths}
          getBranchHref={getBranchHref}
          getSessionsHref={getSessionsHref}
          hasRows={hasRows}
          hasWindow={startDate !== undefined}
          isError={isError}
          isPending={isPending}
          items={pagedRows}
          onColumnOrderChange={setColumnOrder}
          onColumnWidthChange={setColumnWidth}
          onRetry={() => {
            refetch();
          }}
          onShowAllTime={() => handleDateRangeChange("all")}
          onSort={handleSort}
          sortBy={sortKey}
          sortDir={sortDir}
          tagsReadOnly={!isOnline}
          visibleColumns={visibleColumns}
          windowedEmptyIsNoMatches={
            startDate !== undefined && visibleRows.length === 0
          }
        />
      </section>

      {/* Fixed footer — page controls, always visible (8px horizontal padding).
          ISS-4681: the shared `TablePaginationFooter` shell, with the desktop
          list's tighter padding and `shrink-0` as the only delta. The approved
          List reports its client-filtered cohort in the readout. */}
      {isResolved && total > 0 ? (
        <TablePaginationFooter
          className="shrink-0 px-2 py-2"
          onPageChange={setPage}
          page={page}
          readout={`${from}–${to} of ${total}`}
          totalPages={totalPages}
        />
      ) : null}
    </div>
  );
}
