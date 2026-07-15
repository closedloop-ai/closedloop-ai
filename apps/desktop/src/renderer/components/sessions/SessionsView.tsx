import { MetricCard } from "@closedloop-ai/design-system/components/ui/primitives/metric-card";
import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination";
import type {
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionRepositoryBreakdown,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionsListContent } from "@repo/app/agents/components/sessions/agent-sessions-list";
import { SessionsToolbar } from "@repo/app/agents/components/sessions/sessions-toolbar";
import {
  useAgentSessionAnalytics,
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
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Profiler,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import {
  LOCAL_SESSION_SOURCE_STATUSES,
  type LocalSessionSourceStatus,
  normalizeAgentMonitorLocalSessionSourceStatus,
} from "../../../shared/local-session-source-status";
import { RendererRenderView } from "../../../shared/render-commit-event";
import { desktopSessionDetailHashHref } from "../../shared-agent-sessions/session-hrefs";
import {
  DASHBOARD_GRID_CLASS_NAME,
  DASHBOARD_METRIC_CARD_CLASS_NAME,
} from "../layout/page-shell";
import { AgentCoachingTips } from "./agent-coaching-tips";
import { formatSessionDateRange } from "./format-session-date-range";
import {
  resolveSessionsListCause,
  type SessionsListCauseInputs,
  useRenderCommitInstrumentation,
} from "./use-render-commit-instrumentation";

const PAGE_SIZE = 25;
const PAGE_PARAM = "page";
type SessionsDisplayState = "starting" | "ready" | "unavailable";

/** Desktop wrapper for the shared sessions list content and local adapter. */
export function SessionsView() {
  const agentCoachingTipsEnabled = useFeatureFlagEnabled(
    DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY
  );
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const search = searchParams.get("search")?.trim() || undefined;
  const page = parseSessionsPage(searchParams.get(PAGE_PARAM));
  const [facetFilters, setFacetFilters] = useState<SessionFacetFilters>(
    DEFAULT_SESSION_FACET_FILTERS
  );
  const { dateRange, setDateRange } = useSharedDateRange("desktop");
  const { sortKey, sortDir, visibleColumns, setSort, toggleColumn } =
    useSessionsViewState("sessions:desktop");
  const localSessionSourceStatus = useLocalSessionSourceStatus();
  const canReadLocalSessions =
    localSessionSourceStatus === LOCAL_SESSION_SOURCE_STATUSES.ready;
  const setPage = useCallback(
    (nextPage: number) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      writeSessionsPage(nextParams, nextPage);
      const qs = nextParams.toString();
      navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
        scroll: false,
      });
    },
    [navigation, pathname, searchParams]
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

  // Memoized: `getStartDateForRange` returns a fresh `new Date().toISOString()`
  // each call, so an unmemoized value would change every render → new query key
  // → refetch/skeleton-flash loop.
  const startDate = useMemo(() => getStartDateForRange(dateRange), [dateRange]);

  // PLN-1034: the default sort is now lastActivity-desc, so `sortBy`/`sortDir`
  // are sent on the initial render (not only after a header click). A null
  // `sortKey` (e.g. a restored saved view) still omits them and keeps the local
  // source on its fast paginated path.
  const sessionsQuery = useAgentSessions(
    {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search,
      startDate,
      statuses: facetFilters.statuses,
      repositories: facetFilters.repositories,
      harnesses: facetFilters.harnesses,
      models: facetFilters.models,
      autonomyTiers: facetFilters.autonomyTiers,
      costBuckets: facetFilters.costBuckets,
      changePresence: facetFilters.changePresence,
      prAssociation: facetFilters.prAssociation,
      ...(sortKey ? { sortBy: sortKey, sortDir } : {}),
    },
    {
      enabled: canReadLocalSessions,
      placeholderData: keepPreviousData,
    }
  );

  const canFetchAuxiliaryData = canFetchSessionsAuxiliaryData({
    canReadLocalSessions,
    hasSessionsData: Boolean(sessionsQuery.data),
    isFetching: sessionsQuery.isFetching,
    isPlaceholderData: sessionsQuery.isPlaceholderData,
  });

  // Facet-option usage is window-scoped but facet-unfiltered, so the
  // Owner/Repository option lists stay complete regardless of the active
  // selection. The summary usage additionally carries the facets so the metric
  // cards reflect every active filter — but with no facet selected it returns
  // identical data, so it's gated off and the cards reuse the facet usage to
  // avoid a duplicate IPC round-trip on the common (unfiltered) path. Both are
  // gated on the local source being ready (PLN — local-source display states).
  // Usage/analytics are held until the list settles so expensive metric/facet
  // reads cannot block the user-visible table result on cold start or search.
  const facetsActive =
    facetFilters.statuses.length > 0 ||
    facetFilters.repositories.length > 0 ||
    facetFilters.harnesses.length > 0 ||
    facetFilters.models.length > 0 ||
    facetFilters.autonomyTiers.length > 0 ||
    facetFilters.costBuckets.length > 0 ||
    facetFilters.changePresence.length > 0 ||
    facetFilters.prAssociation.length > 0;
  const facetUsageQuery = useAgentSessionUsage(
    { search, startDate },
    {
      enabled: canFetchAuxiliaryData,
      placeholderData: keepPreviousData,
    }
  );
  const summaryUsageQuery = useAgentSessionUsage(
    {
      search,
      startDate,
      statuses: facetFilters.statuses,
      repositories: facetFilters.repositories,
      harnesses: facetFilters.harnesses,
      models: facetFilters.models,
      autonomyTiers: facetFilters.autonomyTiers,
      costBuckets: facetFilters.costBuckets,
      changePresence: facetFilters.changePresence,
      prAssociation: facetFilters.prAssociation,
    },
    {
      enabled: canFetchAuxiliaryData && facetsActive,
      placeholderData: keepPreviousData,
    }
  );
  const summaryUsage = facetsActive
    ? summaryUsageQuery.data
    : facetUsageQuery.data;
  const metricUsageQuery = facetsActive ? summaryUsageQuery : facetUsageQuery;
  // The Repository filter facet needs a per-repository rollup. The desktop usage
  // summary omits it (cwd→repo identity is filesystem-derived, not a SQL column),
  // but the analytics aggregate resolves it (FEA-2038) using the same identity
  // the list query filters on. Window-scoped but facet-unfiltered so the options
  // stay stable as the user toggles filters.
  const analyticsQuery = useAgentSessionAnalytics(
    { search, startDate },
    {
      enabled: canFetchAuxiliaryData,
      placeholderData: keepPreviousData,
    }
  );

  const handleFiltersChange = (next: SessionFacetFilters) => {
    setFacetFilters(next);
    setPage(0);
  };
  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    setPage(0);
  };
  const handleSort = (column: string, direction: SortDirection) => {
    setSort(column as SessionSortKey, direction as SessionSortDir);
    setPage(0);
  };

  const displayState = getSessionsDisplayState(localSessionSourceStatus);
  const renderModel = buildSessionsRenderModel({
    displayState,
    sessionsData: sessionsQuery.data,
    summaryUsage,
    facetUsage: facetUsageQuery.data,
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
  const isTableLoading = Boolean(tableLoadingLabel);
  const isMetricDataRefreshing = getMetricDataRefreshingState({
    canFetchAuxiliaryData,
    hasData: Boolean(metricUsageQuery.data),
    isError: metricUsageQuery.isError,
    isFetching: metricUsageQuery.isFetching,
    isPlaceholderData: metricUsageQuery.isPlaceholderData,
  });
  useEffect(() => {
    if (
      !canReadLocalSessions ||
      sessionsQuery.isFetching ||
      !sessionsQuery.data
    ) {
      return;
    }

    const clampedPage = clampSessionsPage(page, renderModel.total, PAGE_SIZE);
    if (clampedPage !== page) {
      setPage(clampedPage);
    }
  }, [
    canReadLocalSessions,
    page,
    sessionsQuery.data,
    sessionsQuery.isFetching,
    setPage,
    renderModel.total,
  ]);

  // The date span the summary totals cover (earliest → latest session start).
  // Null when no sessions match, so the metric cards render no detail line.
  const dateRangeLabel = formatSessionDateRange(
    summaryUsage?.earliestSessionAt ?? null,
    summaryUsage?.latestSessionAt ?? null
  );
  const areMetricsLoading = isTableLoading || isMetricDataRefreshing;
  const metricDetail = areMetricsLoading ? undefined : dateRangeLabel;
  const totalSessionsValue = areMetricsLoading
    ? "..."
    : renderModel.totalSessionsValue;
  const totalTokensValue = areMetricsLoading
    ? "..."
    : renderModel.totalTokensValue;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Filter bar — flush to the top of the content area with a full-width
          bottom border. Fixed (outside the scroll region) so it always stays. */}
      <div className="shrink-0 border-b px-4 py-3">
        <SessionsToolbar
          dateRange={dateRange}
          filters={facetFilters}
          onDateRangeChange={handleDateRangeChange}
          onFiltersChange={handleFiltersChange}
          onToggleColumn={toggleColumn}
          readSource={sessionsQuery.data?.readSource}
          usage={renderModel.usage}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Scroll region — cards + table share one bounded scroll container (both
          axes). The cards scroll up and away; the GridTable's sticky column
          header then pins to the top of the region, right under the filter bar.
          The horizontal scrollbar sits at the region's bottom, always visible. */}
      <div
        aria-busy={tableLoadingLabel ? "true" : undefined}
        className="min-h-0 flex-1 overflow-auto"
      >
        {/* `sticky left-0` pins the cards to the left during horizontal scroll
            (so the wide table scrolls under them) while they still scroll away
            vertically. */}
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          {agentCoachingTipsEnabled ? <AgentCoachingTips /> : null}

          <div className={DASHBOARD_GRID_CLASS_NAME}>
            <MetricCard
              className={DASHBOARD_METRIC_CARD_CLASS_NAME}
              detail={metricDetail}
              label="Total Sessions"
              value={totalSessionsValue}
            />
            <MetricCard
              className={DASHBOARD_METRIC_CARD_CLASS_NAME}
              detail={metricDetail}
              label="Total Tokens"
              value={totalTokensValue}
            />
          </div>
        </div>

        <Profiler id="sessions_list" onRender={onRenderCommit}>
          <SessionsTableBody
            hasData={renderModel.hasRenderableData}
            hostScroll
            isError={displayState === "unavailable" || sessionsQuery.isError}
            isLoading={displayState === "starting" || sessionsQuery.isLoading}
            loadingLabel={tableLoadingLabel}
            onSort={handleSort}
            sessions={renderModel.sessions}
            sortBy={sortKey}
            sortDir={sortDir}
            visibleColumns={visibleColumns}
          />
        </Profiler>
      </div>

      {/* Fixed footer — page controls, always visible (8px horizontal padding). */}
      {!tableLoadingLabel && renderModel.totalPages > 1 ? (
        <div className="shrink-0 overflow-x-auto border-t px-2 py-2">
          <TablePagination
            className="min-w-max"
            onPageChange={setPage}
            page={page}
            totalPages={renderModel.totalPages}
          />
        </div>
      ) : null}
    </div>
  );
}

