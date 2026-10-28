"use client";

import type {
  AgentComponent,
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import {
  type AgentComponentPageDataRequest,
  type AgentComponentPageDataResult,
  deserializeSummaryAggregate,
} from "@repo/api/src/utils/agent-component-page-data";
import {
  type AgentComponentFacetCounts,
  type AgentComponentFilters,
  countFacetValues,
  filterAgentComponentRows,
  sortAgentComponentRows,
} from "@repo/api/src/utils/agent-component-reduce";
import {
  computeSummaryAggregatePair,
  type SummaryAggregate,
} from "@repo/api/src/utils/agent-component-summary-aggregate";
import { useSettledValue } from "@repo/design-system/hooks/use-settled-value";
import { useMemo, useRef, useState } from "react";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY,
  AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
} from "../../shared/lib/feature-flags";
import { gateRestoredRead } from "../../shared/query/gate-restored-read";
import { useAgentComponentsDataSource } from "../data-source/provider";
import { AGENT_INVENTORY_FETCH_LIMIT } from "../lib/agents-timeframe";
import { useCompleteAgentComponents } from "./use-agent-components";
import { useAgentComponentsFilterState } from "./use-agent-components-filter-state";
import { useAgentComponentsPageData } from "./use-agent-components-page-data";

/**
 * Everything the Agents workspace renders that depends on the inventory
 * population — and nothing that does not.
 *
 * Note what is NOT here: rows beyond the current page. The list has no
 * legitimate reader for the rest of the population (the summary cards want
 * aggregates, the facet menu wants counts, the table wants one page), and the
 * old shape's `filteredRows` is exactly what made a bounded read impossible to
 * adopt without changing every consumer.
 */
export type AgentsInventoryView = {
  filters: AgentComponentFilters;
  handleFiltersChange: (next: AgentComponentFilters) => void;
  /** The active page, already clamped to the available range. */
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
  /** The current page of sorted, filtered rows. */
  pageRows: AgentComponent[];
  facets: AgentComponentFacetCounts;
  /** The current window's aggregate; `previous` is absent when no prior window. */
  summary: {
    current: SummaryAggregate;
    previous: SummaryAggregate | undefined;
  };
  isLoading: boolean;
  isError: boolean;
};

export type AgentsInventoryViewParams = {
  /** Inclusive lower bound of the current usage window; absent ⇒ all-time. */
  startDate?: string;
  /** The preceding equivalent window, or absent when there is no prior period. */
  precedingRange?: { prevStart: string; prevEnd: string };
  /** Whether the active data source honors the date window at all. */
  supportsDateWindow: boolean;
  sortKey: AgentComponentSortKey;
  sortDir: AgentComponentSortDir;
  pageSize: number;
  initialFilters: AgentComponentFilters;
  /** ISS-5009 Source-provenance gate, resolved once by the surface. */
  honestSourceEnabled: boolean;
  /** ISS-5534 Invocations de-duplication gate, resolved once by the surface. */
  dedupePluginRollups: boolean;
  /** ISS-6822 gate: read one bounded page instead of the whole population. */
  boundedPageDataEnabled: boolean;
  /**
   * ISS-6141 / ISS-4655: whether the persisted view has settled on the sort it
   * will keep. The bounded read carries `sortKey`/`sortDir` in its query key,
   * so issuing it before the restore lands fetches the DEFAULT view and then
   * fetches the restored one — two reads, each up to three full org population
   * builds at the producer. Required rather than optional so a new surface
   * states its answer instead of silently inheriting the un-gated behavior.
   */
  isViewReady: boolean;
};

/**
 * ISS-6822 — the Agents inventory read, in whichever of its two shapes is
 * active.
 *
 * BOUNDED (`boundedPageDataEnabled`, and a data source that implements
 * `pageData`): one request returns the page, the matched total, the facet
 * counts, and both window aggregates. The reduction runs at the producer.
 *
 * LEGACY (the default, and the only path for a source without `pageData`): the
 * three full-population reads this surface has always issued — current window,
 * unwindowed facet universe, preceding window — reduced here.
 *
 * Both branches call the SAME `@repo/api` reduction over the SAME populations,
 * so they are not two implementations of the list; they are one implementation
 * run in two places. That is why the switch is expected to be invisible.
 *
 * Every hook below runs on every render regardless of branch — the inactive
 * queries are `enabled: false`, not skipped — so the hook order never depends on
 * the flag.
 */
