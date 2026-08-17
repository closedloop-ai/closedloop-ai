"use client";

/**
 * Agents workspace consolidated grouped list (T-3.4).
 *
 * DEFAULT layout for the /[orgSlug]/agents route and the desktop Agents view.
 *
 * Renders:
 *   (1) Type quick-filter tab bar (`AgentsTypeTabStrip`, extracted by ISS-4803):
 *       All + one tab per AgentComponentKind in SCOPED_CORE_KINDS. FEA-4019
 *       graduated Tools / MCPs / Hooks to first-class top-level tabs
 *       (unconditionally, on BOTH web and desktop), so the strip is now
 *       Agents / Commands / Skills / Plugins / MCPs / Tools / Hooks. Workflow,
 *       Config, and Orchestration have no dedicated tab and stay reachable via
 *       "All" (see SCOPED_OUT_KINDS at the bottom of this file).
 *   (2) Toolbar row: FilterPopover (via agentComponentFilterFacetGroups) +
 *       AgentsViewMenu (group-by / show-hide columns / reset).
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
  Harness,
} from "@repo/api/src/types/agent-component";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { formatLocPerDollar } from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { Input } from "@repo/design-system/components/ui/input";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { LayersIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import {
  SummaryCardRow,
  summaryCardClass,
} from "../../../shared/components/summary-card-row";
import { useTabParam } from "../../../shared/hooks/use-tab-param";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../../shared/lib/facet-filter";
import {
  AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
  AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
} from "../../../shared/lib/feature-flags";
import { useAgentComponentsDataSource } from "../../data-source/provider";
import { useAgentComponents } from "../../hooks/use-agent-components";
import {
  type AgentComponentFilters,
  DEFAULT_AGENT_COMPONENT_FILTERS,
  filterAgentComponentRows,
  normalizedSearch,
  useAgentComponentsFilterState,
} from "../../hooks/use-agent-components-filter-state";
import { useAgentComponentsViewState } from "../../hooks/use-agent-components-view-state";
import {
  groupAgentComponentRows,
  sortAgentComponentRows,
} from "../../lib/agent-component-sort-group";
import {
  computeSummaryAggregatePair,
  invocationsDerivation,
} from "../../lib/agents-summary-aggregate";
import {
  AGENT_INVENTORY_FETCH_LIMIT,
  AGENTS_PAGE_SIZE,
  AGENTS_TIME_RANGE_DEFAULT,
  AGENTS_TIME_RANGE_LABELS,
  AGENTS_TIME_RANGE_SHORT_LABELS,
  AGENTS_TIME_RANGES,
  AgentsTimeRange,
  getAgentsPrecedingRangeIso,
  getAgentsRangeStartIso,
} from "../../lib/agents-timeframe";
import {
  HARNESS_META,
  KIND_ORDER,
  kindMeta,
  NUMBER_FORMAT,
} from "../../lib/component-meta";
import { agentComponentFilterFacetGroups } from "./agent-component-filter-adapter";
import { AgentsTable, type AgentsTableGroup } from "./agents-table";
import {
  type AgentsTypeTabOption,
  AgentsTypeTabStrip,
} from "./agents-type-tab-strip";
import { AgentsViewMenu } from "./agents-view-menu";

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

// ISS-5534: the `SummaryAggregate` shape and its reduction now live in
// `../../lib/agents-summary-aggregate`, which also owns the plugin-rollup
// de-duplication of the Invocations total (a plugin's invocations ARE its
// children's, and on the All tab both are rows). Extracted so the aggregation
// has a component-free test target and this grandfathered file shrinks.

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
   * ISS-5534: whether the Invocations total de-duplicates plugin rollups against
   * the child rows they were rolled up from. Resolved once by the list (PostHog
   * on web, Labs on desktop) and threaded in, so the CURRENT and PRECEDING
   * windows are always aggregated under the same rule — a delta computed from a
   * deduped current against a flat baseline would be meaningless.
   */
  dedupePluginRollups: boolean;
  /**
   * The FULL windowed, filtered population across ALL pages — never the current
   * page slice (`pagedRows`). The headline stats (Components / Invocations /
   * LOC-per-$ / Owners) must aggregate over the entire filtered set so they do
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
  dedupePluginRollups,
}: SummaryCardsProps) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  const { current, previous } = computeSummaryAggregatePair(
    allFilteredComponents,
    previousComponents,
    dedupePluginRollups
  );

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
        // ISS-6182: read the explainer from the same gate that picks the
        // reduction, so the card can never describe a derivation it no longer
        // runs.
        how: invocationsDerivation(dedupePluginRollups).how,
      },
    },
    // FEA-4052: the LOC/$ card renders ONLY when the population has at least
    // one verifiable-kind component (currently only `subagent`; skill/command
    // are session-level, not component-level, so they are excluded — wongk, PR
    // #3720). A view built solely of non-verifiable kinds (skill/command/plugin/
    // mcp/tool/…) hides the card in lockstep with the hidden column, so the
    // summary never shows a LOC/$ card over a table with no LOC/$ column (or a
    // fabricated `0.0`).
    ...(current.hasVerifiableLocPerDollar
      ? [
          {
            key: "loc-per-dollar",
            label: LOC_PER_DOLLAR_LABEL,
            value: formatLocPerDollar(current.avgLocPerDollar),
            delta:
              current.avgLocPerDollar === null
                ? undefined
                : percentDelta(
                    current.avgLocPerDollar,
                    previous?.avgLocPerDollar ?? undefined
                  ),
            detail: `avg across ${NUMBER_FORMAT.format(current.locPerDollarSampleSize)} ${
              current.locPerDollarSampleSize === 1 ? "component" : "components"
            }`,
            info: {
              // ISS-5366: "changed", not "merged". This averages the same
              // non-merge-scoped `locPerDollar` the Metric column renders (see
              // POLISHED_METRIC_HEADER in agents-table.tsx); only the Sessions
              // card's `mergedLocPerDollar` earns the word "merged".
              what: "Average lines changed per dollar across these components. Higher is better.",
              how: "A session-level metric, so read it as directional. One component doesn't cause it.",
            },
          },
        ]
      : []),
    {
      key: "collaborators",
      label: AGENT_COMPONENT_AUTHORS_LABEL,
      value: NUMBER_FORMAT.format(current.collaborators),
      delta: percentDelta(current.collaborators, previous?.collaborators),
      detail: "authoring components in view",
      info: {
        what: "Distinct authors of components in the current view.",
        how: "Unique discoverer or editor across every visible component's version lineage.",
      },
    },
  ];

  // FEA-3985: reuse the shared SummaryCardRow with `wrapBelow` — the same strip
  // and `md` breakpoint the Sessions list page already ships — so the four cards
  // wrap into a two-column grid below `md` instead of clipping past the right
  // edge, and keep the fixed-min-width, non-shrinking row at `md+`.
  return (
    <SummaryCardRow wrapBelow>
      {cards.map((card) => {
        const commonProps = {
          className: summaryCardClass(true),
          detail: card.detail,
          info: card.info,
          label: card.label,
          value: card.value,
        };
        // `delta`/`deltaPolarity` are a paired union on MetricCard (wongk review
        // on #4148): these are all activity counts (sessions, PRs, components,
        // authors) where a rise is the product working, so they declare
        // higher-is-better explicitly alongside a real number; an absent delta
        // renders no chip.
        if (card.delta === undefined) {
          return <MetricCard key={card.key} {...commonProps} />;
        }
        return (
          <MetricCard
            key={card.key}
            {...commonProps}
            delta={card.delta}
            deltaLabel={deltaLabel}
            deltaPolarity={MetricPolarity.HigherIsBetter}
            deltaTreatment={deltaTreatment}
          />
        );
      })}
    </SummaryCardRow>
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
   * panel (install / update / uninstall) here so management lives under the
   * Plugins inventory in the single tab bar until the dedicated desktop Packs
   * page lands (FEA-4085 evacuated the Packs *distribution catalog* from this
   * slot; desktop keeps only its install/uninstall/update management here — the
   * sibling Packs page is FEA-4086/4087/4089). Web passes nothing.
   */
  pluginsFooter?: ReactNode;
};

