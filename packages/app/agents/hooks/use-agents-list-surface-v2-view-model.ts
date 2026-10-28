"use client";

import {
  deriveListEmptyReason,
  ListEmptyReason,
} from "@repo/api/src/list-empty-state";
import {
  type AgentComponent,
  AgentComponentGroupBy,
  AgentComponentKind,
  type AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import {
  type AgentComponentFacetCounts,
  type AgentComponentFilters,
  DEFAULT_AGENT_COMPONENT_FILTERS,
} from "@repo/api/src/utils/agent-component-reduce";
import type { SummaryAggregate } from "@repo/api/src/utils/agent-component-summary-aggregate";
import { useEffect, useMemo, useState } from "react";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { useTabParam } from "../../shared/hooks/use-tab-param";
import { CompleteSurfaceState } from "../../shared/lib/complete-surface-contract";
import { AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import type { AgentsTableGroup } from "../components/workspace/agents-table";
import { useAgentComponentsDataSource } from "../data-source/provider";
import { groupAgentComponentRows } from "../lib/agent-component-sort-group";
import { agentsColumnSortKey } from "../lib/agents-column-sort-keys";
import {
  type AgentsTypeTabValue,
  ALL_TYPES,
  agentsWindowNoun,
  emptyStateMessage,
  hasActiveAgentsFacetOrSearch,
  isHonestAgentsPluginsEmpty,
  pluginHarnessScope,
} from "../lib/agents-empty-state-copy";
import {
  AGENTS_PAGE_SIZE,
  AGENTS_TIME_RANGE_DEFAULT,
  AgentsTimeRange,
  getAgentsPrecedingRangeIso,
  getAgentsRangeStartIso,
} from "../lib/agents-timeframe";
import { AGENTS_TYPE_TAB_VALUES } from "../lib/agents-type-tab-vocabulary";
import { useAgentComponentsViewState } from "./use-agent-components-view-state";
import { useAgentsInventoryViewGated } from "./use-agents-inventory-view";

/**
 * ISS-9398 — everything `AgentsListSurfaceV2` renders, assembled once.
 *
 * The ASSEMBLY half of the split the ticket asks for: the window, the view
 * state, the type tab, the inventory read, the grouping, the state selection and
 * the pagination decision. The surface's presentation parts read this model and
 * render it; none of them re-derives any of it, so there is exactly one answer
 * to every question the two shells could otherwise answer differently.
 *
 * {@link AGENTS_PAGE_SIZE} is the one page size and
 * {@link isAgentsPaginationVisible} the one visibility rule; neither is
 * reachable from a host prop (ISS-9216).
 */
/**
 * The persisted arrangement, forwarded verbatim.
 *
 * Typed off the hook rather than restated, so the Show/Hide menu and the grid
 * cannot come to disagree about the column id union. `visibleColumns`,
 * `onToggleColumn` and `metricMode` carry that vocabulary; `columnOrder` and its
 * setter are plain `string` in the persistence layer by design, since it filters
 * unknown ids at runtime.
 */
type AgentsPersistedView = ReturnType<typeof useAgentComponentsViewState>;

export type AgentsListSurfaceV2ViewModel = {
  /** Which of the surface's complete states the read has settled into. */
  readonly state: CompleteSurfaceState;

  readonly activeKindTab: AgentsTypeTabValue;
  readonly onKindTabChange: (value: string) => void;

  readonly filters: AgentComponentFilters;
  readonly onFiltersChange: (next: AgentComponentFilters) => void;
  readonly facets: AgentComponentFacetCounts;
  readonly timeRange: AgentsTimeRange;
  readonly onTimeRangeChange: (next: AgentsTimeRange) => void;

  readonly groupBy: AgentComponentGroupBy;
  readonly onGroupByChange: (next: AgentComponentGroupBy) => void;
  readonly visibleColumns: AgentsPersistedView["visibleColumns"];
  readonly columnOrder: AgentsPersistedView["columnOrder"];
  readonly onColumnOrderChange: AgentsPersistedView["setColumnOrder"];
  readonly onToggleColumn: AgentsPersistedView["toggleColumn"];
  readonly onResetView: () => void;

  readonly metricMode: AgentsPersistedView["metricMode"];
  /**
   * Whether the KPI strip is pinned above the table's scroll plane (ISS-5530).
   * Inside the scroll wrapper, scrolling right to reach the trailing columns
   * dragged the cards sideways out of view with it.
   */
  readonly metricsPinned: boolean;
  readonly summaryCurrent: SummaryAggregate;
  readonly summaryPrevious: SummaryAggregate | undefined;
  readonly deltaLabel: string | undefined;
  /** @see AgentsInventoryGatedView.invocationsDedupeApplied */
  readonly invocationsDedupeApplied: boolean;

  readonly sortKey: AgentComponentSortKey;
  readonly sortDir: AgentComponentSortDir;
  readonly onSort: (col: string, dir: AgentComponentSortDir) => void;
  /** Grouped sections for the grouped layout; `undefined` when ungrouped. */
  readonly tableGroups: AgentsTableGroup[] | undefined;
  readonly flatItems: AgentComponent[];

  /** The sentence an empty state leads with. */
  readonly emptyMessage: string;
  /**
   * Whether the empty state is the installed-plugins inventory's, which gets a
   * composed title + description instead of one grey line (FEA-4086).
   */
  readonly isHonestPluginsEmpty: boolean;

  readonly page: number;
  readonly totalPages: number;
  readonly onPageChange: (page: number) => void;
  /** The surface's ONE pagination-visibility rule (ISS-9216 AC3). */
  readonly paginationVisible: boolean;

  /** Whether the active tab is the one a plugin-management panel belongs under. */
  readonly pluginManagementSlotActive: boolean;
};

export function useAgentsListSurfaceV2ViewModel(
  persistKey: string
): AgentsListSurfaceV2ViewModel {
  // Only a source that APPLIES the window bounds can produce a real
  // prior-period baseline or an unwindowed facet universe; from one that ignores
  // them the preceding read returns the same rows and every delta computes a
  // fabricated 0%. The source declares this (ISS-6888) rather than the surface
  // inferring it from a scope string.
  const dataSource = useAgentComponentsDataSource();
  const supportsDateWindow = dataSource.honorsDateWindow;

  const [timeRange, setTimeRange] = useState<AgentsTimeRange>(
    AGENTS_TIME_RANGE_DEFAULT
  );

  // FEA-3178: both windows come off a SINGLE `now` snapshot per `timeRange`, so
  // `prevEnd === startDate` exactly. A fresh `Date()` per render would churn
  // both query keys.
  const { startDate, precedingRange } = useMemo(() => {
    const now = new Date();
    return {
      startDate: getAgentsRangeStartIso(timeRange, now),
      precedingRange: supportsDateWindow
        ? getAgentsPrecedingRangeIso(timeRange, now)
        : undefined,
    };
  }, [timeRange, supportsDateWindow]);

  const deltaLabel = precedingRange
    ? `vs prev ${agentsWindowNoun(timeRange)}`
    : undefined;

  const {
    sortKey,
    sortDir,
    groupBy,
    metricMode,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    setSort,
    toggleColumn,
    resetColumns,
    setGroupBy,
    setMetricMode,
    isViewReady,
  } = useAgentComponentsViewState(persistKey);

  // FEA-3557: the active tab lives in `?kind=`, so `/agents?kind=tool` deep-links
  // to the Tools tab and refresh / back-forward / copy-link all preserve it. The
  // URL tab is both the mount seed for `filters.kinds` and its only ongoing
  // writer, so this one-way sync cannot fight a second kind source.
  const { activeTab: activeKindTab, setActiveTab: setActiveKindTab } =
    useTabParam<AgentsTypeTabValue>({
      defaultTab: ALL_TYPES,
      paramName: "kind",
      validTabs: AGENTS_TYPE_TAB_VALUES,
    });

  const kindTabFilterKinds = useMemo<AgentComponentKind[]>(
    () => (activeKindTab === ALL_TYPES ? [] : [activeKindTab]),
    [activeKindTab]
  );

  // Mount seed so a deep link filters BEFORE the first paint (no unfiltered
  // flash). The filter hook reads this once; later tab changes flow through the
  // sync effect below.
  const initialFilters: AgentComponentFilters = {
    ...DEFAULT_AGENT_COMPONENT_FILTERS,
    kinds: kindTabFilterKinds,
  };

  const {
    filters,
    handleFiltersChange,
    page,
    setPage,
    totalPages,
    pageRows,
    facets,
    summary,
    isLoading,
    isError,
    invocationsDedupeApplied,
  } = useAgentsInventoryViewGated({
    initialFilters,
    pageSize: AGENTS_PAGE_SIZE,
    precedingRange,
    sortDir,
    sortKey,
    startDate,
    supportsDateWindow,
    isViewReady,
  });

  // ISS-5530 / ISS-5527: the two swaps the honesty gate owns on this surface —
  // where the KPI strip sits relative to the scroll plane, and whether a kind
  // that contributed no row to THIS page still gets a header. Read ONCE here, so
  // the gate is resolved in a single place rather than at each point of use.
  //
  // Only one of the two is a derivation, and this comment does not claim
  // otherwise (marisolashgrove review on PR #6803). `keepRowlessGroupHeaders`
  // inverts the flag and is consumed as a grouping rule. `metricsPinned` is this
  // same boolean under a name that says what it decides — `AgentsListSurfaceV2`
  // branches on it three times to place one node — so it is a rename, not a
  // computation.
  const surfaceHonestyEnabled = useFeatureFlagEnabledOptional(
    AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY
  );
  const keepRowlessGroupHeaders = !surfaceHonestyEnabled;

  const handleTimeRangeChange = (next: AgentsTimeRange) => {
    // A window change re-queries the server rather than changing client filters,
    // so it is not a filter change and `handleFiltersChange`'s own reset does not
    // cover it — land the user on page 1 of the freshly windowed set.
    setPage(0);
    setTimeRange(next);
  };

  // Keep `filters.kinds` in step with the URL tab on LATER changes (tab click,
  // back/forward); the mount case is already covered by `initialFilters`.
  useEffect(() => {
    const sameKinds =
      filters.kinds.length === kindTabFilterKinds.length &&
      filters.kinds.every((k, i) => k === kindTabFilterKinds[i]);
    if (!sameKinds) {
      handleFiltersChange({ ...filters, kinds: kindTabFilterKinds });
    }
  }, [kindTabFilterKinds, filters, handleFiltersChange]);

  const handleKindTabChange = (value: string) => {
    // ToggleGroup fires with the empty string when the active item is
    // re-clicked; treat that as "All" so one tab is always selected.
    setActiveKindTab(value ? value : ALL_TYPES);
  };

  // Group WITHIN the page so the same page-size cap applies whether or not
  // grouping is on. The summary reads the aggregate over the FULL filtered set.
  const groups = useMemo(
    () => groupAgentComponentRows(pageRows, groupBy),
    [pageRows, groupBy]
  );

  const isGrouped = groupBy !== AgentComponentGroupBy.None;
  const tableGroups: AgentsTableGroup[] | undefined = isGrouped
    ? groups
        .filter(
          // ISS-5527: a labeled group earns a header only when it has rows.
          // Grouping runs over the PAGE, so a kind with no row on this page read
          // as "this org has no Workflows" when it meant "none landed in these
          // 50". The `None` case (empty label) drops empties either way.
          (g) =>
            g.items.length > 0 || (keepRowlessGroupHeaders && g.label !== "")
        )
        .map((g) => ({
          key: g.label || "ungrouped",
          label: g.label,
          items: g.items,
        }))
    : undefined;
  const flatItems: AgentComponent[] = isGrouped
    ? []
    : (groups[0]?.items ?? pageRows);

  const isEmpty = isGrouped
    ? (tableGroups?.every((g) => g.items.length === 0) ?? true)
    : flatItems.length === 0;

  const hasActiveFacetOrSearch = hasActiveAgentsFacetOrSearch(filters);
  const harnessScope = pluginHarnessScope(activeKindTab, filters);
  const isHonestPluginsEmpty = isHonestAgentsPluginsEmpty(
    activeKindTab,
    timeRange,
    filters
  );

  const state = selectAgentsListSurfaceState({
    hasActiveFilters:
      hasActiveFacetOrSearch ||
      activeKindTab !== ALL_TYPES ||
      timeRange !== AgentsTimeRange.All,
    isEmpty,
    isError,
    isLoading,
  });

  const handleSort = (col: string, dir: AgentComponentSortDir) => {
    setSort(agentsColumnSortKey(col), dir);
  };

  const handleResetView = () => {
    setGroupBy(AgentComponentGroupBy.Type);
    setSort(AgentComponentSortKey.Metric);
    setMetricMode(AgentMetricMode.LocPerDollar);
    resetColumns();
  };

  return {
    activeKindTab,
    columnOrder,
    deltaLabel,
    emptyMessage: emptyStateMessage(
      activeKindTab,
      timeRange,
      hasActiveFacetOrSearch,
      isHonestPluginsEmpty,
      harnessScope
    ),
    facets,
    filters,
    flatItems,
    groupBy,
    invocationsDedupeApplied,
    isHonestPluginsEmpty,
    metricMode,
    metricsPinned: surfaceHonestyEnabled,
    onColumnOrderChange: setColumnOrder,
    onFiltersChange: handleFiltersChange,
    onGroupByChange: setGroupBy,
    onKindTabChange: handleKindTabChange,
    onPageChange: setPage,
    onResetView: handleResetView,
    onSort: handleSort,
    onTimeRangeChange: handleTimeRangeChange,
    onToggleColumn: toggleColumn,
    page,
    paginationVisible: isAgentsPaginationVisible({ state, totalPages }),
    pluginManagementSlotActive: activeKindTab === AgentComponentKind.Plugin,
    sortDir,
    sortKey,
    state,
    summaryCurrent: summary.current,
    summaryPrevious: summary.previous,
    tableGroups,
    timeRange,
    totalPages,
    visibleColumns,
  };
}

/**
 * Which complete state the inventory read has settled into.
 *
 * NOTE for a future reader: the non-empty half of
 * {@link CompleteSurfaceState.FilteredEmpty}'s contract is NOT established here,
 * because this surface holds no unfiltered total. Nothing may act on it — in
 * particular, do not hang a "clear filters" affordance off this state without
 * first obtaining that total, or a zero-agent org on the Skills tab is offered a
 * filter it never set.
 *
 * Pure and exported so the ladder is asserted directly rather than inferred
 * from rendered copy.
 *
 * The PRECEDENCE is not this function's to invent — it delegates to
 * {@link deriveListEmptyReason}, the repository's classifier for why a list came
 * back with zero rows (FEA-4181), which the Sessions and Branches surfaces
 * already derive from. That is what stops an in-flight read reading as an empty
 * org, and a rejected one reading as an empty org during an outage.
 *
 * WHY `hasActiveFilters` COUNTS THE TYPE TAB AND THE WINDOW. A Skills tab with no
 * skills resolves to {@link CompleteSurfaceState.FilteredEmpty}, and that is the
 * classifier's deliberate answer rather than a shortcut: its own contract records
 * that the Filtered/Empty split "rests on whether a filter is genuinely narrowing
 * the scope", because no host holds a count of rows BEFORE its filters and an
 * earlier draft that consulted one mislabelled a page-clamp artifact. So
 * {@link CompleteSurfaceState.GenuineEmpty} is claimed only where it is exactly
 * true — nothing narrowing at all, so the read IS the whole population.
 *
 * `Unavailable` covers a failed read and an unhydrated one alike, and this
 * surface renders them differently, so that one reason splits back out on
 * `isError`.
 */
export function selectAgentsListSurfaceState({
  hasActiveFilters,
  isEmpty,
  isError,
  isLoading,
}: {
  hasActiveFilters: boolean;
  isEmpty: boolean;
  isError: boolean;
  isLoading: boolean;
}): CompleteSurfaceState {
  const reason = deriveListEmptyReason({
    hasActiveFilters,
    isUnavailable: isLoading || isError,
  });
  if (reason === ListEmptyReason.Unavailable) {
    return isError ? CompleteSurfaceState.Error : CompleteSurfaceState.Loading;
  }
  if (!isEmpty) {
    return CompleteSurfaceState.Ready;
  }
  return reason === ListEmptyReason.Filtered
    ? CompleteSurfaceState.FilteredEmpty
    : CompleteSurfaceState.GenuineEmpty;
}

/**
 * ISS-9216 AC1/AC3 — the surface's ONE pagination-visibility rule.
 *
 * Pure and exported so both halves are asserted directly. They are not
 * equivalent and neither is redundant: `totalPages > 1` is what hides a
 * one-page footer (the v2 `TablePagination` stays mounted on any page count, so
 * this is the only thing suppressing it; ISS-11412), while `Ready` is what
 * stops a footer appearing over a population that is not being shown — the
 * reachable case being a rejected
 * refetch, where the query retains the previous rows so `totalPages` is still
 * above one while the surface is drawing an error.
 *
 * No host prop reaches either half.
 */
export function isAgentsPaginationVisible({
  state,
  totalPages,
}: {
  state: CompleteSurfaceState;
  totalPages: number;
}): boolean {
  return state === CompleteSurfaceState.Ready && totalPages > 1;
}
