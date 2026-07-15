import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination";
import {
  BranchCloudHydrationStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { BranchesSummaryCards } from "@repo/app/branches/components/branches-summary-cards";
import { BranchesTable } from "@repo/app/branches/components/branches-table";
import { BranchesToolbar } from "@repo/app/branches/components/branches-toolbar";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesLiveBridge } from "@repo/app/branches/data-source/branches-live-bridge";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { useBranchFilterState } from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import { useBranches } from "@repo/app/branches/hooks/use-branches";
import { resolveBranchListBanner } from "@repo/app/branches/lib/branch-list-banner";
import type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import {
  type BranchSortDir,
  type BranchSortKey,
  filterBranchRowsByWindow,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { desktopBranchDetailHashHref } from "../../shared-branches/branch-hrefs";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { createLocalBranchesDataSource } from "../../shared-branches/local-branches-data-source";
import { DASHBOARD_METRIC_CARD_CLASS_NAME } from "../layout/page-shell";
import { useDesktopGitHubConnect } from "./use-desktop-github-connect";

/**
 * Branches view — desktop counterpart of the web `/branches` page, rendering
 * the shared `BranchesTable` + `BranchesToolbar` from the `@repo/app`
 * branches slice so both surfaces stay identical (PRD-454). Rows come from
 * `useBranches()` (the injected local `BranchesDataSource` over IPC) mapped
 * through `adaptBranchRows` into the render row shape the scaffold expects.
 *
 * Auth-based source selection (Sessions precedent): v1 always injects the local
 * source. When the new desktop auth lands, the provider swaps to
 * `createHttpBranchesDataSource` with no hook/key/component change.
 *
 * Layout: a first-class time window + filter toolbar on top, then the summary
 * cards (which reflect the window), then the table.
 */

// Five summary cards (vs the Sessions view's four), so a five-column top end
// instead of DASHBOARD_GRID_CLASS_NAME's four. Five is odd, so a two-column
// tier reflows to 2+2+1 and orphans the last card (Median PR size) at half
// width with an empty cell beside it (FEA-2935). Skip two columns entirely:
// stack in one column, then jump straight to three (5 → 3+2) and finally five,
// so every tier lays the row out cleanly and in-bounds. The three-column tier
// is gated at `lg`, not `md`: the desktop sidebar is a 16rem `md:block` column,
// so just above 768px the content area is only ~512px — too narrow for three
// ~160px cards. `lg` is the first breakpoint with room for the 3-col layout
// once the sidebar is accounted for.
const CARDS_GRID_CLASS_NAME =
  "grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5";
const DESKTOP_BRANCHES_LIST_STALE_TIME_MS = 90_000;

export function BranchesView({
  dataSource,
}: {
  /** Test seam; production injects the local IPC source from `window.desktopApi`. */
  dataSource?: BranchesDataSource;
} = {}) {
  const [resolvedDataSource] = useState(
    () => dataSource ?? createLocalBranchesDataSource(window.desktopApi)
  );

  return (
    <BranchesDataSourceProvider dataSource={resolvedDataSource}>
      {/* Refreshes the branch list/usage queries off the local DB's
          desktop:db:changed push (no-op on the future HTTP source). */}
      <BranchesLiveBridge />
      <BranchesViewContent />
    </BranchesDataSourceProvider>
  );
}

function BranchesViewContent() {
  const { connectState, connectGitHub: handleConnectGitHub } =
    useDesktopGitHubConnect("/branches");
  const { data, isPending, isError } = useBranches(
    {},
    {
      refetchOnWindowFocus: true,
      staleTime: DESKTOP_BRANCHES_LIST_STALE_TIME_MS,
    }
  );
  const rows = useMemo(() => adaptBranchRows(data?.items ?? []), [data]);

  // Every row links into the branch-detail route (`#/branches/:id`).
  const getBranchHref = desktopBranchDetailHashHref;

  const { dateRange, setDateRange } = useSharedDateRange("desktop");
  const { sortKey, sortDir, visibleColumns, setSort, toggleColumn } =
    useBranchViewState("desktop");

  // Column-header clicks set both the sort key and direction.
  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);

  // The local branches LIST op does not yet window server-side, so the table is
  // windowed client-side on the raw activity timestamp. Rows with no timestamp
  // (hand-built fixtures) pass through. The analytics/usage ops DO honor the
  // window server-side now (FEA-2155), so the summary cards — fed the same
  // `startDate` via `analyticsFilters` — reconcile with this windowed table.
  const startDate = useMemo(() => getStartDateForRange(dateRange), [dateRange]);
  const windowedRows = useMemo(
    () => filterBranchRowsByWindow(rows, startDate),
    [rows, startDate]
  );

  // Client-side sort feeds the filter/pagination hook (window → sort → filter →
  // paginate).
  const sortedRows = useMemo(
    () => sortBranchRows(windowedRows, sortKey, sortDir),
    [windowedRows, sortKey, sortDir]
  );

  const { filters, page, setPage, pagedRows, totalPages, handleFiltersChange } =
    useBranchFilterState(sortedRows);

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

  const analyticsFilters = useMemo(() => ({ startDate }), [startDate]);

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
      {/* Filter bar — flush to the top of the content area with a full-width
          bottom border. Fixed (outside the scroll region) so it always stays. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <BranchesToolbar
          dateRange={dateRange}
          filters={filters}
          onDateRangeChange={handleDateRangeChange}
          onFiltersChange={handleFiltersChange}
          onToggleColumn={toggleColumn}
          readSource={data?.readSource}
          rows={windowedRows}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Scroll region — cards + banners + table share one bounded scroll
          container (both axes). The cards scroll up and away; the GridTable's
          sticky column header then pins to the top of the region, right under
          the filter bar. The horizontal scrollbar sits at the region's bottom,
          always visible. The cards reflect the window via `analyticsFilters`;
          the "vs. prior 30 days" delta only shows at the 30-day window. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* `sticky left-0` pins the cards to the left during horizontal scroll
            (so the wide table scrolls under them) while they still scroll away
            vertically. */}
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          <BranchesSummaryCards
            cardClassName={DASHBOARD_METRIC_CARD_CLASS_NAME}
            className={CARDS_GRID_CLASS_NAME}
            filters={analyticsFilters}
            onConnectGitHub={handleConnectGitHub}
            showDelta={dateRange === "30d"}
          />
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

        <BranchesBody
          getBranchHref={getBranchHref}
          hasRows={hasRows}
          isError={isError}
          isPending={isPending}
          items={pagedRows}
          onSort={handleSort}
          sortBy={sortKey}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Fixed footer — page controls, always visible (8px horizontal padding). */}
      {isResolved && totalPages > 1 ? (
        <div className="shrink-0 overflow-x-auto border-t px-2 py-2">
          <TablePagination
            className="min-w-max"
            onPageChange={setPage}
            page={page}
            totalPages={totalPages}
          />
        </div>
      ) : null}
    </div>
  );
}

