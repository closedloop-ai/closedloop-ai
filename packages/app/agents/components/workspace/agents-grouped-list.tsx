"use client";

/**
 * Agents workspace consolidated grouped list (T-3.4).
 *
 * DEFAULT layout for the /[orgSlug]/agents route and the desktop Agents view.
 *
 * Renders:
 *   (1) Type quick-filter tab bar: All + one tab per AgentComponentKind in
 *       SCOPED_CORE_KINDS (Agents / Commands / Skills / Plugins).  The full
 *       KIND_ORDER is also available but the prototype scopes the top-level tabs
 *       to the four "observed" kinds.
 *   (2) Toolbar row: FilterPopover (via agentComponentFilterFacetGroups) +
 *       AgentsViewMenu (group-by / show-hide columns / metric selector).
 *   (3) AgentsTable: data from useAgentComponents() piped through
 *       sortAgentComponentRows → groupAgentComponentRows.
 *
 * Filter state: useAgentComponentsFilterState
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
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { LayersIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import { useFeatureFlagEnabled } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../../shared/lib/facet-filter";
import { AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { useAgentComponentsDataSource } from "../../data-source/provider";
import { useAgentComponents } from "../../hooks/use-agent-components";
import {
  filterAgentComponentRows,
  useAgentComponentsFilterState,
} from "../../hooks/use-agent-components-filter-state";
import { useAgentComponentsViewState } from "../../hooks/use-agent-components-view-state";
import {
  groupAgentComponentRows,
  sortAgentComponentRows,
} from "../../lib/agent-component-sort-group";
import {
  AGENT_INVENTORY_FETCH_LIMIT,
  AGENTS_PAGE_SIZE,
  AGENTS_TIME_RANGE_DEFAULT,
  AGENTS_TIME_RANGE_LABELS,
  AGENTS_TIME_RANGE_SHORT_LABELS,
  AGENTS_TIME_RANGES,
  type AgentsTimeRange,
  getAgentsPrecedingRangeIso,
  getAgentsRangeStartIso,
} from "../../lib/agents-timeframe";
import { KIND_ORDER, kindMeta, NUMBER_FORMAT } from "../../lib/component-meta";
import { agentComponentFilterFacetGroups } from "./agent-component-filter-adapter";
import { AgentsTable, type AgentsTableGroup } from "./agents-table";
import { AgentsViewMenu } from "./agents-view-menu";

// ---------------------------------------------------------------------------
// Scoped core kinds — matches the prototype's CORE_KINDS selection from
// apps/prototypes/app/p/agents/components/agents-workspace.tsx.
// By default only the four "observed" kinds appear as type-tab buttons at the
// top level. Workflows and Config are always accessible via "All" but have no
// dedicated tab. MCP tools, Tools, and Hooks are scoped out by default too, but
// the FEA-3152 `agents-show-tools-mcps-hooks` desktop Labs flag promotes them to
// first-class top-level type tabs when ON (see FLAG_GATED_KINDS below).
// ---------------------------------------------------------------------------

// Always scoped out — reachable via "All", never a promoted top-level type tab,
// regardless of any Labs flag.
const BASE_SCOPED_OUT_KINDS: ReadonlySet<AgentComponentKind> =
  new Set<AgentComponentKind>([
    AgentComponentKind.Workflow,
    AgentComponentKind.Config,
  ]);

// FEA-3152: observable-only kinds that are scoped out by DEFAULT (same
// observable-not-distributable treatment as before) but surface as first-class
// top-level type tabs when the `agents-show-tools-mcps-hooks` desktop Labs flag
// is ON. These remain observable-only — the flag only affects listing
// visibility, never the promote/catalog/distribution flow. Mcp and Tool were
// already observable-only (FEA-3048); this set makes their tab visibility, plus
// Hook's, flag-gated.
const FLAG_GATED_KINDS: ReadonlySet<AgentComponentKind> =
  new Set<AgentComponentKind>([
    AgentComponentKind.Mcp,
    AgentComponentKind.Tool,
    AgentComponentKind.Hook,
  ]);

/**
 * The set of kinds hidden from the top-level type-tab bar.
 *
 * - Flag OFF (default): base scoped-out kinds PLUS the flag-gated kinds
 *   (mcp/tool/hook) — exactly today's behavior.
 * - Flag ON: only the base scoped-out kinds, so mcp/tool/hook get their own
 *   top-level tabs alongside Agents/Commands/Skills/Plugins.
 */
