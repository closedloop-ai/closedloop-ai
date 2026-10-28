/**
 * ISS-6822 — the Agents inventory PAGE-DATA contract and its one reduction.
 *
 * The Agents list needs five things from a population it never shows in full:
 * the current page of rows, how many rows the narrowing matched, the summary
 * aggregates for the current and preceding windows, and the facet menu's option
 * universe with counts. Deriving those in the browser meant fetching the whole
 * population — up to three times, at up to 5,000 rows each — to render ~25 rows.
 *
 * {@link reduceAgentComponentPageData} is that derivation, expressed once. It is
 * pure and framework-free, so the API service, the desktop main process, and the
 * browser can all run it. The wire contract below is what a producer returns
 * INSTEAD of the population.
 *
 * Exactness is structural, not asserted: this function calls the same
 * `sortAgentComponentRows` / `filterAgentComponentRows` / `countFacetValues` /
 * `computeSummaryAggregatePair` the client pipeline calls, in the same order,
 * and mirrors `usePaginatedFilterState`'s clamp. Given the same three
 * populations it cannot disagree with the client pipeline, because there is no
 * second implementation.
 */

import type {
  AgentComponent,
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "../types/agent-component.ts";
import {
  type AgentComponentFacetCounts,
  type AgentComponentFilters,
  countFacetValues,
  filterAgentComponentRows,
  sortAgentComponentRows,
} from "./agent-component-reduce.ts";
import {
  computeSummaryAggregatePair,
  type LocPerDollarFoldPair,
  type PluginRollupCoverage,
  type SummaryAggregate,
} from "./agent-component-summary-aggregate.ts";
import { resolveTotalPages } from "./math.ts";

/**
 * What the reader asks a page-data producer for: the same narrowing, ordering,
 * paging, and presentation gates the client pipeline would have applied itself.
 *
 * `honestSource` and `dedupePluginRollups` are the two closed-by-default UI
 * gates that change the NUMBERS (ISS-5009 and ISS-5534), so they travel with the
 * request rather than being guessed server-side. A producer that ignored them
 * would return a facet menu and an Invocations total from the other branch of
 * the flag — the exact "option with a positive count that selects zero rows"
 * failure ISS-5009 documents.
 */
export type AgentComponentPageDataQuery = {
  /** The active facet/search/kind narrowing. */
  filters: AgentComponentFilters;
  sortBy: AgentComponentSortKey;
  sortDir: AgentComponentSortDir;
  /** Zero-based requested page; clamped to the available range by the reduction. */
  page: number;
  pageSize: number;
  /** ISS-5009 Source-provenance gate. */
  honestSource: boolean;
  /** ISS-5534 Invocations plugin-rollup de-duplication gate. */
  dedupePluginRollups: boolean;
};

/**
 * How many inventory rows one page carries by default.
 *
 * Owned here rather than in the surface, because three places now have to agree
 * on it — the workspace's own page size, the API route's default, and the
 * desktop main process's fallback for an unparseable request — and a
 * disagreement between them is not a cosmetic drift: the fallback deciding on a
 * larger number is how a "bounded" read quietly stops being bounded.
 */
export const AGENT_COMPONENT_PAGE_SIZE = 50;

/**
 * ISS-9073: ceiling on the DISTINCT values one page-data facet accepts. The
 * narrowing is in memory over the whole org population (`filterAgentComponentRows`
 * runs `row.collaborators.some((c) => filters.collaborators.includes(c))` per
 * row), so an open-valued facet like `collaborators` or `sources` is O(rows × N)
 * with no bind budget to refuse it. The enum facets are already bounded by their
 * cardinality once de-duplicated. Owned beside the page-size bound as part of
 * the page-data request contract, and read by BOTH producers: the HTTP
 * validator and the desktop main process's local page-data schema. One filter
 * selection drives both, so a bound on only one of them would answer the same
 * selection 200 in local mode and 400 in cloud.
 */
export const AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES = 100;

/**
 * The usage windows a page-data producer must read, as ISO bounds.
 *
 * Every field is optional and every absence is meaningful, so none of them is
 * ever serialized as `null`: no `startDate` is the all-time view, and no
 * `prevStart`/`prevEnd` pair means "there is no prior period", which the summary
 * cards render as no delta chip rather than as a zero baseline.
 */
export type AgentComponentPageDataWindow = {
  startDate?: string;
  prevStart?: string;
  prevEnd?: string;
  /**
   * ISS-6888: whether the caller wants the facet options drawn from the
   * UNWINDOWED inventory (FEA-3202) rather than from the windowed population the
   * rows come from.
   *
   * STATED, not inferred. A producer cannot derive this from `startDate`, because
   * a bounded window is the caller's narrowing of the ROWS and says nothing about
   * whether the caller's source honors that window well enough for a wider read
   * to mean anything — a source that ignores the bounds answers the "unwindowed"
   * read with the windowed rows, so the second population build buys an identical
   * result. The caller already states the prior window by sending both bounds;
   * this is the same contract for the other window-relative read.
   *
   * OPTIONAL, and each producer defaults an omission to ITS OWN prior behavior,
   * because "absent" only ever means "a reader that predates this field": the
   * cloud service read the unwindowed universe whenever `startDate` was present
   * and keeps doing so, while the desktop reader never read one and keeps not.
   * That way a version-skewed reader on either side sees exactly the surface it
   * saw before the field existed.
   */
  unwindowedFacetUniverse?: boolean;
};

/**
 * The full page-data ask a reader hands its data source: the narrowing, the
 * ordering, the page, the presentation gates, and the windows to read.
 */
export type AgentComponentPageDataRequest = AgentComponentPageDataQuery &
  AgentComponentPageDataWindow;

/**
 * The three populations a page-data producer reduces.
 *
 * They are distinct populations, NOT one population filtered three ways, which
 * is why the reduction takes all three rather than deriving two of them:
 *
 *  - `current` — the selected window (`startDate`), the rows the page shows.
 *  - `universe` — the UNWINDOWED inventory (FEA-3202). Supplies the facet option
 *    universe so an Owner/Source that has no in-window usage stays listed as a
 *    zero-count option instead of vanishing from the menu.
 *  - `previous` — the PRECEDING equivalent window (FEA-3178), or `undefined` when
 *    there is no finite prior period ("All") or the source does not honor a date
 *    window. Absent means "render no delta", never "a zero baseline".
 */
export type AgentComponentPopulations = {
  current: AgentComponent[];
  universe: AgentComponent[];
  previous?: AgentComponent[];
};

/**
 * A {@link SummaryAggregate} in a form that survives JSON and Electron
 * structured-clone.
 *
 * `invocationsPluginCoverage` is a `ReadonlyMap` in memory — it must be, because
 * `isInvocationsComparable` looks plugins up by slug — and a `Map` JSON-encodes
 * to `{}`, which would silently turn every per-plugin coverage answer into "no
 * answer" and make a mismatched window pair compare as if it matched. Carried as
 * entry pairs on the wire and rehydrated on read.
 */
export type SerializedSummaryAggregate = Omit<
  SummaryAggregate,
  "invocationsPluginCoverage"
> & {
  invocationsPluginCoverage: [string, PluginRollupCoverage][];
  /**
   * ISS-6409: EMIT-ONLY compatibility key for readers that predate the
   * `avgLocPerDollar` -> `locPerDollar` rename.
   *
   * An installed Desktop build reads this same cloud response
   * (`createHttpAgentComponentsDataSource` in cloud mode) and the repo does not
   * assume peers upgrade in step, so the old key is emitted alongside the new
   * one rather than renamed out from under them.
   *
   * It is NOT a symmetric alias, and this is the important part: the rename
   * changed the ESTIMAND, not just the spelling. A producer predating it put
   * the unweighted mean of the rows' ratios here; this one puts the ratio of
   * sums. So the value is emitted (an old reader keeps a number, now a correct
   * one, under its old "avg across N" caption) and never read back
   * (see `deserializeSummaryAggregate`). Removal needs explicit human approval
   * per the Compatibility Guardrail.
   *
   * @deprecated Read `locPerDollar`.
   */
  avgLocPerDollar?: number | null;
};

/**
 * The bounded result the Agents list renders from.
 *
 * Everything here is either capped by `pageSize` or by the size of the facet
 * VALUE universe (distinct owners/sources/harnesses) — never by the inventory
 * population. That bound is the point of the ticket.
 */
export type AgentComponentPageDataResult = {
  /** The requested page of already-sorted, already-filtered rows. */
  items: AgentComponent[];
  /** How many rows the narrowing matched, across all pages. */
  filteredTotal: number;
  totalPages: number;
  /** The requested page after clamping — what the pager must render as active. */
  page: number;
  facets: AgentComponentFacetCounts;
  current: SerializedSummaryAggregate;
  /**
   * The preceding window's aggregate. OMITTED (never `null`) when no prior
   * window was reduced, mirroring the client contract where `undefined` means
   * "render no delta chip" rather than "a baseline of zero".
   */
  previous?: SerializedSummaryAggregate;
};

/**
 * Reduce the three populations to the bounded page-data result.
 *
 * Order matters and matches `agents-grouped-list.tsx` exactly: SORT the current
 * window first, then filter (order-preserving), then page. Filtering before
 * sorting would produce the same set but a different page-to-row assignment for
 * any comparator with ties.
 */
export function reduceAgentComponentPageData(
  populations: AgentComponentPopulations,
  query: AgentComponentPageDataQuery,
  folds?: LocPerDollarFoldPair
): AgentComponentPageDataResult {
  const { filters, honestSource, dedupePluginRollups } = query;
  const sortedRows = sortAgentComponentRows(
    populations.current,
    query.sortBy,
    query.sortDir
  );
  const filteredRows = filterAgentComponentRows(
    sortedRows,
    filters,
    honestSource
  );

  // Mirrors `usePaginatedFilterState`: at least one page even when empty, and a
  // requested page beyond the end is CLAMPED to the last valid one rather than
  // returning an empty slice. A producer that returned the empty slice instead
  // would strand a viewer whose corpus shrank under them (FEA-2540).
  const pageSize = Math.max(1, query.pageSize);
  const filteredTotal = filteredRows.length;
  const totalPages = resolveTotalPages(filteredTotal, pageSize);
  const page = Math.min(Math.max(0, query.page), totalPages - 1);
  const items = filteredRows.slice(page * pageSize, (page + 1) * pageSize);

  // FEA-4336: the harness option counts come from the corpus filtered by every
  // OTHER active facet with the harness filter CLEARED, so checking one harness
  // does not zero out the others' union preview. Identical to the call the
  // filter adapter makes, including the "no harness selected ⇒ reuse `rows`"
  // shortcut, so the extra pass only runs while a harness is active.
  const harnessCountRows =
    filters.harnesses.length === 0
      ? filteredRows
      : filterAgentComponentRows(
          sortedRows,
          { ...filters, harnesses: [] },
          honestSource
        );

  const facets = countFacetValues(
    filteredRows,
    populations.universe,
    filters,
    harnessCountRows,
    honestSource
  );

  // FEA-3178: the preceding window is narrowed by the SAME facet filters as the
  // current one, so the delta compares like-for-like. Sorting is irrelevant to an
  // aggregate, so only the filter is applied — exactly as the client does.
  const previousFilteredRows = populations.previous
    ? filterAgentComponentRows(populations.previous, filters, honestSource)
    : undefined;

  // ISS-6409: the fold runs on the FILTERED populations below, so the LOC/$ the
  // card shows is folded over exactly the sessions behind the rows it sits
  // above — not the whole inventory.
  const { current, previous } = computeSummaryAggregatePair(
    filteredRows,
    previousFilteredRows,
    dedupePluginRollups,
    folds
  );

  return {
    items,
    filteredTotal,
    totalPages,
    page,
    facets,
    current: serializeSummaryAggregate(current),
    // Preserve OMISSION: an absent prior window must not become `previous: null`
    // on the wire, because a consumer that probes with `in` would then read
    // "there is a baseline" where there is none.
    ...(previous ? { previous: serializeSummaryAggregate(previous) } : {}),
  };
}

/** Flatten the per-plugin coverage map for transport. */
export function serializeSummaryAggregate(
  aggregate: SummaryAggregate
): SerializedSummaryAggregate {
  const { invocationsPluginCoverage, ...rest } = aggregate;
  return {
    ...rest,
    // Dual-emit for the skew window; see the alias's docstring.
    avgLocPerDollar: aggregate.locPerDollar,
    invocationsPluginCoverage: [...invocationsPluginCoverage.entries()],
  };
}

/**
 * Rebuild the in-memory aggregate a reader's card code expects.
 *
 * `isInvocationsComparable` reads the coverage by slug, so the map must come
 * back as a map; leaving it as pairs would make every lookup miss and report two
 * differently-counted windows as comparable.
 */
export function deserializeSummaryAggregate(
  aggregate: SerializedSummaryAggregate
): SummaryAggregate {
  // ISS-6409 (#6417 review): `avgLocPerDollar` is dropped, NOT read back. The
  // legacy key is not an old name for this value — a producer predating this
  // change computed the unweighted MEAN of the rows' ratios, the estimand this
  // issue exists to remove (it read ~1,070 where the rate was ~30). Reading it
  // would restore that number under copy promising a ratio of totals. An
  // absent canonical value is `undefined`, which the card renders as
  // unavailable — the same treatment the flag-off path already chose for the
  // identical number.
  const {
    invocationsPluginCoverage,
    avgLocPerDollar: _legacy,
    ...rest
  } = aggregate;
  return {
    ...rest,
    invocationsPluginCoverage: new Map(invocationsPluginCoverage),
  };
}

/**
 * Is one usage bound a date a producer can actually narrow on?
 *
 * Permissive by design, and identical on both producers: any `Date.parse`-able
 * string, so the bare calendar date the range control can emit (`2026-07-14`)
 * is accepted alongside a full ISO timestamp.
 *
 * Owned here, beside {@link AgentComponentPageDataWindow}, because BOTH
 * validators of that contract have to agree: the HTTP query validator
 * (`apps/api/app/agent-components/page-data/validators.ts`) and the desktop's
 * IPC schema (`agent-components-page-data-local.ts`). They disagreed once —
 * the IPC side checked only the TYPE — and the two rules below say why that
 * gap is not cosmetic.
 */
export function isUsableUsageBound(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Rejection message for a bound {@link isUsableUsageBound} refuses. A producer
 * that cannot parse a bound must not fall back to an unbounded read: the
 * narrowing would silently widen to a population the caller never asked for,
 * while the control that requested it still shows the window on screen.
 */
export const USAGE_BOUND_INVALID_MESSAGE = "Invalid date";

/**
 * Does a request carry a prior window a producer can read — both bounds, or
 * neither?
 *
 * A half-specified pair is the failure this predicate exists for, and it is not
 * a type error, so a type-only check cannot see it. `prevEnd` alone leaves the
 * baseline unbounded BELOW (every component the org has ever had); `prevStart`
 * alone overlaps the current window. Either way the delta chip reports a
 * population difference as a usage change — a plausible, wrong number with no
 * error anywhere.
 *
 * Note that a bound present but UNPARSABLE reduces to exactly this case one
 * layer down, which is why the two rules ship together: a producer that drops
 * an unusable bound and keeps its partner has silently built the half-specified
 * window this rejects. Validate both, at every boundary that accepts a window.
 */
export function hasCompletePriorWindow(
  window: Readonly<Pick<AgentComponentPageDataWindow, "prevStart" | "prevEnd">>
): boolean {
  return (window.prevStart === undefined) === (window.prevEnd === undefined);
}

/** Rejection message for a prior window {@link hasCompletePriorWindow} refuses. */
export const PRIOR_WINDOW_INCOMPLETE_MESSAGE =
  "prevStart and prevEnd must be supplied together (a prior window needs both bounds)";