export function useAgentsInventoryView(
  params: AgentsInventoryViewParams
): AgentsInventoryView {
  const {
    startDate,
    precedingRange,
    sortKey,
    sortDir,
    pageSize,
    initialFilters,
    honestSourceEnabled,
    dedupePluginRollups,
    boundedPageDataEnabled,
    supportsDateWindow,
    isViewReady,
  } = params;

  // The flag alone does NOT decide the read shape. A data source with no
  // `pageData` — a Phase-1 stub, a test double, or an installed desktop build
  // whose preload predates the IPC method — cannot serve the bounded read no
  // matter what the flag says, and the honest answer there is the legacy path,
  // not an empty list. Resolving the capability HERE is what makes that true:
  // deciding it from the flag alone would disable the legacy queries while
  // `useAgentComponentsPageData` independently disabled itself for the missing
  // method, leaving BOTH reads off — a permanently empty Agents list reporting
  // neither loading nor error.
  const dataSource = useAgentComponentsDataSource();
  const boundedPageDataActive =
    boundedPageDataEnabled && dataSource.pageData !== undefined;

  // ── Legacy populations ────────────────────────────────────────────────────
  // Fetch the whole (server-windowed) org inventory, so filtering, grouping, the
  // summary cards, and pagination are all computed over the FULL windowed set
  // client-side. ISS-6891: this was ONE request at the server's former inventory
  // cap, which made every one of those client-side numbers describe a PREFIX on
  // any org above it — and the server caps no population now, so a single page
  // cannot stand in for one. `AGENT_INVENTORY_FETCH_LIMIT` is the page size;
  // `useCompleteAgentComponents` follows the pages to exhaustion.
  const legacyEnabled = !boundedPageDataActive;
  const {
    data,
    isLoading: legacyLoading,
    isError: legacyError,
  } = useCompleteAgentComponents(
    { limit: AGENT_INVENTORY_FETCH_LIMIT, startDate },
    { enabled: legacyEnabled }
  );
  const allRows: AgentComponent[] = data?.items ?? EMPTY_ROWS;

  // FEA-3202: the Owner/Source options are supposed to stay visible as
  // zero-count entries as the window narrows, so the value universe is a SECOND,
  // UNWINDOWED inventory. Only needed on a windowed source with a bounded window
  // selected; otherwise `allRows` already IS the universe. While it is in flight
  // (or skipped) `allRows` is a superset-safe fallback — it never hides a value
  // the windowed set contains.
  const facetUniverseEnabled =
    legacyEnabled && supportsDateWindow && startDate !== undefined;
  const { data: facetUniverseData } = useCompleteAgentComponents(
    { limit: AGENT_INVENTORY_FETCH_LIMIT },
    { enabled: facetUniverseEnabled }
  );
  const facetUniverseRows: AgentComponent[] =
    facetUniverseData?.items ?? allRows;

  // FEA-3178: the PRECEDING equivalent window — bounded above by `prevEnd` so it
  // does NOT overlap the current window. Disabled when there is no finite prior
  // period, where no baseline is fetched and the cards render no delta.
  const previousEnabled = legacyEnabled && precedingRange !== undefined;
  const { data: previousData } = useCompleteAgentComponents(
    {
      limit: AGENT_INVENTORY_FETCH_LIMIT,
      startDate: precedingRange?.prevStart,
      endDate: precedingRange?.prevEnd,
    },
    { enabled: previousEnabled }
  );
  const previousRows: AgentComponent[] | undefined = precedingRange
    ? (previousData?.items ?? undefined)
    : undefined;

  // `allRows` is already windowed by the server, so sort it directly (no
  // client-side time filter). Sort FIRST, then filter — the filter is
  // order-preserving, so the page slice below matches the sorted order.
  const sortedRows = useMemo(
    () => sortAgentComponentRows(allRows, sortKey, sortDir),
    [allRows, sortKey, sortDir]
  );

  // The filter object and its page-reset-on-change invariant are owned here in
  // BOTH branches, so a narrowing can never strand the viewer on a stale page.
  // Only the derived row slices differ: in the bounded branch `sortedRows` is
  // empty and the derived `page`/`pagedRows` below are ignored in favour of the
  // producer's own clamped page.
  const {
    filters,
    filteredRows,
    pagedRows,
    page: legacyPage,
    setPage: setLegacyPage,
    totalPages: legacyTotalPages,
    handleFiltersChange,
  } = useAgentComponentsFilterState(
    boundedPageDataActive ? EMPTY_ROWS : sortedRows,
    pageSize,
    initialFilters,
    honestSourceEnabled
  );

  // ── The narrowing the REQUEST carries ─────────────────────────────────────
  // `filters.search` changes on every KEYSTROKE. In the legacy branch that is
  // free — the narrowing runs in memory over rows already fetched — but in the
  // bounded branch each distinct search value is a different query key and so a
  // different read, and every one of those reaches `getPageDataForOrg`, which
  // rebuilds up to three inventory-cap populations. Typing one word would issue
  // one database-heavy read per character.
  //
  // Settling the term collapses that to a bounded number of reads: the first
  // change applies on the leading edge (so the list reacts at once) and every
  // change after it lands only once the box has held still. Only `search` is
  // settled — the facet arrays change on a discrete click, where the same delay
  // would read as lag — and only while the bounded branch is active, since
  // `useSettledValue` returns the value verbatim at `0` and leaves the in-memory
  // path byte-identical to what it was.
  const settledSearch = useSettledValue(
    filters.search,
    boundedPageDataActive ? AGENT_INVENTORY_SEARCH_SETTLE_MS : 0
  );
  // `filters` verbatim once the term has caught up, so the settled object is not
  // a fresh identity on every render for the memo below to churn on.
  const requestFilters = useMemo(
    () =>
      filters.search === settledSearch
        ? filters
        : { ...filters, search: settledSearch },
    [filters, settledSearch]
  );

  // ── Bounded page-data read ────────────────────────────────────────────────
  // The producer clamps the page it was asked for, but the REQUEST still has to
  // reset on a filter change or a narrowing would ask for page 7 of a two-page
  // result on every keystroke. Mirrors `usePaginatedFilterState`'s render-time
  // filter-identity check rather than an effect, so the reset lands in the same
  // render as the filter change instead of one paint later. Tracked against the
  // LIVE filters, not the settled ones, so the pager resets as the user types
  // rather than a settle later.
  const [requestedPage, setRequestedPage] = useState(0);
  const prevFiltersRef = useRef(filters);
  if (prevFiltersRef.current !== filters) {
    prevFiltersRef.current = filters;
    if (requestedPage !== 0) {
      setRequestedPage(0);
    }
  }

  const pageDataRequest = useMemo(
    () => ({
      filters: requestFilters,
      sortBy: sortKey,
      sortDir,
      page: requestedPage,
      pageSize,
      honestSource: honestSourceEnabled,
      dedupePluginRollups,
      // Omission is the contract on both bounds: no `startDate` is the all-time
      // view, and no prior pair means "no baseline" rather than an empty one.
      ...(startDate ? { startDate } : {}),
      ...(precedingRange ?? {}),
      // ISS-6888: the bounded branch's half of the same capability decision the
      // legacy branch makes at `facetUniverseEnabled` below. The producer cannot
      // infer this from `startDate` — that bound narrows the ROWS and is sent on
      // every windowed read, including from a source that ignores it — so the
      // reader states it, exactly as it states the prior window by sending both
      // bounds. Without it, the unwindowed universe reached a flag-OFF desktop.
      unwindowedFacetUniverse: supportsDateWindow,
    }),
    [
      requestFilters,
      sortKey,
      sortDir,
      requestedPage,
      pageSize,
      honestSourceEnabled,
      dedupePluginRollups,
      startDate,
      precedingRange,
      supportsDateWindow,
    ]
  );

  const {
    data: pageData,
    isLoading: pageDataLoading,
    isError: pageDataError,
  } = useGatedPageData(pageDataRequest, boundedPageDataActive, isViewReady);

  // ── Legacy derivations ────────────────────────────────────────────────────
  // Computed unconditionally (hooks cannot be conditional) but cheap in the
  // bounded branch, where `filteredRows` and `facetUniverseRows` are both empty.
  const legacyFacets = useMemo(
    () =>
      countFacetValues(
        filteredRows,
        facetUniverseRows,
        filters,
        harnessCountRowsFor(
          filteredRows,
          sortedRows,
          filters,
          honestSourceEnabled
        ),
        honestSourceEnabled
      ),
    [filteredRows, facetUniverseRows, sortedRows, filters, honestSourceEnabled]
  );

  const legacySummary = useMemo(
    () =>
      computeSummaryAggregatePair(
        filteredRows,
        previousRows === undefined
          ? undefined
          : filterAgentComponentRows(
              previousRows,
              filters,
              honestSourceEnabled
            ),
        dedupePluginRollups
      ),
    [
      filteredRows,
      previousRows,
      filters,
      honestSourceEnabled,
      dedupePluginRollups,
    ]
  );

  if (!boundedPageDataActive) {
    return {
      filters,
      handleFiltersChange,
      page: legacyPage,
      setPage: setLegacyPage,
      totalPages: legacyTotalPages,
      pageRows: pagedRows,
      facets: legacyFacets,
      summary: legacySummary,
      isLoading: legacyLoading,
      isError: legacyError,
    };
  }

  return {
    filters,
    handleFiltersChange,
    // Before the first response there is nothing to clamp against, so the
    // requested page stands in. The producer's clamped page wins as soon as it
    // arrives, which is what keeps the pager from pointing at a page the result
    // does not contain.
    page: pageData?.page ?? requestedPage,
    setPage: setRequestedPage,
    totalPages: pageData?.totalPages ?? 1,
    pageRows: pageData?.items ?? EMPTY_ROWS,
    facets: pageData?.facets ?? EMPTY_FACETS,
    summary: {
      current: pageData
        ? deserializeSummaryAggregate(pageData.current)
        : EMPTY_SUMMARY,
      previous: pageData?.previous
        ? deserializeSummaryAggregate(pageData.previous)
        : undefined,
    },
    isLoading: pageDataLoading,
    isError: pageDataError,
  };
}