function scopedOutKinds(
  showToolsMcpsHooks: boolean
): ReadonlySet<AgentComponentKind> {
  if (showToolsMcpsHooks) {
    return BASE_SCOPED_OUT_KINDS;
  }
  return new Set<AgentComponentKind>([
    ...BASE_SCOPED_OUT_KINDS,
    ...FLAG_GATED_KINDS,
  ]);
}

/**
 * Core kinds shown as top-level type tabs, in `KIND_ORDER`. Derived from the
 * flag-aware scoped-out set so tool/mcp/hook render in their canonical order
 * position (Plugin → Mcp → Tool → Hook) when the flag is ON.
 */
function scopedCoreKinds(
  showToolsMcpsHooks: boolean
): readonly AgentComponentKind[] {
  const scopedOut = scopedOutKinds(showToolsMcpsHooks);
  return KIND_ORDER.filter((kind) => !scopedOut.has(kind));
}

const ALL_TYPES = "all" as const;

// FEA-3178: strips the leading "Last " from a window label ("Last 30 days" →
// "30 days") when building the delta-chip caption. Top-level per
// lint/performance/useTopLevelRegex.
const LEADING_LAST_RE = /^Last\s+/i;

// ---------------------------------------------------------------------------
// Summary cards — same logic as the prototype AgentsSummaryCards but now
// fully typed against production AgentComponent rows.
//
// FEA-3178: each card shows a period-over-period delta (e.g. "+12% vs prev 30
// days") comparing the current time-scoped aggregate to the preceding
// equivalent window. The previous-window population is fetched by a second
// `useAgentComponents` query in AgentsGroupedList (startDate=prevStart,
// endDate=prevEnd) and passed in here. No delta is shown for the "All" window
// (no finite prior period) or when a prior aggregate is empty.
// ---------------------------------------------------------------------------

/**
 * FEA-3178: the four headline aggregates the summary cards display, computed
 * over a population of components. Extracted so the current and previous
 * windows are aggregated by the identical reduction (no drift between them).
 * KLOC/$ is the average of the non-null per-component ratios.
 */
type SummaryAggregate = {
  components: number;
  invocations: number;
  avgKloc: number;
  owners: number;
};

function computeSummaryAggregate(
  components: readonly AgentComponent[]
): SummaryAggregate {
  const invocations = components.reduce(
    (sum, c) => sum + (c.invocations ?? 0),
    0
  );
  const klocValues = components
    .map((c) => c.klocPerDollar)
    .filter((v): v is number => v !== null);
  const avgKloc = klocValues.length
    ? klocValues.reduce((sum, v) => sum + v, 0) / klocValues.length
    : 0;
  const owners = new Set(
    components.filter((c) => c.owner !== null).map((c) => c.owner as string)
  ).size;
  return {
    components: components.length,
    invocations,
    avgKloc,
    owners,
  };
}

// Whole-percent rounding factor for the period-over-period delta chip (the
// MetricCard chip renders `{delta}%` as an integer with a leading `+`).
const PERCENT = 100;

/**
 * FEA-3178: signed integer percentage change from `previous` → `current`,
 * rounded to a whole percent. Returns `undefined` — meaning "render no delta
 * chip" — whenever a percentage would be meaningless or misleading:
 *
 *  - `previous` is undefined (the "All" window has no prior period, or the
 *    preceding query has not resolved), or
 *  - the prior aggregate is 0 (division by zero — a jump from nothing to
 *    something is not a defensible "N%").
 *
 * This never fabricates a delta: an absent or empty baseline yields no chip,
 * never a placeholder number.
 */
function percentDelta(
  current: number,
  previous: number | undefined
): number | undefined {
  if (previous === undefined || previous === 0) {
    return undefined;
  }
  return Math.round(((current - previous) / previous) * PERCENT);
}

