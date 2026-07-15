"use client";

import { GitHubBackfillMode } from "@repo/api/src/types/github";
import {
  BranchRefreshState,
  BranchRefreshStatus,
  useAutoClearBranchRefreshState,
} from "@repo/app/branches/components/branch-refresh-status";
import { BranchesSummaryCards } from "@repo/app/branches/components/branches-summary-cards";
import { BranchesTable } from "@repo/app/branches/components/branches-table";
import { BranchesToolbar } from "@repo/app/branches/components/branches-toolbar";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import { useBranchFilterState } from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import {
  branchesKeys,
  useBranches,
} from "@repo/app/branches/hooks/use-branches";
import { resolveBranchListBanner } from "@repo/app/branches/lib/branch-list-banner";
import type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import {
  type BranchSortDir,
  type BranchSortKey,
  filterBranchRowsByWindow,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { Button } from "@repo/design-system/components/ui/button";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { Link } from "@repo/navigation/link";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCcwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { FeatureFlagGate } from "@/components/feature-flag-gate";
import { useOrgSlug } from "@/hooks/use-org-slug";

const WEB_BRANCHES_LIST_STALE_TIME_MS = 90_000;
const WEB_BRANCHES_DETAIL_STALE_TIME_MS = 30_000;
const WEB_SUMMARY_CARD_CLASS_NAME =
  "min-w-[11rem] flex-1 basis-[11rem] sm:basis-[12rem]";
const WEB_SUMMARY_GRID_CLASS_NAME =
  "grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5";
const BRANCHES_STATUS_CLASS_NAME =
  "py-12 text-center text-[var(--muted-foreground)] text-sm";

export default function BranchesPage() {
  return (
    <FeatureFlagGate flag={ArtifactFlag.Branches}>
      <BranchesPageContent />
    </FeatureFlagGate>
  );
}

function BranchesPageContent() {
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const backfillStartedRef = useRef(false);
  const queryIdentity = useMemo(
    () => ({ cacheScope: `org:${orgSlug}` }),
    [orgSlug]
  );
  const [refreshState, setRefreshState] = useState<BranchRefreshState>(
    BranchRefreshState.Idle
  );
  useAutoClearBranchRefreshState(refreshState, setRefreshState);
  const { data, isPending, isError, isFetching } = useBranches(
    {},
    {
      staleTime: WEB_BRANCHES_LIST_STALE_TIME_MS,
      refetchOnWindowFocus: true,
    },
    queryIdentity
  );
  const rows = useMemo(() => adaptBranchRows(data?.items ?? []), [data]);

  const {
    sortKey,
    sortDir,
    dateRange,
    visibleColumns,
    setSort,
    setDateRange,
    toggleColumn,
  } = useBranchViewState("branches:web");

  // The web list now reads through the HTTP BranchesDataSource. The current
  // table still applies its time-window client-side so the shared toolbar,
  // filtering, sorting, and pagination path matches the desktop surface.
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

  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    setPage(0);
  };

  const analyticsFilters = useMemo(() => ({ startDate }), [startDate]);
  const getBranchHref = (item: RenderBranchRow) =>
    `/${orgSlug}/branches/${item.id}`;
  const connectHref = `/api/integrations/github?returnTo=${encodeURIComponent(
    `/${orgSlug}/branches`
  )}`;
  const githubStatus = searchParams.get("github");
  const isResolved = !(isPending || isError);
  const hasRows = rows.length > 0;
  const banner = useMemo(
    () => resolveBranchListBanner(data?.items ?? []),
    [data]
  );

  const handleRefresh = async () => {
    setRefreshState(BranchRefreshState.Pending);
    try {
      await Promise.all([
        queryClient.invalidateQueries(
          { queryKey: branchesKeys.lists() },
          { throwOnError: true }
        ),
        queryClient.invalidateQueries(
          {
            queryKey: branchesKeys.analyticsRoot(),
          },
          { throwOnError: true }
        ),
      ]);
      setRefreshState(BranchRefreshState.Success);
    } catch {
      setRefreshState(BranchRefreshState.Error);
    }
  };

  useEffect(() => {
    if (githubStatus !== "connected") {
      return;
    }
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
    if (backfillStartedRef.current) {
      return;
    }
    backfillStartedRef.current = true;
    const backfill = apiClient.post("/integrations/github/backfill", {
      mode: GitHubBackfillMode.Apply,
    });
    backfill
      .then(() => {
        queryClient.invalidateQueries({ queryKey: branchesKeys.all });
      })
      .catch(() => {
        setRefreshState(BranchRefreshState.Error);
      });
  }, [apiClient, githubStatus, queryClient]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Branches" }]}>
        <Button
          disabled={refreshState === BranchRefreshState.Pending || isFetching}
          onClick={handleRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCcwIcon className="size-3.5" />
          Refresh
        </Button>
      </Header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filter bar — pinned above the scroll area. The table header sticks
              to the top of <main> right beneath it. */}
        <div className="border-b px-4 py-3">
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

        <main className="min-h-0 flex-1 overflow-auto">
          <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
            <BranchesSummaryCards
              analyticsOptions={{
                refetchOnWindowFocus: true,
                staleTime: WEB_BRANCHES_DETAIL_STALE_TIME_MS,
              }}
              cardClassName={WEB_SUMMARY_CARD_CLASS_NAME}
              className={WEB_SUMMARY_GRID_CLASS_NAME}
              filters={analyticsFilters}
              queryIdentity={queryIdentity}
              showDelta={dateRange === "30d"}
            />
            <BranchRefreshStatus state={refreshState} subject="branch data" />
            <GitHubConnectReturnNotice status={githubStatus} />
            {isResolved && banner === "connect-github" ? (
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2">
                <ConnectGitHubIndicator compact connectHref={connectHref} />
              </div>
            ) : null}
            {isResolved && banner === "net-new" ? (
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-[var(--muted-foreground)] text-xs">
                These branches are tracked locally with no linked pull request
                yet — the metrics shown are net-new.
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
        </main>

        {isResolved && totalPages > 1 ? (
          <div className="overflow-x-auto border-t px-4 py-3">
            <TablePagination
              className="min-w-max"
              onPageChange={setPage}
              page={page}
              totalPages={totalPages}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GitHubConnectReturnNotice({ status }: { status: string | null }) {
  if (status === "connected") {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900 text-xs">
        GitHub is connected. Branch data is refreshing.
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-900 text-xs">
        GitHub did not connect. Local branch data is still available.
      </div>
    );
  }
  return null;
}

function branchesStateMessage(
  isPending: boolean,
  isError: boolean,
  hasRows: boolean
): string | null {
  if (isPending) {
    return "Loading branches…";
  }
  if (isError && !hasRows) {
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
      items={items}
      onSort={onSort}
      renderBranchLink={
        getBranchHref
          ? ({ className, children, item }) => (
              <Link className={className} href={getBranchHref(item)}>
                {children}
              </Link>
            )
          : undefined
      }
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}