function useLocalSessionSourceStatus(): LocalSessionSourceStatus {
  const [status, setStatus] = useState<LocalSessionSourceStatus>(
    LOCAL_SESSION_SOURCE_STATUSES.starting
  );

  useEffect(() => {
    let disposed = false;

    const refreshStatus = () => {
      window.desktopApi
        .getAgentMonitorUrl()
        .then((payload) => {
          if (disposed) {
            return;
          }
          setStatus(normalizeAgentMonitorLocalSessionSourceStatus(payload));
        })
        .catch(() => {
          if (!disposed) {
            setStatus(LOCAL_SESSION_SOURCE_STATUSES.unavailable);
          }
        });
    };

    refreshStatus();

    const unsubscribe = window.desktopApi.onDbChanged?.(() => {
      refreshStatus();
    });
    const intervalId =
      status === LOCAL_SESSION_SOURCE_STATUSES.starting
        ? globalThis.setInterval(refreshStatus, 500)
        : null;

    return () => {
      disposed = true;
      unsubscribe?.();
      if (intervalId !== null) {
        globalThis.clearInterval(intervalId);
      }
    };
  }, [status]);

  return status;
}

function getSessionsDisplayState(
  status: LocalSessionSourceStatus
): SessionsDisplayState {
  if (status === LOCAL_SESSION_SOURCE_STATUSES.starting) {
    return "starting";
  }
  if (status === LOCAL_SESSION_SOURCE_STATUSES.ready) {
    return "ready";
  }
  return "unavailable";
}

