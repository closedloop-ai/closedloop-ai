"use client";

/**
 * Agents workspace consolidated grouped list (T-3.4).
 *
 * DEFAULT layout for the /[orgSlug]/agents route and the desktop Agents view.
 *
 * Renders:
 *   (1) Type quick-filter tab bar (`AgentsTypeTabStrip`, extracted by ISS-4803):
 *       All + one tab per AgentComponentKind in AGENTS_TYPE_TAB_CORE_KINDS
 *       (`agents/lib/agents-type-tab-vocabulary.ts`). FEA-4019
 *       graduated Tools / MCPs / Hooks to first-class top-level tabs
 *       (unconditionally, on BOTH web and desktop), so the strip is now
 *       Agents / Commands / Skills / Plugins / MCPs / Tools / Hooks. Workflow,
 *       Config, and Orchestration have no dedicated tab and stay reachable via
 *       "All" (see `agents/lib/agents-type-tab-vocabulary.ts`).
 *   (2) Toolbar row: FilterPopover (via agentComponentFilterFacetGroups) +
 *       AgentsViewMenu (group-by / show-hide columns / reset).
 *   (3) AgentsTable: the current page from `useAgentsInventoryView()`, grouped
 *       for display by `groupAgentComponentRows`.
 *
 * Data:         useAgentsInventoryView — ISS-6822 put BOTH inventory read shapes
 *               behind one hook: the legacy full-population reads reduced here,
 *               and the bounded page-data read where the producer reduces. This
 *               component renders the same five results either way.
 * Filter state: useAgentsInventoryView (over useAgentComponentsFilterState)
 * View state:   useAgentComponentsViewState(persistKey)
 * Navigation:   getComponentHref prop — callers supply the href factory; no
 *               surface route is hardcoded in this component.
 *
 * Mirrors packages/app/branches/components/branches-toolbar.tsx composition
 * for the FilterPopover / NOOP_TABLE_FILTERS_CONTROLLER pattern.
 *
 * Do NOT import from apps/prototypes — this file is the production port.
 */