// ---------------------------------------------------------------------------
// renderContent — helper to avoid nested ternaries in the render tree
// (noNestedTernary lint rule).
// ---------------------------------------------------------------------------

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
    return (
      <p className="px-4 py-12 text-center text-destructive text-sm">
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
}: AgentsGroupedListProps) {
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
  const { data, isLoading, isError } = useAgentComponents({
    limit: AGENT_INVENTORY_FETCH_LIMIT,
    startDate,
  });
  const allRows: AgentComponent[] = data?.items ?? [];

  // ── Facet value universe (FEA-3202) ────────────────────────────────────────
  // The Owner/Source filter-popover options are supposed to stay visible as
  // zero-count entries as the window narrows. FEA-3160 made the window
  // server-enforced, so the main `allRows` query above now returns the WINDOWED
  // subset (the service drops usage-trackable components with zero in-window
  // usage). Feeding that subset to the facet adapter as the "value universe"
  // makes an owner/source vanish from the dropdown the moment its components
  // have no recent usage. Fetch a SECOND, unwindowed inventory (no `startDate`)
  // solely to seed the facet value universe so every owner/source stays listed.
  //
  // Only needed on a windowed source (HTTP) with a bounded window selected: the
  // desktop LOCAL source ignores the window (its `allRows` is already all-time),
  // and the "All" window sends no `startDate` (the main query is already
  // unwindowed), so in both cases `allRows` IS the universe and this extra query
  // is skipped. While the universe query is in flight (or skipped) we fall back
  // to `allRows`, which is a superset-safe default (never hides a value that the
  // windowed set contains).
  const facetUniverseEnabled = supportsDateWindow && startDate !== undefined;
  const { data: facetUniverseData } = useAgentComponents(
    { limit: AGENT_INVENTORY_FETCH_LIMIT },
    { enabled: facetUniverseEnabled }
  );
  const facetUniverseRows: AgentComponent[] =
    facetUniverseData?.items ?? allRows;

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
    columnOrder,
    setColumnOrder,
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
  const validKindTabs: readonly (AgentComponentKind | typeof ALL_TYPES)[] = [
    ALL_TYPES,
    ...SCOPED_CORE_KINDS,
  ];
  const { activeTab: activeKindTab, setActiveTab: setActiveKindTab } =
    useTabParam<AgentComponentKind | typeof ALL_TYPES>({
      defaultTab: ALL_TYPES,
      paramName: "kind",
      validTabs: validKindTabs,
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

  const {
    filters,
    filteredRows,
    pagedRows,
    page,
    setPage,
    totalPages,
    handleFiltersChange,
  } = useAgentComponentsFilterState(
    sortedRows,
    AGENTS_PAGE_SIZE,
    initialFilters,
    honestSourceEnabled
  );

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
        : filterAgentComponentRows(previousRows, filters, honestSourceEnabled),
    [previousRows, filters, honestSourceEnabled]
  );

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

  // Empty-state copy. The type tab (filters.kinds) is not a "filter the user
  // set" for messaging purposes — it is the tab they are on — so only the facet
  // (collaborators/source/harness) and search inputs flip to the generic filter
  // copy.
  const hasActiveFacetOrSearch =
    filters.collaborators.length > 0 ||
    filters.sources.length > 0 ||
    filters.harnesses.length > 0 ||
    normalizedSearch(filters) !== "";
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
  const isAllTimeWindow = timeRange === AgentsTimeRange.All;
  const harnessScope = pluginHarnessScope(activeKindTab, filters);
  const isHonestPluginsEmpty =
    activeKindTab === AgentComponentKind.Plugin &&
    isAllTimeWindow &&
    (!hasActiveFacetOrSearch || harnessScope !== undefined);
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
    // Map column id → AgentComponentSortKey. Unmapped columns fall back to Name.
    // FEA-4098 (Slice 3): no `owner`/`collaborators` entry — the Collaborators
    // column (authors people-set) is unsortable, so it never reaches here.
    const COL_TO_SORT_KEY: Record<string, AgentComponentSortKey> = {
      name: AgentComponentSortKey.Name,
      type: AgentComponentSortKey.Type,
      metric: AgentComponentSortKey.Metric,
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
    setMetricMode(AgentMetricMode.LocPerDollar);
    // Parity with the prototype's resetView: restore hidden columns too.
    resetColumns();
  };

  // ── Render ────────────────────────────────────────────────────────────────
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
        options={TYPE_TAB_OPTIONS}
        overflowMenuEnabled={typeTabOverflowEnabled}
        value={activeKindTab}
      />

      {/* Toolbar controls row — right-aligned below the type-tab strip. */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b px-4 py-3">
        {/* Inventory search (FEA-3054). The filter itself already exists in
            useAgentComponentsFilterState (filterAgentComponentRows matches
            filters.search); this control was the only missing piece. Bound
            directly to filters.search — filtering is in-memory over the fetched
            inventory, so no debounce is needed; clearing the box restores the
            (type-tab-scoped) list. Shared component → web AND desktop. */}
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
          viewModel={{
            teamMembers: [],
            statusOptions: [],
            priorityOptions: [],
            hideQuickToggles: true,
            facetGroups: agentComponentFilterFacetGroups(
              // filteredRows drives per-option counts; facetUniverseRows (the
              // UNWINDOWED org inventory, NOT the server time-scoped subset —
              // FEA-3202) is the value universe so zero-count Owner/Source
              // options stay visible as the time window narrows.
              filteredRows,
              facetUniverseRows,
              filters,
              handleFiltersChange,
              // ISS-5009: the same flag value the membership predicate above was
              // built with, so an option in this menu always matches the rows it
              // claims to cover.
              honestSourceEnabled
            ),
          }}
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

      {/* Scrollable content area */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Summary metric cards */}
        <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
          <AgentsSummaryCards
            allFilteredComponents={filteredRows}
            dedupePluginRollups={dedupePluginRollups}
            deltaLabel={deltaLabel}
            previousComponents={previousFilteredRows}
          />
        </div>

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

        {/* Client-side pagination — renders nothing when there is one page. */}
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

// ---------------------------------------------------------------------------
// Type-tab scoping
//
// Kinds hidden from the top-level type-tab bar — reachable via "All" only,
// never a promoted top-level type tab:
//   • Workflow / Config      — no dedicated tab historically.
//   • Orchestration          — FEA-4019 graduates ONLY Tools, MCPs, and Hooks;
//     harness/orchestration primitives stay scoped out here (they are also
//     non-promotable per isPromotableKind, so there is nothing to act on from a
//     dedicated tab). Keeping it out also keeps `?kind=orchestration` off the
//     permalink surface on both web and desktop.
//
// FEA-4019: Tools/MCPs/Hooks are now first-class tabs unconditionally on BOTH
// the web and desktop surfaces (this shared component drives both). They were
// previously gated behind the `agents-show-tools-mcps-hooks` desktop Labs flag
// (FEA-3152); that gate was removed so web reaches parity with the desktop tab
// set with no flag/opt-in, and FEA-3995 fully retired the flag (desktop
// registry entry + wire key deleted). Tool stays observable-only (never
// promotable); Mcp and Hook ARE promotable (see isPromotableKind), so promoting
// them to first-class tabs is consistent with the rest of the promote/catalog
// flow.
// ---------------------------------------------------------------------------
const SCOPED_OUT_KINDS: ReadonlySet<AgentComponentKind> =
  new Set<AgentComponentKind>([
    AgentComponentKind.Workflow,
    AgentComponentKind.Config,
    AgentComponentKind.Orchestration,
  ]);

/**
 * Core kinds shown as top-level type tabs, in `KIND_ORDER` (so mcp/tool/hook
 * render in their canonical order position: Plugin → Mcp → Tool → Hook).
 */
const SCOPED_CORE_KINDS: readonly AgentComponentKind[] = KIND_ORDER.filter(
  (kind) => !SCOPED_OUT_KINDS.has(kind)
);

/**
 * The type strip's segments, in render order: `All` then one per core kind.
 *
 * Built once at module scope rather than per render because the vocabulary is
 * static — `SCOPED_CORE_KINDS` is itself derived from `KIND_ORDER` — and
 * `AgentsTypeTabStrip` measures and partitions this array on every resize.
 * Labels come from `kindMeta().plural`, the same map the group-by-Type headers
 * and the empty-state copy read, so a tab can never name a kind differently
 * from the rows it filters to.
 */
const TYPE_TAB_OPTIONS: readonly AgentsTypeTabOption[] = [
  { value: ALL_TYPES, label: "All", icon: LayersIcon },
  ...SCOPED_CORE_KINDS.map((kind) => ({
    value: kind,
    label: kindMeta(kind).plural,
    icon: kindMeta(kind).icon,
  })),
];

/**
 * Empty-state copy for the current tab + window. FEA-4019 promotes four
 * likely-sparse tabs (Tools/MCPs/Hooks) on web, so a generic "No components
 * match the current filters." lands on most first clicks and wrongly implies a
 * filter the user never set. When the only narrowing is the type tab + time
 * window (no facet/search filter), name the kind and the window instead so the
 * message is honest about why the list is empty; fall back to the filter copy
 * only when a facet or search filter really is active.
 *
 * FEA-4086: the Plugins tab is an installed-plugins inventory (the desktop
 * component-scanner projects installed `agent_packs` into `kind:"plugin"` rows;
 * web surfaces the same rows). An empty Plugins tab means nothing is installed,
 * so — when `isHonestPluginsEmpty` — it gets its own honest copy, "No plugins
 * installed", scoped to the active harness when `harnessScope` is set, rather
 * than the vaguer "No plugins yet." or the misleading filter copy. This string
 * is the `EmptyState` title; the pointer to the Packs page is the caller's
 * `EmptyState` description (`emptyNode`), so it is not baked into this string.
 */
export function emptyStateMessage(
  activeKindTab: AgentComponentKind | typeof ALL_TYPES,
  timeRange: AgentsTimeRange,
  hasActiveFacetOrSearch: boolean,
  isHonestPluginsEmpty: boolean,
  harnessScope?: string
): string {
  // FEA-4086: the Plugins-tab "nothing installed" state wins over the generic
  // filter copy even when a single harness facet is the only narrowing, so it
  // is checked before hasActiveFacetOrSearch.
  if (isHonestPluginsEmpty) {
    const scopeSuffix = harnessScope ? ` for ${harnessScope}` : "";
    return `No plugins installed${scopeSuffix}.`;
  }
  if (hasActiveFacetOrSearch) {
    return "No components match the current filters.";
  }
  const kindNoun =
    activeKindTab === ALL_TYPES
      ? "components"
      : kindMeta(activeKindTab).plural.toLowerCase();
  if (timeRange === AgentsTimeRange.All) {
    return `No ${kindNoun} yet.`;
  }
  const windowLabel = AGENTS_TIME_RANGE_LABELS[timeRange]
    .replace(LEADING_LAST_RE, "")
    .toLowerCase();
  // FEA-4086: a windowed Plugins tab drops plugins with zero in-window usage
  // (`dropZeroWindowUsage` on the API), so an empty windowed Plugins tab means
  // "none USED in this window" — not "none in the last N days" (which reads as
  // "none installed"). Word it as usage so it never claims the inventory is
  // empty when the window is what emptied the list.
  if (activeKindTab === AgentComponentKind.Plugin) {
    return `No plugins used in the last ${windowLabel}.`;
  }
  return `No ${kindNoun} in the last ${windowLabel}.`;
}

/**
 * FEA-4086: the display label for the harness the empty Plugins-tab copy is
 * scoped to. A harness scope is claimed only when the Plugins tab is active,
 * a SINGLE harness facet is selected, and NO other facet or search narrows the
 * view — so "No plugins installed for Claude." is only shown when the harness
 * really is the sole narrowing. With no harness facet the inventory spans every
 * harness (no scope claimed); with several selected there is no single harness
 * to name; with an owner/source/search filter the view is a filtered one, not
 * an honest install state. Returns undefined in all of those cases.
 *
 * The lone facet must also be a NAMEABLE single harness: `Harness.Both` is the
 * rollup's "used across more than one harness" marker, not one harness, and its
 * label is "Multiple harnesses". "No plugins installed for Multiple harnesses."
 * would misread as a compound scope, so a `Both`-only facet claims no scope and
 * falls back to the unscoped "No plugins installed." copy.
 *
 * Search is read through `normalizedSearch` so a whitespace-only box counts as
 * no search here exactly as it does in `filterAgentComponentRows` — the two
 * boundaries must agree or a single space empties the list while this still
 * claims a scoped install state.
 */
export function pluginHarnessScope(
  activeKindTab: AgentComponentKind | typeof ALL_TYPES,
  filters: AgentComponentFilters
): string | undefined {
  const harnessOnly =
    filters.harnesses.length === 1 &&
    filters.collaborators.length === 0 &&
    filters.sources.length === 0 &&
    normalizedSearch(filters) === "";
  if (activeKindTab !== AgentComponentKind.Plugin || !harnessOnly) {
    return undefined;
  }
  const only = filters.harnesses[0];
  // `Both` is not a single nameable harness — skip the scope suffix.
  if (only === Harness.Both) {
    return undefined;
  }
  return HARNESS_META[only].label;
}
