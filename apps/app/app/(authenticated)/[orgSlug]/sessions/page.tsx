"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { SessionsToolbar } from "@repo/app/agents/components/sessions/sessions-toolbar";
import {
  useAgentSessions,
  useAgentSessionUsage,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Clock3Icon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  clampSessionsPageIndex,
  readSessionsPageIndex,
  useSessionsHistoryScroll,
  useSessionsPageReset,
  writeSessionsPageParam,
} from "@/app/(authenticated)/sessions-route-state";
import { SessionsSummaryCards } from "@/components/agent-sessions/sessions-summary-cards";
import { SessionsTable } from "@/components/agent-sessions/sessions-table";
import { useOrgSlug } from "@/hooks/use-org-slug";

const PAGE_SIZE = 25;

export default function SessionsPage() {
  const orgSlug = useOrgSlug();
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const selectedUserId = searchParams.get("userId");
  const [facetFilters, setFacetFilters] = useState<SessionFacetFilters>(
    DEFAULT_SESSION_FACET_FILTERS
  );
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  const urlPageIndex = readSessionsPageIndex(searchParams);
  const { effectivePageIndex, markPageOverride, markPageReset } =
    useSessionsPageReset({
      urlPageIndex,
    });
  const {
    sortKey,
    sortDir,
    dateRange,
    visibleColumns,
    setSort,
    setDateRange,
    toggleColumn,
  } = useSessionsViewState("sessions:web");

  // Memoized: `getStartDateForRange` returns `new Date().toISOString()` (ms
  // precision), so an unmemoized value would differ every render, change every
  // query key, and drive a refetch/skeleton-flash loop.
  const startDate = useMemo(() => getStartDateForRange(dateRange), [dateRange]);

  // Facet-option usage: date-only (no facet filters) so the Owner/Repository
  // option lists stay complete regardless of the active selection.
  const facetUsageFilters = useMemo(
    () => ({ startDate, userId: selectedUserId ?? undefined }),
    [startDate, selectedUserId]
  );
  const facetUsageQuery = useAgentSessionUsage(facetUsageFilters);

  // Summary metrics aggregate across the entire (filtered) set, so they get the
  // facet filters but no pagination fields.
  const summaryFilters = useMemo(
    () => ({
      startDate,
      statuses: facetFilters.statuses,
      userIds: facetFilters.userIds,
      repositories: facetFilters.repositories,
      userId: selectedUserId ?? undefined,
    }),
    [startDate, facetFilters, selectedUserId]
  );

  // The paginated list query extends the summary filters with sort + page
  // bounds. `sortBy` is sent only once a header is clicked, so the default view
  // uses the server's natural order.
  const listFilters = useMemo(
    () => ({
      ...summaryFilters,
      ...(sortKey ? { sortBy: sortKey, sortDir } : {}),
      limit: PAGE_SIZE,
      offset: effectivePageIndex * PAGE_SIZE,
    }),
    [summaryFilters, sortKey, sortDir, effectivePageIndex]
  );

  const sessionsQuery = useAgentSessions(listFilters);
  const knownTotal = sessionsQuery.data?.total;
  const total = knownTotal ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const replacePage = useCallback(
    (nextPage: number) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      writeSessionsPageParam(nextParams, nextPage);
      const qs = nextParams.toString();
      navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
        scroll: false,
      });
    },
    [navigation, pathname, searchParams]
  );
  useEffect(() => {
    if (knownTotal === undefined) {
      return;
    }

    const clampedPageIndex = clampSessionsPageIndex({
      pageIndex: effectivePageIndex,
      pageSize: PAGE_SIZE,
      total: knownTotal,
    });
    if (clampedPageIndex === effectivePageIndex) {
      return;
    }

    markPageOverride(clampedPageIndex);
    replacePage(clampedPageIndex);
  }, [effectivePageIndex, knownTotal, markPageOverride, replacePage]);

  const handleSort = (column: string, direction: SortDirection) => {
    markPageReset();
    setSort(column as SessionSortKey, direction as SessionSortDir);
    replacePage(0);
  };
  const handleFiltersChange = (next: SessionFacetFilters) => {
    markPageReset();
    setFacetFilters(next);
    replacePage(0);
  };
  const handleDateRangeChange = (next: DateRange) => {
    markPageReset();
    setDateRange(next);
    replacePage(0);
  };

  const items = sessionsQuery.data?.items ?? [];
  useSessionsHistoryScroll({
    scrollKey: `org:${orgSlug}:sessions:page:${effectivePageIndex}`,
    container: scrollContainer,
    restoreWhen: !sessionsQuery.isLoading,
  });

  let tableContent: ReactNode;
  if (sessionsQuery.isLoading) {
    tableContent = <Skeleton className="h-[320px] w-full" />;
  } else if (items.length === 0) {
    tableContent = (
      <EmptyState
        className="py-12"
        description="No synced sessions match your current filters yet."
        icon={Clock3Icon}
        title="No sessions found"
      />
    );
  } else {
    tableContent = (
      <SessionsTable
        getSessionHref={(item) => `/${orgSlug}/sessions/${item.id}`}
        items={items}
        onSort={handleSort}
        sortBy={sortKey}
        sortDir={sortDir}
        visibleColumns={visibleColumns}
      />
    );
  }

  return (
    <FeatureFlagged flag={DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={[{ label: "Sessions" }]} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Filter/View toolbar — pinned above the scroll area, left-aligned.
              The table header sticks to the top of <main> right beneath it. */}
          <div className="border-b px-4 py-3">
            <SessionsToolbar
              dateRange={dateRange}
              filters={facetFilters}
              onDateRangeChange={handleDateRangeChange}
              onFiltersChange={handleFiltersChange}
              onToggleColumn={toggleColumn}
              usage={facetUsageQuery.data}
              visibleColumns={visibleColumns}
            />
          </div>

          {/* Cards + table share one scroll container, so they scroll together.
              The toolbar above stays pinned. */}
          <main
            className="min-h-0 flex-1 overflow-auto"
            ref={setScrollContainer}
          >
            <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
              {selectedUserId ? (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">User filtered</Badge>
                  <span className="text-muted-foreground text-sm">
                    Showing sessions for the selected user.
                  </span>
                </div>
              ) : null}

              <SessionsSummaryCards filters={summaryFilters} />
            </div>

            {tableContent}
          </main>

          {totalPages > 1 ? (
            <div className="border-t px-6 py-3">
              <TablePagination
                onPageChange={replacePage}
                page={effectivePageIndex}
                totalPages={totalPages}
              />
            </div>
          ) : null}
        </div>
      </div>
    </FeatureFlagged>
  );
}