type SummaryCardsProps = {
  /**
   * The FULL windowed, filtered population across ALL pages — never the current
   * page slice (`pagedRows`). The headline stats (Components / Invocations /
   * KLOC-per-$ / Owners) must aggregate over the entire filtered set so they do
   * not change as the user pages through the list. Passing `pagedRows` here
   * would silently under-count everything on the visible page.
   */
  allFilteredComponents: readonly AgentComponent[];
  /**
   * FEA-3178: the PRECEDING equivalent window's population (same duration,
   * shifted back one period), run through the SAME facet filters as
   * `allFilteredComponents` so the delta compares like-for-like. `undefined`
   * when there is no meaningful prior period — the "All" window, a data source
   * that does not honor the date window (e.g. the desktop local source; showing
   * a fabricated 0% would be misleading), or the preceding query has not
   * resolved — in which cases no delta chips render.
   */
  previousComponents?: readonly AgentComponent[];
  /**
   * Human caption for the delta chip, e.g. "vs prev 30 days". Only used when a
   * delta actually renders.
   */
  deltaLabel?: string;
};

function AgentsSummaryCards({
  allFilteredComponents,
  previousComponents,
  deltaLabel,
}: SummaryCardsProps) {
  const current = computeSummaryAggregate(allFilteredComponents);
  const previous = previousComponents
    ? computeSummaryAggregate(previousComponents)
    : undefined;

  const cards = [
    {
      key: "components",
      label: "Components",
      value: NUMBER_FORMAT.format(current.components),
      delta: percentDelta(current.components, previous?.components),
      detail: "matched by the current filters",
      info: {
        what: "Agents, commands, and skills in the current view.",
        how: "Count of components in the active filter set.",
      },
    },
    {
      key: "invocations",
      label: "Invocations",
      value: NUMBER_FORMAT.format(current.invocations),
      delta: percentDelta(current.invocations, previous?.invocations),
      detail: "across components in view",
      info: {
        what: "Total tool calls attributed to these components.",
        how: "Sum of each in-view component's recorded invocations (per-component totals; the time window scopes which components are counted).",
      },
    },
    {
      key: "kloc",
      label: "KLOC / $",
      value: current.avgKloc.toFixed(1),
      delta: percentDelta(current.avgKloc, previous?.avgKloc),
      detail: "avg across components",
      info: {
        what: "Average merged KLOC per dollar across these components.",
        how: "Directional — a session-level metric, not caused by one component.",
      },
    },
    {
      key: "owners",
      label: "Owners",
      value: NUMBER_FORMAT.format(current.owners),
      delta: percentDelta(current.owners, previous?.owners),
      detail: "with components in view",
      info: {
        what: "Distinct owners of components in the current view.",
        how: "Unique owner assigned to at least one visible component.",
      },
    },
  ];

  return (
    <div className="flex gap-4">
      {cards.map((card) => (
        <MetricCard
          className="w-[260px] shrink-0"
          delta={card.delta}
          deltaLabel={card.delta === undefined ? undefined : deltaLabel}
          detail={card.detail}
          info={card.info}
          key={card.key}
          label={card.label}
          value={card.value}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

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
   * panel (install / update / uninstall / catalog) here so management lives
   * under the Plugins inventory in the single tab bar; web passes nothing.
   */
  pluginsFooter?: ReactNode;
  /**
   * Whether GitHub data is connected. Threaded into the Owner column so an
   * unattributed row shows the Connect-GitHub CTA when GitHub is not connected
   * (governing design FEA-2923). Undefined (desktop / pre-fetch) → plain "—".
   */
  githubConnected?: boolean;
  /** Hard-navigation connect target for the Owner-column CTA (web only). */
  githubConnectHref?: string;
};

// ---------------------------------------------------------------------------
// renderContent — helper to avoid nested ternaries in the render tree
// (noNestedTernary lint rule).
// ---------------------------------------------------------------------------

type RenderContentProps = {
  isLoading: boolean;
  isEmpty: boolean;
  getComponentHref?: (item: AgentComponent) => string;
  tableGroups: AgentsTableGroup[] | undefined;
  flatItems: AgentComponent[];
  metricMode: AgentMetricMode;
  handleSort: (col: string, dir: AgentComponentSortDir) => void;
  sortKey: string;
  sortDir: AgentComponentSortDir;
  visibleColumns?: Set<string>;
  githubConnected?: boolean;
  githubConnectHref?: string;
};

function renderContent({
  isLoading,
  isEmpty,
  getComponentHref,
  tableGroups,
  flatItems,
  metricMode,
  handleSort,
  sortKey,
  sortDir,
  visibleColumns,
  githubConnected,
  githubConnectHref,
}: RenderContentProps) {
  if (isLoading) {
    return (
      <p className="px-4 py-12 text-center text-muted-foreground text-sm">
        Loading components…
      </p>
    );
  }
  if (isEmpty) {
    return (
      <p className="px-4 py-12 text-center text-muted-foreground text-sm">
        No components match the current filters.
      </p>
    );
  }
  return (
    <AgentsTable
      getComponentHref={getComponentHref}
      githubConnected={githubConnected}
      githubConnectHref={githubConnectHref}
      groups={tableGroups}
      items={flatItems}
      metricMode={metricMode}
      onSort={handleSort}
      sortBy={sortKey}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

// ---------------------------------------------------------------------------
// AgentsGroupedList
// ---------------------------------------------------------------------------

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
  githubConnected,
  githubConnectHref,
}: AgentsGroupedListProps) {
  // ── Flag: surface Tools/MCPs/Hooks as first-class kinds (FEA-3152) ─────────
  // Desktop Labs opt-in. OFF (web + default desktop) → tool/mcp/hook stay
  // scoped-out exactly as before; ON → they get their own top-level type tabs.
  const showToolsMcpsHooks = useFeatureFlagEnabled(
    AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY
  );
  const coreKinds = useMemo(
    () => scopedCoreKinds(showToolsMcpsHooks),
    [showToolsMcpsHooks]
  );

  // ── Data-source window support (FEA-3178) ──────────────────────────────────
  // The period-over-period delta is only meaningful when the active data source
  // actually HONORS the `startDate`/`endDate` window. The HTTP/web source
  // ("agent-components:http") applies the window server-side, so the preceding
  // query returns a genuinely different population. The desktop LOCAL source
  // ("agent-components:local") ignores the window, so the preceding query would
  // return the SAME rows as the current one and every delta would compute a
  // FABRICATED 0%. Gate the delta on the windowed source: on any non-HTTP source
  // we render NO delta rather than a fake baseline.
  const dataSource = useAgentComponentsDataSource();
  const supportsDateWindow = dataSource.scope === "agent-components:http";

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

  // ── Data ──────────────────────────────────────────────────────────────────
  // Fetch the whole (server-windowed) org inventory in one request (bounded by
  // the server's MAX_ORG_INVENTORY_ROWS cap) so filtering, grouping, the summary
  // cards, and pagination are all computed over the FULL windowed set
  // client-side. Without the explicit limit the API defaults to 50, which
  // silently truncated the list and made the summary cards count only the first
  // 50 rows. `startDate` is part of the query key, so changing the window
  // re-queries and React Query serves a fresh windowed page.
  const { data, isLoading } = useAgentComponents({
    limit: AGENT_INVENTORY_FETCH_LIMIT,
    startDate,
  });
  const allRows: AgentComponent[] = data?.items ?? [];

  // FEA-3178: second query for the PRECEDING equivalent window (same duration,
  // shifted back one period) — bounded above by `endDate=prevEnd` so it does
  // NOT overlap the current window. Drives the period-over-period delta chips on
  // the summary cards. Disabled for the "All" range (no finite prior period),
  // where `precedingRange` is undefined and no baseline is fetched, so the cards
  // render no delta. `startDate`/`endDate` are part of the query key.
  const { data: previousData } = useAgentComponents(
    {
      limit: AGENT_INVENTORY_FETCH_LIMIT,
      startDate: precedingRange?.prevStart,
      endDate: precedingRange?.prevEnd,
    },
    { enabled: precedingRange !== undefined }
  );
  // Raw preceding-window population. It is run through the SAME facet-filter
  // pipeline as the current rows below (see `previousFilteredRows`) so the delta
  // compares like-for-like (facet-filtered current vs facet-filtered previous),
  // not facet-filtered-current vs unfiltered-previous.
  const previousRows: AgentComponent[] | undefined = precedingRange
    ? (previousData?.items ?? undefined)
    : undefined;

  // Human caption for the delta chip, derived from the active window's label
  // (e.g. "Last 30 days" → "vs prev 30 days").
  const deltaLabel = precedingRange
    ? `vs prev ${AGENTS_TIME_RANGE_LABELS[timeRange]
        .replace(LEADING_LAST_RE, "")
        .toLowerCase()}`
    : undefined;

  // ── View state ────────────────────────────────────────────────────────────
  const {
    sortKey,
    sortDir,
    groupBy,
    metricMode,
    visibleColumns,
    setSort,
    toggleColumn,
    resetColumns,
    setGroupBy,
    setMetricMode,
  } = useAgentComponentsViewState(persistKey);

  // ── Sort → filter → paginate pipeline ──────────────────────────────────────
  // `allRows` is already windowed by the server, so sort it directly (no
  // client-side time filter). Sort FIRST, then feed the filter-state hook so its
  // filter (order-preserving) and its own pagination operate on the already
  // sorted set. This reuses the hook's page/pagedRows/totalPages/clamp machinery
  // (the single owner of the "resets to page 0 on filter change" + "clamp a
  // stale page after the set shrinks" logic) at AGENTS_PAGE_SIZE, instead of
  // hand-rolling a second parallel pagination system here.
  const sortedRows = useMemo(
    () => sortAgentComponentRows(allRows, sortKey, sortDir),
    [allRows, sortKey, sortDir]
  );

  const {
    filters,
    filteredRows,
    pagedRows,
    page,
    setPage,
    totalPages,
    handleFiltersChange,
  } = useAgentComponentsFilterState(sortedRows, AGENTS_PAGE_SIZE);

  // FEA-3178: apply the SAME facet filters to the preceding-window population as
  // the current window (the `filteredRows` the summary cards aggregate). The
  // delta must compare like-for-like — facet-filtered current vs facet-filtered
  // previous — otherwise a facet-narrowed current view is compared against the
  // whole unfiltered prior inventory, producing an apples-to-oranges percentage.
  // Sorting is irrelevant to the aggregate, so only the facet filter is applied.
  const previousFilteredRows: AgentComponent[] | undefined = useMemo(
    () =>
      previousRows === undefined
        ? undefined
        : filterAgentComponentRows(previousRows, filters),
    [previousRows, filters]
  );

  // The hook already resets to page 0 inside handleFiltersChange, so callers do
  // not need their own reset. Time-window changes are NOT filter changes (the
  // window re-queries the server rather than changing client filters), so reset
  // paging here so the user lands on page 1 of the freshly windowed set.
  const handleTimeRangeChange = (next: AgentsTimeRange) => {
    setPage(0);
    setTimeRange(next);
  };

  // ── Type-tab selection ────────────────────────────────────────────────────
  // The active kind tab is stored in filters.kinds (single-select when using
  // type tabs: empty = All, one entry = specific kind).
  const activeKindTab: AgentComponentKind | typeof ALL_TYPES =
    filters.kinds.length === 1 ? filters.kinds[0] : ALL_TYPES;

  const handleKindTabChange = (value: string) => {
    // ToggleGroup fires with empty string when the active item is re-clicked.
    // Treat that as "All" to keep one tab always selected.
    if (!value || value === ALL_TYPES) {
      handleFiltersChange({ ...filters, kinds: [] });
    } else {
      handleFiltersChange({
        ...filters,
        kinds: [value as AgentComponentKind],
      });
    }
  };

  // ── Group the current page ─────────────────────────────────────────────────
  // pagedRows is the current AGENTS_PAGE_SIZE slice of the sorted+filtered set;
  // group WITHIN the page so the same page-size cap applies whether or not
  // grouping is on. The summary cards below intentionally read the FULL filtered
  // set (filteredRows), not the page slice.
  const groups = useMemo(
    () => groupAgentComponentRows(pagedRows, groupBy),
    [pagedRows, groupBy]
  );

  // Derive groups/flat-items for AgentsTable.
  const isGrouped = groupBy !== AgentComponentGroupBy.None;
  const tableGroups: AgentsTableGroup[] | undefined = isGrouped
    ? groups
        .filter(
          (g) =>
            // Always include labeled groups even when empty (show empty-state
            // row rather than omitting); for the None case (empty label) we
            // skip empty groups.
            g.label !== "" || g.items.length > 0
        )
        .map((g) => ({
          key: g.label || "ungrouped",
          label: g.label,
          items: g.items,
        }))
    : undefined;
  const flatItems: AgentComponent[] = isGrouped
    ? []
    : (groups[0]?.items ?? pagedRows);

  const isEmpty = isGrouped
    ? (tableGroups?.every((g) => g.items.length === 0) ?? true)
    : flatItems.length === 0;

  // ── Sort handler forwarded from AgentsTable ───────────────────────────────
  const handleSort = (col: string, dir: typeof sortDir) => {
    // Map column id → AgentComponentSortKey. Unmapped columns fall back to Name.
    const COL_TO_SORT_KEY: Record<string, AgentComponentSortKey> = {
      name: AgentComponentSortKey.Name,
      type: AgentComponentSortKey.Type,
      metric: AgentComponentSortKey.Metric,
      owner: AgentComponentSortKey.Owner,
      source: AgentComponentSortKey.Source,
      harness: AgentComponentSortKey.Harness,
      invocations: AgentComponentSortKey.Invocations,
      sessions: AgentComponentSortKey.Sessions,
    };
    const key = COL_TO_SORT_KEY[col] ?? AgentComponentSortKey.Name;
    setSort(key, dir);
  };

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setGroupBy(AgentComponentGroupBy.Type);
    setSort(AgentComponentSortKey.Metric);
    setMetricMode(AgentMetricMode.KlocPerDollar);
    // Parity with the prototype's resetView: restore hidden columns too.
    resetColumns();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Type quick-filter tab bar + toolbar controls */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        {/* Type tab bar */}
        <div className="max-w-full overflow-x-auto">
          <ToggleGroup
            onValueChange={handleKindTabChange}
            type="single"
            value={activeKindTab}
            variant="outline"
          >
            <ToggleGroupItem aria-label="All" value={ALL_TYPES}>
              <LayersIcon className="size-4" />
              All
            </ToggleGroupItem>
            {coreKinds.map((kind) => {
              const Icon = kindMeta(kind).icon;
              return (
                <ToggleGroupItem
                  aria-label={kindMeta(kind).plural}
                  key={kind}
                  value={kind}
                >
                  <Icon className="size-4" />
                  {kindMeta(kind).plural}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </div>

        {/* Spacer pushes controls to the right */}
        <div className="flex-1" />

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
          viewModel={{
            teamMembers: [],
            statusOptions: [],
            priorityOptions: [],
            hideQuickToggles: true,
            facetGroups: agentComponentFilterFacetGroups(
              // filteredRows drives per-option counts; allRows (the FULL org
              // inventory, NOT the time-scoped subset) is the value universe so
              // zero-count facet options stay visible as the time window narrows.
              filteredRows,
              allRows,
              filters,
              handleFiltersChange
            ),
          }}
        />

        {/* View menu: Group-by, Show/Hide columns, metric selector */}
        <AgentsViewMenu
          groupBy={groupBy}
          metricMode={metricMode}
          onGroupByChange={setGroupBy}
          onMetricModeChange={setMetricMode}
          onReset={handleReset}
          onToggleColumn={toggleColumn}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Scrollable content area */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Summary metric cards */}
        <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
          <AgentsSummaryCards
            allFilteredComponents={filteredRows}
            deltaLabel={deltaLabel}
            previousComponents={previousFilteredRows}
          />
        </div>

        {/* Empty state / loading / table */}
        {renderContent({
          isLoading,
          isEmpty,
          getComponentHref,
          tableGroups,
          flatItems,
          metricMode,
          handleSort,
          sortKey,
          sortDir,
          visibleColumns,
          githubConnected,
          githubConnectHref,
        })}

        {/* Client-side pagination — renders nothing when there is one page. */}
        {isLoading ? null : (
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