/**
 * Usage and analytics reads can be expensive on a large local store. Let the
 * list request settle first so the user sees rows before metric/facet work.
 */
function canFetchSessionsAuxiliaryData({
  canReadLocalSessions,
  hasSessionsData,
  isFetching,
  isPlaceholderData,
}: {
  canReadLocalSessions: boolean;
  hasSessionsData: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
}): boolean {
  if (!canReadLocalSessions) {
    return false;
  }
  return hasSessionsData && !isFetching && !isPlaceholderData;
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
  return isFetching || isPlaceholderData || !(hasData || isError);
}

function buildSessionsRenderModel({
  displayState,
  sessionsData,
  summaryUsage,
  facetUsage,
  repositoryBreakdown,
}: {
  displayState: SessionsDisplayState;
  sessionsData: AgentSessionListResponse | undefined;
  summaryUsage: AgentSessionUsageSummary | undefined;
  facetUsage: AgentSessionUsageSummary | undefined;
  repositoryBreakdown: AgentSessionRepositoryBreakdown[] | undefined;
}) {
  if (displayState === "starting") {
    return {
      hasRenderableData: false,
      sessions: [] as AgentSessionListItem[],
      total: 0,
      totalPages: 1,
      totalSessionsValue: "..." as string | number,
      totalTokensValue: "...",
      usage: undefined as AgentSessionUsageSummary | undefined,
    };
  }

  if (displayState === "unavailable") {
    return {
      hasRenderableData: false,
      sessions: [] as AgentSessionListItem[],
      total: 0,
      totalPages: 1,
      totalSessionsValue: "Unavailable" as string | number,
      totalTokensValue: "Unavailable",
      usage: undefined as AgentSessionUsageSummary | undefined,
    };
  }

  const sessions = sessionsData?.items ?? [];
  const total = sessionsData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const totalTokens =
    (summaryUsage?.totalInputTokens ?? 0) +
    (summaryUsage?.totalOutputTokens ?? 0);

  // The usage summary carries no per-repository rollup on desktop, so graft the
  // analytics breakdown in to feed the Repository filter facet (keeping every
  // other usage total intact).
  const usage = facetUsage
    ? {
        ...facetUsage,
        byRepository: repositoryBreakdown ?? facetUsage.byRepository,
      }
    : undefined;

  return {
    hasRenderableData: Boolean(sessionsData),
    sessions,
    total,
    totalPages,
    totalSessionsValue: (summaryUsage?.totalSessions ?? total) as
      | string
      | number,
    totalTokensValue: totalTokens.toLocaleString(),
    usage,
  };
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

/** Error / table body for the desktop Sessions view. */
function SessionsTableBody({
  isError,
  hasData,
  isLoading,
  sessions,
  sortBy,
  sortDir,
  onSort,
  visibleColumns,
  hostScroll,
  loadingLabel,
}: {
  isError: boolean;
  hasData: boolean;
  isLoading: boolean;
  sessions: AgentSessionListItem[];
  sortBy: SessionSortKey | null;
  sortDir: SessionSortDir;
  onSort: (column: string, direction: SortDirection) => void;
  visibleColumns: Set<string>;
  hostScroll?: boolean;
  loadingLabel?: string;
}): ReactNode {
  // Only blank on an initial-load failure (no data yet). A transient error on a
  // live (DB-change-driven) background refetch keeps the last-good rows rendered
  // and recovers on the next event, per PLN-941 §5.
  if (isError && !hasData) {
    return (
      <div className="py-12 text-center text-[var(--destructive)] text-sm">
        Sessions are temporarily unavailable.
      </div>
    );
  }

  if (isLoading && !hasData) {
    return (
      <SessionsListLoadingState label={loadingLabel ?? "Loading sessions..."} />
    );
  }

  if (loadingLabel) {
    return <SessionsListLoadingState label={loadingLabel} />;
  }

  return (
    <AgentSessionsListContent
      getSessionHref={desktopSessionDetailHashHref}
      hostScroll={hostScroll}
      isLoading={isLoading && !hasData}
      items={sessions}
      onSort={onSort}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

function SessionsListLoadingState({ label }: { label: string }): ReactNode {
  return (
    <div
      aria-live="polite"
      className="flex min-h-[320px] flex-col items-center justify-center gap-3 border-t text-center text-muted-foreground text-sm"
      role="status"
    >
      <Loader2 aria-hidden="true" className="size-5 animate-spin" />
      <span className="font-medium">{label}</span>
    </div>
  );
}

function getSessionsLoadingLabel(search: string | undefined): string {
  return search ? "Searching sessions..." : "Loading sessions...";
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