/**
 * FEA-4336: the corpus the HARNESS option counts are taken from — every active
 * facet applied EXCEPT harness. Counting harness options off the already-
 * harness-narrowed rows zeroes out every un-checked harness, even though
 * checking one adds its rows back through the union predicate. With no harness
 * selected the two sets are identical, so the extra pass only runs while a
 * harness is active.
 */
function harnessCountRowsFor(
  filteredRows: AgentComponent[],
  sortedRows: AgentComponent[],
  filters: AgentComponentFilters,
  honestSourceEnabled: boolean
): AgentComponent[] {
  if (filters.harnesses.length === 0) {
    return filteredRows;
  }
  return filterAgentComponentRows(
    sortedRows,
    { ...filters, harnesses: [] },
    honestSourceEnabled
  );
}

/**
 * How long the search box must hold still before its term reaches a bounded
 * read.
 *
 * Long enough that an ordinary typing cadence lands as one settled term rather
 * than one read per character, short enough that a user who stops typing does
 * not notice waiting. Exported so the regression test asserts against the value
 * the hook actually uses instead of restating the number.
 *
 * Applies ONLY to the bounded branch — see the call site. The legacy branch
 * filters in memory over rows it already holds, where a delay would buy nothing
 * and cost responsiveness.
 */
export const AGENT_INVENTORY_SEARCH_SETTLE_MS = 250;

