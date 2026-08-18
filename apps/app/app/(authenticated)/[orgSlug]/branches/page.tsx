"use client";

import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import {
  BranchDetailTabParam,
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { BranchesListBody } from "@repo/app/branches/components/branches-list-body";
import { BranchesSummaryCards } from "@repo/app/branches/components/branches-summary-cards";
import { BranchesToolbar } from "@repo/app/branches/components/branches-toolbar";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import { GitHubConnectReturnNotice } from "@repo/app/branches/components/github-connect-return-notice";
import {
  APPROVED_BRANCH_PAGE_SIZE,
  useUrlSyncedBranchFilterState,
} from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchSavedViews } from "@repo/app/branches/hooks/use-branch-saved-views";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import {
  branchesKeys,
  useBranchCohortAnalytics,
  useBranchesPageData,
} from "@repo/app/branches/hooks/use-branches";
import {
  bindApprovedBranchCohortAnalytics,
  buildApprovedBranchCohortRequest,
} from "@repo/app/branches/lib/approved-branch-cohort";
import { resolveBranchListBanner } from "@repo/app/branches/lib/branch-list-banner";
import type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import {
  type BranchSortDir,
  type BranchSortKey,
  filterBranchRowsByWindow,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import { selectVisibleWireRows } from "@repo/app/branches/lib/filtered-branch-analytics";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  type DateRange,
  getStableUtcDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { Button } from "@repo/design-system/components/ui/button";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

// Matches desktop's combined page-data cadence and the list's prior (pre-
// combined-read) 90s tuning — the analytics half no longer gets its own
// independent 30s staleTime now that both live behind one query.
const WEB_BRANCHES_PAGE_DATA_STALE_TIME_MS = 90_000;

// Module-local e2e anchors. A Next.js App Router page module may only export the
// reserved page exports (`default`, `metadata`, …), so these stay non-exported;
// the specs that read them redeclare the same literals. ISS-4673 turned the
// scroll container from a `<main>` into a `<div>` (the shell's `SidebarInset`
// owns the page's single `<main>`), so `getByRole("main")` no longer resolves to
// it — `e2e/visual-regression.spec.ts` screenshots the scroll container by test
// id, and the list body is the FEA-4155 blank-body-guard anchor (mirroring
// Sessions' `sessions-history-list`), scoped so shell chrome cannot satisfy it.
const SCROLL_CONTAINER_TEST_ID = "branches-scroll-container";
const HISTORY_LIST_TEST_ID = "branches-history-list";

export default function BranchesPage() {
  // ISS-5574: name the tab for this surface. Off by default behind the shared
  // web+desktop flag; the desktop renderer titles the same route from the same key.
  const tabTitlesEnabled = useFeatureFlagEnabled(
    SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
  useDocumentTitle(tabTitlesEnabled ? "Branches" : null);
  return <BranchesPageContent />;
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
  const {
    sortKey,
    sortDir,
    dateRange,
    isViewReady,
    visibleColumns,
    hiddenColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    setSort,
    setDateRange,
    toggleColumn,
    resetColumns,
    applyArrangement,
  } = useBranchViewState("branches:web", true);

  // The web list now reads through the HTTP BranchesDataSource. The current
  // table still applies its time-window client-side so the shared toolbar,
  // filtering, sorting, and pagination path matches the desktop surface.
  const { startDate, endDate } = getStableUtcDateWindowForRange(dateRange);
  const pageDataFilters = useMemo(
    () => ({ endDate, startDate }),
    [endDate, startDate]
  );
  // Combined list + analytics read (FEA-3056 follow-up): the page mounts the
  // table and the summary cards together, so one query shares one underlying
  // read instead of each independently re-fetching.
  const {
    data: pageData,
    isPending,
    isError,
  } = useBranchesPageData(
    pageDataFilters,
    {
      // ISS-4655: hold the read until the persisted view has restored. The
      // window is part of the query key, and before the restore it is still the
      // 30d default — a user whose saved range differs paginated the whole
      // corpus against that default and then paginated it again, with the first
      // run unrecoverable under its own key. Fails OPEN on a stalled auth
      // hydration (see `VIEW_RESTORE_AUTH_DEADLINE_MS`), so the table degrades
      // to the pre-gate double read rather than to a permanent skeleton.
      enabled: isViewReady,
      staleTime: WEB_BRANCHES_PAGE_DATA_STALE_TIME_MS,
      refetchOnWindowFocus: true,
      // Keep the previous window's rows on screen while an uncached date
      // range loads, instead of blanking the table via isPending on every
      // switch (the list used to be windowed client-side over a single
      // startDate-independent fetch, so this never flashed pre-combined-read).
      placeholderData: keepPreviousData,
    },
    queryIdentity
  );
  const data = pageData?.list;
  const rows = useMemo(
    () =>
      adaptBranchRows(data?.items ?? [], {
        preferCanonicalLastActive: true,
      }),
    [data]
  );

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
  // with the desktop Branches view so the glue can't drift per surface.
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

  // FEA-4180: named saved views (order + visibility + sort + filters). Captures
  // the current live arrangement and applies a switched view back onto both the
  // view-state hook (sort/window/columns) and the filter-state hook (facets, via
  // the URL-mirroring `handleFiltersChange`). Keyed to the web surface.
  const savedViews = useBranchSavedViews(
    "branches:web",
    {
      sortKey,
      sortDir,
      dateRange,
      hiddenColumns,
      columnOrder: [],
      filters,
    },
    { applyArrangement, applyFilters: handleFiltersChange },
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
  } = useBranchCohortAnalytics(
    cohortRequest,
    {
      enabled: pageData?.analytics !== undefined,
      refetchOnWindowFocus: true,
      staleTime: WEB_BRANCHES_PAGE_DATA_STALE_TIME_MS,
    },
    queryIdentity
  );

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

  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    setPage(0);
  };

  const getBranchHref = (item: RenderBranchRow) =>
    `/${orgSlug}/branches/${item.id}`;
  // FEA-4259: the Linked Sessions count links to the branch detail's Sessions
  // tab (which lists exactly that branch's sessions). The org-relative path +
  // `?tab=` is built by the notification-route SSOT so the tab literal can never
  // drift from the value the detail route reads; the web shell prefixes `/org`.
  const getSessionsHref = (item: RenderBranchRow) =>
    `/${orgSlug}${getNotificationEntityPath({
      kind: NotificationEntityKind.Branch,
      branchId: item.id,
      tab: BranchDetailTabParam.SessionsTimeline,
    })}`;
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

  const handleRetry = () => {
    return Promise.all([
      queryClient.invalidateQueries(
        {
          queryKey: branchesKeys.analyticsRoot(),
        },
        { throwOnError: true }
      ),
      queryClient.invalidateQueries(
        { queryKey: branchesKeys.cohortAnalyticsRoot() },
        { throwOnError: true }
      ),
      queryClient.invalidateQueries(
        { queryKey: branchesKeys.pageDataRoot() },
        { throwOnError: true }
      ),
    ]).catch(() => undefined);
  };

  useEffect(() => {
    if (githubStatus !== GitHubConnectReturnStatus.Connected) {
      return;
    }
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
    if (backfillStartedRef.current) {
      return;
    }
    backfillStartedRef.current = true;
    // Long-running by design: Apply mode runs the whole backfill (repos ->
    // branches -> PRs -> projections) synchronously before responding, so it
    // needs more than the default client deadline.
    const backfill = apiClient.post(
      "/integrations/github/backfill",
      { mode: GitHubBackfillMode.Apply },
      { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
    );
    backfill
      .catch(() => undefined)
      // ISS-5013: invalidate on SETTLED, not only on success. Apply mode writes
      // incrementally (repos → branches → PRs → projections), so a run the
      // client abandoned at the deadline can leave real rows server-side. On
      // success-only invalidation the list would keep its pre-backfill
      // population — typically the connect-GitHub or net-new empty treatment —
      // and assert "nothing here" about an org that now has branches.
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: branchesKeys.all });
      });
  }, [apiClient, githubStatus, queryClient]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Branches" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filter bar — pinned above the scroll area. The table header sticks
              to the top of the scroll container right beneath it. */}
        <div className="border-b px-4 py-3">
          <BranchesToolbar
            approved
            dateRange={dateRange}
            filters={filters}
            onDateRangeChange={handleDateRangeChange}
            onFiltersChange={handleFiltersChange}
            onResetView={resetColumns}
            onToggleColumn={toggleColumn}
            readSource={data?.readSource}
            rows={visibleRows}
            savedViews={savedViews}
            visibleColumns={visibleColumns}
          />
        </div>

        {/* A labelled section, not <main>: the shell's SidebarInset owns the page's single main landmark. */}
        <section
          aria-label="Branches"
          className="min-h-0 flex-1 overflow-auto"
          data-testid={SCROLL_CONTAINER_TEST_ID}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: COMMON-016 requires the two-axis scroll region itself to be keyboard-focusable.
          tabIndex={0}
        >
          <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
            <BranchesSummaryCards
              analytics={filteredAnalytics.analytics}
              approved
              approvedComparisonSuppressedByFilter={
                filteredAnalytics.comparisonSuppressedByFilter
              }
              isError={isError || summaryAnalyticsErrored}
              isPending={summaryAnalyticsPending}
              showDelta={dateRange === "30d"}
              wrapBelow
            />
            {/* FEA-4177: analytics-only failure (list fine). The cards degrade to
                "Unavailable" above, but a silent dimmed row leaves the user with
                no reason and no way back — mirror the list's own Retry with a
                short honest line plus a retry that re-runs the same combined
                read. */}
            {summaryAnalyticsErrored ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-[var(--muted-foreground)] text-xs">
                <span>Couldn't load the summary metrics.</span>
                <Button
                  onClick={handleRetry}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Retry
                </Button>
              </div>
            ) : null}
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
          {/* data-testid: stable anchor for the list BODY, mirroring Sessions'
              `sessions-history-list`. The surfaces-smoke blank-body guard scopes
              to it so shell chrome (breadcrumb, toolbar) cannot satisfy the
              assertion — it used to scope to this page's own <main>, which
              ISS-4673 removed. */}
          <div data-testid={HISTORY_LIST_TEST_ID}>
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
              onRetry={handleRetry}
              onShowAllTime={() => handleDateRangeChange("all")}
              onSort={handleSort}
              sortBy={sortKey}
              sortDir={sortDir}
              visibleColumns={visibleColumns}
              windowedEmptyIsNoMatches={
                startDate !== undefined && rows.length === 0
              }
            />
          </div>
        </section>

        {/* ISS-4681: the shared footer shell. The approved List reports its
            client-filtered cohort; legacy retains the prior multi-page guard. */}
        {isResolved && total > 0 ? (
          <TablePaginationFooter
            onPageChange={setPage}
            page={page}
            readout={`${from}–${to} of ${total}`}
            totalPages={totalPages}
          />
        ) : null}
      </div>
    </div>
  );
}