function DesktopCloudHydrationStatus({ rows }: { rows: WireBranchRow[] }) {
  const state = resolveDesktopCloudHydrationState(rows);
  if (!state) {
    return null;
  }
  return <div className={state.className}>{state.message}</div>;
}

function resolveDesktopCloudHydrationState(rows: WireBranchRow[]): {
  className: string;
  message: string;
} | null {
  if (
    rows.some(
      (row) => row.cloudHydrationStatus === BranchCloudHydrationStatus.Failed
    )
  ) {
    return {
      className:
        "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-900 text-xs",
      message:
        "GitHub cloud refresh failed. Local branch data remains visible.",
    };
  }
  if (
    rows.some(
      (row) => row.cloudHydrationStatus === BranchCloudHydrationStatus.Stale
    )
  ) {
    return {
      className:
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-xs",
      message:
        "GitHub cloud refresh failed. Showing the last synced GitHub overlay with local branch data.",
    };
  }
  return null;
}

const BRANCHES_STATUS_CLASS_NAME =
  "py-12 text-center text-[var(--muted-foreground)] text-sm";

/**
 * The table area's content, branched on query state so loading and error reads
 * never masquerade as the (filtered or genuine) empty state. Early returns keep
 * the states mutually exclusive and flat.
 */
function branchesStateMessage(
  isPending: boolean,
  isError: boolean,
  hasRows: boolean
): string | null {
  if (isPending) {
    return "Loading branches…";
  }
  if (isError) {
    return "Could not load branches right now.";
  }
  if (!hasRows) {
    return "No branches yet.";
  }
  return null;
}

function BranchesBody({
  isPending,
  isError,
  hasRows,
  items,
  visibleColumns,
  getBranchHref,
  sortBy,
  sortDir,
  onSort,
}: {
  isPending: boolean;
  isError: boolean;
  hasRows: boolean;
  items: RenderBranchRow[];
  visibleColumns: Set<string>;
  /** Builds the row → detail hash href (`#/branches/:id`). */
  getBranchHref?: (item: RenderBranchRow) => string;
  sortBy: string;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
}): ReactNode {
  const message = branchesStateMessage(isPending, isError, hasRows);
  if (message) {
    return <div className={BRANCHES_STATUS_CLASS_NAME}>{message}</div>;
  }
  if (items.length === 0) {
    return (
      <div className={BRANCHES_STATUS_CLASS_NAME}>
        No branches match the current filters.
      </div>
    );
  }
  return (
    <BranchesTable
      getBranchHref={getBranchHref}
      items={items}
      onSort={onSort}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}