/**
 * Stable empty literals. A fresh `[]` on every render would change the identity
 * of every memo input downstream and re-run the whole reduction each paint.
 */
const EMPTY_ROWS: AgentComponent[] = [];
const EMPTY_FACETS: AgentComponentFacetCounts = {
  collaborators: [],
  sources: [],
  harnesses: [],
};

/**
 * What the summary cards read while the first bounded response is in flight.
 *
 * Every field is the honest empty value for an EMPTY population, which is what
 * the legacy branch also reduces to before its first response — the cards are
 * behind the list's own loading state either way. `locPerDollar: null`
 * (never `0`) and `hasVerifiableLocPerDollar: false` matter: they make the LOC/$
 * card render its unavailable state, not a fabricated `0.0`.
 */
const EMPTY_SUMMARY: SummaryAggregate = {
  components: 0,
  invocations: 0,
  locPerDollar: null,
  locPerDollarSampleSize: 0,
  collaborators: 0,
  hasVerifiableLocPerDollar: false,
  invocationsExact: true,
  invocationsPluginCoverage: new Map(),
};

/**
 * {@link AgentsInventoryViewParams} minus the three gates, for a caller that
 * must not hold them.
 */
export type AgentsInventoryGatedViewParams = Omit<
  AgentsInventoryViewParams,
  "boundedPageDataEnabled" | "dedupePluginRollups" | "honestSourceEnabled"