import {
  type AgentComponent,
  AgentComponentGroupBy,
  AgentComponentKind,
  type AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentFilters } from "@repo/api/src/utils/agent-component-reduce";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "@repo/api/src/utils/agent-component-reduce";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { Input } from "@repo/design-system/components/ui/input";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import { SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import { useTabParam } from "../../../shared/hooks/use-tab-param";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "../../../shared/lib/facet-filter";
import {
  AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY,
  AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
  AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY,
  AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
} from "../../../shared/lib/feature-flags";
import { useAgentComponentsDataSource } from "../../data-source/provider";
import { useAgentComponentsViewState } from "../../hooks/use-agent-components-view-state";
import { useAgentsInventoryView } from "../../hooks/use-agents-inventory-view";
import { groupAgentComponentRows } from "../../lib/agent-component-sort-group";
import { agentsColumnSortKey } from "../../lib/agents-column-sort-keys";
import {
  type AgentsTypeTabValue,
  ALL_TYPES,
  agentsWindowNoun,
  emptyStateMessage,
  hasActiveAgentsFacetOrSearch,
  isHonestAgentsPluginsEmpty,
  pluginHarnessScope,
} from "../../lib/agents-empty-state-copy";
import {
  AGENTS_PAGE_SIZE,
  AGENTS_TIME_RANGE_DEFAULT,
  AGENTS_TIME_RANGE_LABELS,
  AGENTS_TIME_RANGE_SHORT_LABELS,
  AGENTS_TIME_RANGES,
  type AgentsTimeRange,
  getAgentsPrecedingRangeIso,
  getAgentsRangeStartIso,
} from "../../lib/agents-timeframe";
import {
  AGENTS_TYPE_TAB_OPTIONS,
  AGENTS_TYPE_TAB_VALUES,
} from "../../lib/agents-type-tab-vocabulary";
import { kindMeta } from "../../lib/component-meta";
import { agentComponentFilterFacetGroups } from "./agent-component-filter-adapter";
import { AgentsSummaryCards } from "./agents-summary-cards";
import { AgentsTable, type AgentsTableGroup } from "./agents-table";
import { AgentsTypeTabStrip } from "./agents-type-tab-strip";
import { AgentsViewMenu } from "./agents-view-menu";

// Props

export type AgentsGroupedListProps = {
  /**
   * localStorage persistence key for view state — differs per surface:
   *   "agents:web"     → web /[orgSlug]/agents page
   *   "agents:desktop" → desktop NavId.Agents renderer
   */
  persistKey?: string;
  /**
   * Href factory for list→detail navigation. Callers inject the surface-
   * specific href so no route is hardcoded here.
   *
   *   Web:     (item) => `/${orgSlug}/agents/${item.id}`
   *   Desktop: (item) => `/agents/${encodeURIComponent(item.id)}`
   *
   * When absent, rows are not clickable (no Name lead link rendered).
   */
  getComponentHref?: (item: AgentComponent) => string;
  /**
   * Surface-specific content rendered at the BOTTOM of the scroll area only
   * while the Plugins type-tab is active. Desktop injects its plugin management
   * panel (install / update / uninstall) here so management lives under the
   * Plugins inventory in the single tab bar until the dedicated desktop Packs
   * page lands (FEA-4085 evacuated the Packs *distribution catalog* from this
   * slot; desktop keeps only its install/uninstall/update management here — the
   * sibling Packs page is FEA-4086/4087/4089). Web passes nothing.
   */
  pluginsFooter?: ReactNode;
};

// renderContent — helper to avoid nested ternaries in the render tree
// (noNestedTernary lint rule).

type RenderContentProps = {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  emptyMessage: string;
  /**
   * FEA-4086: when present, a fully-composed empty state (title + description +
   * action) that replaces the default single-line message. The honest Plugins
   * inventory uses the shared `EmptyState` here so its "No plugins installed"
   * title lands first and the Packs pointer reads as a quieter description —
   * matching the `EmptyState` the sibling Packs panel renders on the same tab,
   * instead of two same-weight grey lines. Absent for every other tab, whose
   * one-line empty state stays the plain centered `emptyMessage`.
   */
  emptyNode?: ReactNode;
  getComponentHref?: (item: AgentComponent) => string;
  tableGroups: AgentsTableGroup[] | undefined;
  flatItems: AgentComponent[];
  metricMode: AgentMetricMode;
  handleSort: (col: string, dir: AgentComponentSortDir) => void;
  sortKey: string;
  sortDir: AgentComponentSortDir;
  visibleColumns?: Set<string>;
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
};

function renderContent({
  isLoading,
  isError,
  isEmpty,
  emptyMessage,
  emptyNode,
  getComponentHref,
  tableGroups,
  flatItems,
  metricMode,
  handleSort,
  sortKey,
  sortDir,
  visibleColumns,
  columnOrder,
  onColumnOrderChange,
}: RenderContentProps) {
  if (isLoading) {
    return (
      <p className="px-4 py-12 text-center text-muted-foreground text-sm">
        Loading components…
      </p>
    );
  }
  // A rejected query must not fall through to the empty state — that would
  // tell every org "no agents" during an outage. Surface a real error instead
  // (mirrors TokenTrendChart's `text-destructive` failure copy).
  if (isError) {
    // ISS-9398 gave this paragraph a live region so an outage is ANNOUNCED, and
    // backported it here: a screen-reader user's experience of a failed read
    // must not depend on which side of `agent-ops-complete-surface` they are on.
    return (
      <p
        className="px-4 py-12 text-center text-destructive text-sm"
        role="alert"
      >
        Couldn't load components. Check your connection and try again.
      </p>
    );
  }
  if (isEmpty) {
    // A composed EmptyState (title + description) wins when the caller supplies
    // one — the honest Plugins inventory — so the two lines gain hierarchy
    // instead of reading as two same-weight grey sentences. Every other tab
    // keeps the plain one-line centered message.
    if (emptyNode) {
      return emptyNode;
    }
    return (
      <p className="px-4 py-12 text-center text-muted-foreground text-sm">
        {emptyMessage}
      </p>
    );
  }
  return (
    <AgentsTable
      columnOrder={columnOrder}
      getComponentHref={getComponentHref}
      groups={tableGroups}
      items={flatItems}
      metricMode={metricMode}
      onColumnOrderChange={onColumnOrderChange}
      onSort={handleSort}
      sortBy={sortKey}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

// AgentsGroupedList

/**
 * Production consolidated grouped-list component (T-3.4).
 *
 * Composes AgentsTable, agentComponentFilterFacetGroups, AgentsViewMenu, and
 * the Phase-2 hooks. Mirror of the prototype AgentsGroupedList but wired to
 * production data, state, and primitive components.
 */
export function AgentsGroupedList({
  persistKey,
  getComponentHref,
  pluginsFooter,
}: AgentsGroupedListProps) {
  // ── Data-source window support (FEA-3178, ISS-6888) ────────────────────────
  // Both window-relative reads — the preceding-period baseline behind the delta
  // chip, and the unwindowed facet universe that keeps an idle owner listed as a
  // zero-count option — are only meaningful from a source that actually APPLIES
  // the `startDate`/`endDate` bounds. From one that ignores them the preceding
  // read returns the SAME rows as the current one and every delta computes a
  // FABRICATED 0%, so `false` suppresses both and renders no delta at all.
  //
  // ISS-6888: the source DECLARES that, it is not inferred from its scope string.
  // This was `scope === "agent-components:http"`, written by FEA-3178 when the
  // desktop local source genuinely ignored the window — and left untouched when
  // FEA-3196 taught it to apply the bounds end to end, so desktop kept losing
  // both reads long after the reason had gone. A string comparison cannot notice
  // that; a required field on the port makes the next source answer for itself.
  const dataSource = useAgentComponentsDataSource();
  const supportsDateWindow = dataSource.honorsDateWindow;

  // ── Time window (All / 30 / 60 / 90 day) ───────────────────────────────────
  // FEA-3160: the window is enforced SERVER-SIDE. The old client filtered the
  // fetched rows by `lastSeenAt` (the inventory-observation time the pack
  // scanner refreshes to `now()` on every sync), so `lastSeenAt >= (now − Nd)`
  // was always true and the control was a no-op. We now derive a `startDate`
  // ISO lower bound from the selected range and pass it to the list endpoint,
  // which scopes the USAGE aggregation (`lastInvokedAt >= startDate`) and drops
  // components with zero in-window usage. `undefined` (the "All" window) sends
  // no bound ⇒ all-time inventory view.
  const [timeRange, setTimeRange] = useState<AgentsTimeRange>(
    AGENTS_TIME_RANGE_DEFAULT
  );

  // FEA-3178: derive the current window's `startDate` AND the preceding window's
  // `{prevStart, prevEnd}` from a SINGLE `now` snapshot per timeRange, so
  // `prevEnd === startDate` exactly (the preceding window ends where the current
  // one begins). Recomputed only when the selected range changes — a fresh
  // `Date()` every render would churn the query keys and thrash both requests.
  const { startDate, precedingRange } = useMemo(() => {
    const now = new Date();
    return {
      startDate: getAgentsRangeStartIso(timeRange, now),
      // Only a windowed source can produce a real prior-period baseline; on a
      // source that ignores the window the preceding query is meaningless, so
      // suppress it entirely (no fabricated 0% delta).
      precedingRange: supportsDateWindow
        ? getAgentsPrecedingRangeIso(timeRange, now)
        : undefined,
    };
  }, [timeRange, supportsDateWindow]);

  // Human caption for the delta chip, derived from the active window's label
  // (e.g. "Last 30 days" → "vs prev 30 days").
  const deltaLabel = precedingRange
    ? `vs prev ${agentsWindowNoun(timeRange)}`
    : undefined;

  // ── View state ────────────────────────────────────────────────────────────
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

  // ── Type-tab selection (FEA-3557: durable URL permalink) ───────────────────
  // The active type tab lives in the `?kind=` URL param via useTabParam, so
  // `/agents?kind=tool` deep-links straight to the Tools tab and refresh /
  // back-forward / copy-link all preserve it. filters.kinds remains the single
  // narrowing mechanism the sort→filter→paginate pipeline reads; the URL tab is
  // both the initial seed for that filter (below) and its only ongoing writer
  // (the FilterPopover exposes owner/source/harness facets, not kind), so this
  // one-way URL→filters sync can't fight another kind source.
  //
  // Valid tabs = "all" + the core kinds shown as top-level type tabs. A
  // deep-linked `?kind=` that isn't a visible tab (a scoped-out kind reachable
  // only via "All", or a bogus value) falls back to ALL_TYPES — the default is
  // omitted from the URL for a clean canonical link (useTabParam handles both).
  const { activeTab: activeKindTab, setActiveTab: setActiveKindTab } =
    useTabParam<AgentsTypeTabValue>({
      defaultTab: ALL_TYPES,
      paramName: "kind",
      validTabs: AGENTS_TYPE_TAB_VALUES,
    });

  // Kinds narrowing derived from the URL tab: empty = All, one entry = that
  // kind. This drives both the mount seed (below) and the ongoing sync effect,
  // so the type-tab is the single source of the kind filter.
  const kindTabFilterKinds = useMemo<AgentComponentKind[]>(
    () => (activeKindTab === ALL_TYPES ? [] : [activeKindTab]),
    [activeKindTab]
  );

  // Mount seed for the filter-state hook so a deep link / refresh filters BEFORE
  // the first paint (no unfiltered flash). The hook reads this ONCE (its
  // `useState` initial value); recomputing it every render is harmless and lets
  // the mount value reflect the deep-linked `?kind=`. Later tab changes flow
  // through the sync effect below, not through this seed.
  const initialFilters: AgentComponentFilters = {
    ...DEFAULT_AGENT_COMPONENT_FILTERS,
    kinds: kindTabFilterKinds,
  };

  // ISS-5009: resolve the Source-provenance flag ONCE here, then hand the SAME
  // value to the membership predicate (below) and to the facet menu that builds
  // the options the user picks from. Gating only the menu would offer an honest
  // option that the legacy membership test matches against the identity-key
  // echo — a positive count selecting zero rows. `…Optional` because this
  // component also mounts without a `FeatureFlagAdapterProvider`.
  const honestSourceEnabled = useFeatureFlagEnabledOptional(
    AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY
  );

  // ISS-4803: whether the type strip collapses the tabs it cannot fit into an
  // overflow menu. `…Optional` for the same reason as above — this component
  // also mounts without a `FeatureFlagAdapterProvider`, and the honest default
  // there is the behavior that ships today (every tab on the strip).
  const typeTabOverflowEnabled = useFeatureFlagEnabledOptional(
    AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY
  );

  // ISS-5534 (ISS-4779 closed-by-default): whether the Invocations summary card
  // counts each invocation once instead of adding a plugin's child rollup to the
  // very child rows it was rolled up from. `…Optional` for the same reason as
  // above — this component also mounts without a `FeatureFlagAdapterProvider`,
  // and the honest default there is the pre-ISS-5534 flat sum.
  const dedupePluginRollups = useFeatureFlagEnabledOptional(
    AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY
  );

  // ISS-6822 (ISS-4779 closed-by-default): whether the inventory is read as ONE
  // bounded page — page rows, matched total, facet counts, and both window
  // aggregates — instead of pulling up to three full populations here and
  // reducing them in the browser. `…Optional` for the same reason as above, and
  // the honest default there is the read that ships today. A data source with no
  // `pageData` ignores this entirely and keeps the legacy path (see
  // `useAgentsInventoryView`), which is what an installed desktop build whose
  // preload predates the IPC method gets.
  const boundedPageDataEnabled = useFeatureFlagEnabledOptional(
    AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY
  );

  // ISS-5530 / ISS-5527 (ISS-4779 closed-by-default): the two swaps this module
  // owns in the Agents honesty batch — where the KPI strip sits relative to the
  // table's scroll plane, and whether a kind that contributed no row to THIS
  // page still gets a header. `…Optional` for the same reason as above.
  const surfaceHonestyEnabled = useFeatureFlagEnabledOptional(
    AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY
  );

  // ── Inventory read ────────────────────────────────────────────────────────
  // One hook owns BOTH read shapes and returns the same five things either way:
  // the page, the matched total, the facet counts, both window aggregates, and
  // the load/error state. Nothing below this line knows which one ran, which is
  // exactly why the flag can be flipped without the rendering changing.
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
  } = useAgentsInventoryView({
    startDate,
    precedingRange,
    supportsDateWindow,
    sortKey,
    sortDir,
    pageSize: AGENTS_PAGE_SIZE,
    initialFilters,
    honestSourceEnabled,
    dedupePluginRollups,
    boundedPageDataEnabled,
    isViewReady,
  });

  // The hook already resets to page 0 inside handleFiltersChange, so callers do
  // not need their own reset. Time-window changes are NOT filter changes (the
  // window re-queries the server rather than changing client filters), so reset
  // paging here so the user lands on page 1 of the freshly windowed set.
  const handleTimeRangeChange = (next: AgentsTimeRange) => {
    setPage(0);
    setTimeRange(next);
  };

  // Keep filters.kinds in sync with the URL tab on LATER changes (tab click,
  // back/forward). The mount case is already covered by `initialFilters` above,
  // so this effect only fires when `kindTabFilterKinds` actually changes; the
  // guard skips a redundant setState / page reset when the derived kind already
  // matches the current filter.
  useEffect(() => {
    const sameKinds =
      filters.kinds.length === kindTabFilterKinds.length &&
      filters.kinds.every((k, i) => k === kindTabFilterKinds[i]);
    if (!sameKinds) {
      handleFiltersChange({ ...filters, kinds: kindTabFilterKinds });
    }
  }, [kindTabFilterKinds, filters, handleFiltersChange]);

  const handleKindTabChange = (value: string) => {
    // ToggleGroup fires with empty string when the active item is re-clicked.
    // Treat that as "All" to keep one tab always selected. The URL write flows
    // back into filters.kinds via the effect above.
    setActiveKindTab(value ? value : ALL_TYPES);
  };

  // ── Group the current page ─────────────────────────────────────────────────
  // `pageRows` is the current AGENTS_PAGE_SIZE slice of the sorted+filtered set;
  // group WITHIN the page so the same page-size cap applies whether or not
  // grouping is on. The summary cards read the aggregate over the FULL filtered
  // set, never this slice.
  const groups = useMemo(
    () => groupAgentComponentRows(pageRows, groupBy),
    [pageRows, groupBy]
  );

  // Derive groups/flat-items for AgentsTable.
  const isGrouped = groupBy !== AgentComponentGroupBy.None;
  const tableGroups: AgentsTableGroup[] | undefined = isGrouped
    ? groups
        .filter(
          (g) =>
            // ISS-5527: a labeled group is kept only when it has rows. Grouping
            // runs over the PAGE, so a kind with no row on this page has no
            // header to earn — and the header it used to get read as "this org
            // has no Workflows" when it meant "none landed in these 50". This is
            // the answer the `Harness` branch of `groupAgentComponentRows`
            // already reached for the same reason. Flag OFF keeps every labeled
            // group, empty or not. The None case (empty label) drops empties
            // either way.
            g.items.length > 0 || (!surfaceHonestyEnabled && g.label !== "")
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

  // Empty-state copy. The type tab (filters.kinds) is not a "filter the user
  // set" for messaging purposes — it is the tab they are on — so only the facet
  // (collaborators/source/harness) and search inputs flip to the generic filter
  // copy.
  const hasActiveFacetOrSearch = hasActiveAgentsFacetOrSearch(filters);
  // FEA-4086: the Plugins tab is an installed-plugins inventory, so an empty
  // Plugins tab means "nothing is installed" — an honest, install-oriented copy
  // rather than the vaguer "No plugins yet." shared with the observed kinds, or
  // the "no components match the current filters" copy the user never
  // triggered. Two narrowings still qualify as the honest install state:
  //   • no facet/search at all           → "No plugins installed."
  //   • ONLY a single harness facet       → "No plugins installed for Claude."
  // Any OTHER facet (owner/source) or a search box IS a filtered view, so those
  // fall through to the generic filter copy inside emptyStateMessage.
  //
  // The honest "nothing installed" claim is only true for the ALL-TIME window.
  // Under a 30/60/90-day window the service drops plugins with zero in-window
  // usage (`dropZeroWindowUsage`), so an empty windowed Plugins tab means "no
  // plugins USED in this window", not "none installed" — claiming the latter
  // would lie about the inventory. Windowed empties therefore fall through to
  // the usage-worded copy inside `emptyStateMessage`.
  const harnessScope = pluginHarnessScope(activeKindTab, filters);
  const isHonestPluginsEmpty = isHonestAgentsPluginsEmpty(
    activeKindTab,
    timeRange,
    filters
  );
  const emptyMessage = emptyStateMessage(
    activeKindTab,
    timeRange,
    hasActiveFacetOrSearch,
    isHonestPluginsEmpty,
    harnessScope
  );

  // FEA-4086: the honest Plugins-inventory empty state composes the shared
  // `EmptyState` (the same treatment the sibling Packs panel renders on this
  // tab) so its "No plugins installed" title lands first and the Packs pointer
  // reads as a quieter description — not two same-weight grey lines. The Packs
  // page is a sibling slice, so the pointer is plain description text, not a
  // catalog card or link. Every other tab keeps the plain one-line message.
  const emptyNode = isHonestPluginsEmpty ? (
    <EmptyState
      description="Add plugins from Packs."
      icon={kindMeta(AgentComponentKind.Plugin).icon}
      title={emptyMessage}
    />
  ) : undefined;

  // ── Sort handler forwarded from AgentsTable ───────────────────────────────
  const handleSort = (col: string, dir: typeof sortDir) => {
    setSort(agentsColumnSortKey(col), dir);
  };

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setGroupBy(AgentComponentGroupBy.Type);
    setSort(AgentComponentSortKey.Metric);
    setMetricMode(AgentMetricMode.LocPerDollar);
    // Parity with the prototype's resetView: restore hidden columns too.
    resetColumns();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  // ISS-5517: the strip is handed the read's own load state so it can tell an
  // unfetched population from a counted-and-empty one. It decides what to render
  // from that alone; this file only owns WHERE it sits.
  const summaryCards = (
    <AgentsSummaryCards
      current={summary.current}
      dedupePluginRollups={dedupePluginRollups}
      deltaLabel={deltaLabel}
      isError={isError}
      isLoading={isLoading}
      previous={summary.previous}
    />
  );

  return (
    <>
      {/* Type quick-filter tab bar — its OWN row above the controls. FEA-4019
          grew the strip to seven tabs, which no longer fits on the same line as
          the search + time-window + filter + view controls at a default desktop
          width; a shared line would strand the search and wrap the trailing
          controls into a broken-looking second row. ISS-4803 moved the strip
          into its own component, which keeps the scrolling track and adds the
          overflow menu the clipped tabs previously had no way out of. */}
      <AgentsTypeTabStrip
        onValueChange={handleKindTabChange}
        options={AGENTS_TYPE_TAB_OPTIONS}
        overflowMenuEnabled={typeTabOverflowEnabled}
        value={activeKindTab}
      />

      {/* Toolbar controls row — right-aligned below the type-tab strip. */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b px-4 py-3">
        {/* Inventory search (FEA-3054). The filter itself already exists in
            useAgentComponentsFilterState (filterAgentComponentRows matches
            filters.search); this control was the only missing piece. Bound
            directly to filters.search, which stays live so the box never lags
            the keystroke; the bounded read settles the term downstream in
            useAgentsInventoryView, where a keystroke costs a request rather than
            an in-memory pass. Clearing the box restores the (type-tab-scoped)
            list. Shared component → web AND desktop. */}
        <div className="relative w-full min-w-[180px] sm:w-56">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            size={16}
          />
          <Input
            aria-label="Search components"
            className="pl-8"
            onChange={(event) =>
              handleFiltersChange({ ...filters, search: event.target.value })
            }
            placeholder="Search by name"
            type="search"
            value={filters.search}
          />
        </div>

        {/* Time window (All / 30 / 60 / 90 day) — the shared DateRangeFilter
            parameterized with the Agents-local range set. */}
        <DateRangeFilter<AgentsTimeRange>
          ariaLabel="Time window"
          labels={AGENTS_TIME_RANGE_LABELS}
          onChange={handleTimeRangeChange}
          ranges={AGENTS_TIME_RANGES}
          shortLabels={AGENTS_TIME_RANGE_SHORT_LABELS}
          value={timeRange}
        />

        {/* Filter menu */}
        <FilterPopover
          controller={NOOP_TABLE_FILTERS_CONTROLLER}
          viewModel={buildFacetOnlyFiltersViewModel(
            // `facets` carries per-option counts over the filtered set with the
            // UNWINDOWED org inventory as the value universe (FEA-3202), so
            // zero-count Owner/Source options stay visible as the time window
            // narrows — and it was counted under the SAME source projection the
            // membership predicate uses (ISS-5009), because one reduction
            // produced both.
            agentComponentFilterFacetGroups(
              facets,
              filters,
              handleFiltersChange
            )
          )}
        />

        {/* View menu: Group-by, Show/Hide columns, Reset */}
        <AgentsViewMenu
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          onReset={handleReset}
          onToggleColumn={toggleColumn}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* ISS-5530: the KPI strip summarizes the whole filtered population, so it
          is not part of the table's scroll plane. Inside the `overflow-auto`
          wrapper below, scrolling the table right to reach the trailing columns
          dragged the cards sideways out of view with it. Pinned here it stays
          put while the table scrolls under it. Flag OFF keeps it in the scroll
          area exactly as it ships today. */}
      {surfaceHonestyEnabled ? (
        <div className="flex shrink-0 flex-col gap-4 px-4 pt-3 pb-4">
          {summaryCards}
        </div>
      ) : null}

      {/* Scrollable content area */}
      <div className="min-h-0 flex-1 overflow-auto">
        {surfaceHonestyEnabled ? null : (
          <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
            {summaryCards}
          </div>
        )}

        {/* Error / empty state / loading / table */}
        {renderContent({
          isLoading,
          isError,
          isEmpty,
          emptyMessage,
          emptyNode,
          getComponentHref,
          tableGroups,
          flatItems,
          metricMode,
          handleSort,
          sortKey,
          sortDir,
          visibleColumns,
          columnOrder,
          onColumnOrderChange: setColumnOrder,
        })}

        {/* Client-side pagination. The v2 pager stays mounted on a single
            page with both boundaries locked, as v2 is designed (ISS-11412);
            it is left out only while the inventory is loading or failed. */}
        {isLoading || isError ? null : (
          <TablePagination
            className="px-4 py-3"
            onPageChange={setPage}
            page={page}
            totalPages={totalPages}
          />
        )}

        {/* Surface-injected management panel, under the Plugins inventory only. */}
        {activeKindTab === AgentComponentKind.Plugin && pluginsFooter ? (
          <div className="mt-2 border-t pt-2">{pluginsFooter}</div>
        ) : null}
      </div>
    </>
  );
}