>;

export type AgentsInventoryGatedView = AgentsInventoryView & {
  /**
   * Whether the Invocations aggregate was reduced with a plugin's child rollup
   * counted once instead of added to the child rows it came from.
   *
   * A statement about the reduction that RAN, not about a flag: the explainer
   * copy beside the count has to describe the arithmetic the reader is looking
   * at, and reading the gate a second time to answer that is how one module
   * comes to hold two answers to one question.
   */
  invocationsDedupeApplied: boolean;
};

/**
 * {@link useAgentsInventoryView} with its three gates resolved HERE.
 *
 * `AgentsListSurfaceV2` reads none of them. The gates decide how this read is
 * shaped and what it reduces, so they belong to the module that performs it —
 * `AGENTS.md` -> Code Style, "One read site per feature flag", whose remedy for
 * a boolean about to cross a module boundary is that the receiving module reads
 * it itself. `AgentsGroupedList` still passes its own reads to the ungated hook
 * above; that pre-existing threading is allowlisted debt (ISS-8339) and this
 * entry point exists so the v2 surface does not add more of it.
 *
 * `…Optional` because the surface also mounts with no `FeatureFlagAdapterProvider`
 * (a story, a mini-table test), where every gate resolves `false` — the read
 * that ships today.
 */
export function useAgentsInventoryViewGated(
  params: AgentsInventoryGatedViewParams
): AgentsInventoryGatedView {
  const honestSourceEnabled = useFeatureFlagEnabledOptional(
    AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY
  );
  const dedupePluginRollups = useFeatureFlagEnabledOptional(
    AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY
  );
  const boundedPageDataEnabled = useFeatureFlagEnabledOptional(
    AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY
  );

  const view = useAgentsInventoryView({
    ...params,
    boundedPageDataEnabled,
    dedupePluginRollups,
    honestSourceEnabled,
  });

  return { ...view, invocationsDedupeApplied: dedupePluginRollups };
}

/**
 * The bounded page-data read, held closed until the persisted view has settled
 * (ISS-6141 / ISS-4655).
 *
 * `enabled: false` stops the FETCH but leaves the observer attached, so a
 * revisit whose DEFAULT-view key is still cached reports `success` and hands
 * back the page the previous visit left there — under a view the user is about
 * to leave. `gateRestoredRead` zeroes that at the one point every consumer
 * routes through, covering rows, facets, summary and the page clamp together.
 *
 * Two details are deliberate. The helper is fed the query's `isLoading`, not its
 * `isPending` — a query disabled indefinitely is `pending` forever, which would
 * make a closed gate indistinguishable from a read in flight. And the ERROR is
 * gated too: `AgentsListSurfaceV2` checks error before loading, so an ungated
 * one renders the Error state over a cached failure belonging to a read this
 * mount is not making.
 */
function useGatedPageData(
  request: AgentComponentPageDataRequest,
  boundedPageDataActive: boolean,
  isViewReady: boolean
): {
  data: AgentComponentPageDataResult | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useAgentComponentsPageData(request, {
    enabled: boundedPageDataActive && isViewReady,
  });
  const gated = gateRestoredRead(isViewReady, {
    data: query.data,
    isPending: query.isLoading,
  });
  return {
    data: gated.data,
    isLoading: gated.isPending,
    isError: isViewReady && query.isError,
  };
}
