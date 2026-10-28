import "server-only";

import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponent,
  type AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentSortDir,
  type AgentComponentSortKey,
  type Harness,
} from "@repo/api/src/types/agent-component";
import {
  type AgentComponentPageDataResult,
  reduceAgentComponentPageData,
} from "@repo/api/src/utils/agent-component-page-data";
import { collectComponentPopulation } from "@repo/api/src/utils/agent-component-population";
import type { AgentComponentFilters } from "@repo/api/src/utils/agent-component-reduce";
import type { LocPerDollarFold } from "@repo/api/src/utils/agent-component-summary-aggregate";
import { log } from "@repo/observability/log";
import { agentComponentsService } from "../service";
import type { AgentComponentListQuery } from "../validators";
import type { AgentComponentPageDataQueryParams } from "./validators";

/**
 * ISS-6822 — serve the Agents inventory page, its facet menu, and both summary
 * windows from ONE request.
 *
 * The workspace previously issued three `GET /agent-components?limit=5000` calls
 * — current window, unwindowed facet universe, preceding window — and reduced up
 * to 15,000 rows in the browser to render ~50. This service performs the same
 * three population reads (`listForOrg`, unchanged, with the identical arguments
 * the client used to send) and then applies the SHARED reduction here, returning
 * only the page plus compact facet and aggregate results.
 *
 * What this does NOT change, deliberately:
 *
 *  - The POPULATIONS. Each window is still built by `buildOrgComponentPopulation`
 *    through `listForOrg` with no server-side facet narrowing, exactly as the
 *    three client calls did. The `dropZeroWindowUsage` window drop, the plugin
 *    child-usage rollup, and the family collapse all apply identically.
 *    ISS-6891: what DID change is that a corpus larger than one page is now read
 *    to completion (see `readPopulation`) instead of being silently cut at the
 *    first page — the reduction here computes facet counts and summary
 *    aggregates, and neither is a count if it is taken over a prefix.
 *  - The database work. The window is applied inside the population read, so the
 *    three windows are still three population builds, exactly as the three prior
 *    HTTP requests produced. What this endpoint removes is the wire and renderer
 *    cost, not the query cost — do not read it as a query-count reduction.
 *
 *    Reading the window-independent inventory ONCE for all three is not
 *    available in this call shape, because each `listForOrg` opens its own
 *    `RepeatableRead` snapshot and ISS-6180 requires the inventory read to sit
 *    INSIDE the snapshot whose usage lanes it partitions (it supplies the
 *    `uninstalledAt` predicate separating the FK lane from the usage-only one;
 *    on a second snapshot a concurrent tombstone/restore double-counts or drops
 *    a component). That invariant does NOT forbid the optimisation outright — a
 *    single outer transaction reading the inventory once and running all three
 *    windows' usage lanes inside it would satisfy it — it forbids doing it by
 *    hoisting the read out. Restructuring `buildOrgComponentPopulation` that far
 *    is deliberately out of scope here, where the acceptance is that the numbers
 *    do not move.
 *
 *  The three reads run CONCURRENTLY. Sequentially they would make one request's
 *  budget the SUM of up to three snapshot transactions, where the three separate
 *  requests each had their own; concurrently the wall-clock is the slowest of
 *  the three, as before. Each opens its own transaction and its own pooled
 *  connection, so they neither share nor interfere with one another's snapshot.
 */
export const agentComponentPageDataService = {
  async getPageDataForOrg(
    organizationId: string,
    params: AgentComponentPageDataQueryParams
  ): Promise<AgentComponentPageDataResult> {
    const [current, unwindowed, previous] = await Promise.all([
      readPopulationWithFold(organizationId, {
        startDate: params.startDate,
      }),
      // FEA-3202: the facet option UNIVERSE is the UNWINDOWED inventory, so an
      // owner/source whose components have no in-window usage stays listed as a
      // zero-count option instead of disappearing from the menu as the window
      // narrows. With no window selected the current population IS unwindowed,
      // so this read is skipped — the same condition under which the client
      // skipped its second request.
      //
      // ISS-6888 made the ask EXPLICIT rather than inferred from `startDate`
      // alone, because a bounded window says nothing about whether the caller's
      // source honors it well enough for a wider read to differ. It defaults
      // OPEN here (see the validator), so this endpoint's behavior is unchanged
      // for every existing caller and for one that predates the field.
      params.startDate && params.unwindowedFacetUniverse
        ? readPopulation(organizationId, {})
        : undefined,
      // FEA-3178: the preceding equivalent window, bounded ABOVE by `prevEnd` so
      // it cannot overlap the current one. Absent ⇒ no baseline is read and the
      // result carries no `previous`, which the cards render as "no delta"
      // rather than as a zero baseline.
      params.prevStart && params.prevEnd
        ? readPopulationWithFold(organizationId, {
            endDate: params.prevEnd,
            startDate: params.prevStart,
          })
        : undefined,
    ]);
    const universe = unwindowed ?? current.items;

    return reduceAgentComponentPageData(
      {
        current: current.items,
        universe,
        // Preserve omission rather than passing `previous: undefined`, so the
        // populations object states "no prior window" the same way the wire
        // contract does.
        ...(previous ? { previous: previous.items } : {}),
      },
      {
        filters: toFilters(params),
        sortBy: params.sortBy as AgentComponentSortKey,
        sortDir: params.sortDir as AgentComponentSortDir,
        page: params.page,
        pageSize: params.pageSize,
        honestSource: params.honestSource,
        dedupePluginRollups: params.dedupePluginRollups,
      },
      {
        current: current.foldLocPerDollar,
        ...(previous ? { previous: previous.foldLocPerDollar } : {}),
      }
    );
  },
};

/**
 * ISS-6409: one COMPLETE population AND the LOC/$ fold over ITS OWN sessions.
 *
 * Both compared windows are read this way, because a fold closes over the
 * session maps of the population it was built from: reusing the current
 * window's closure for the preceding one would re-fold the current window's
 * sessions and report the delta against itself (#6417 review). Only the
 * universe — which no card folds — is read without a fold.
 *
 * ISS-6891: this read pages like {@link readPopulation}, and for the same
 * reason. A fold is an AGGREGATE over the population, so a fold taken over the
 * first page is the summary card's half of the truncation this ticket removes —
 * and it is the half that leaves no trace, because the card renders an exact
 * number either way. The fold kept is the one returned by the read whose items
 * are kept, so the closure and the rows describe the same snapshot.
 */
function readPopulationWithFold(
  organizationId: string,
  window: { startDate?: string; endDate?: string }
): Promise<{ items: AgentComponent[]; foldLocPerDollar: LocPerDollarFold }> {
  let foldLocPerDollar: LocPerDollarFold | undefined;
  return collectComponentPopulation(
    (page) =>
      agentComponentsService
        .listForOrgWithLocPerDollarFold(
          organizationId,
          populationQuery(window, page)
        )
        .then((response) => {
          foldLocPerDollar = response.foldLocPerDollar;
          return response;
        }),
    POPULATION_BOUNDS
  ).then((population) => {
    const items = requireCompletePopulation(organizationId, population);
    if (!foldLocPerDollar) {
      // The follower always reads at least one page, so this cannot be reached
      // from a completed read; it exists so the fold is never `undefined` at the
      // type level, and it FAILS rather than substituting a fold over nothing —
      // which would render an exact-looking "—" for a population that was read.
      throw new Error(`${PARTIAL_POPULATION_LOG_EVENT}: no page was read`);
    }
    // The follower discards the prefix when it widens, so the last read is the
    // one that produced the retained items.
    return { foldLocPerDollar, items };
  });
}

/**
 * One COMPLETE inventory population for the requested usage window, with no
 * server-side facet narrowing (the facets are applied by the shared reduction so
 * the facet COUNTS describe the same population the rows come from).
 *
 * ISS-6891: `listForOrg` is a PAGINATED read, so taking its first page and
 * treating the array as the population is the silent truncation this ticket
 * exists to remove — an org past one page would have had its facet menu, its
 * summary cards, and its row count all computed from a prefix. The shared
 * `collectComponentPopulation` follows the pages, and it is shared with the
 * desktop mirror and the web workspace so the three cannot disagree about what
 * "complete" means.
 */
function readPopulation(
  organizationId: string,
  window: { startDate?: string; endDate?: string }
): Promise<AgentComponent[]> {
  return collectComponentPopulation(
    (page) =>
      agentComponentsService.listForOrg(
        organizationId,
        populationQuery(window, page)
      ),
    POPULATION_BOUNDS
  ).then((population) => requireCompletePopulation(organizationId, population));
}

/** The one query shape every population read uses, so they cannot diverge. */
function populationQuery(
  window: { startDate?: string; endDate?: string },
  page: { limit: number; offset: number }
): AgentComponentListQuery {
  return {
    kinds: undefined,
    source: undefined,
    harness: undefined,
    search: undefined,
    sortBy: undefined,
    sortDir: undefined,
    ...page,
    ...(window.startDate ? { startDate: window.startDate } : {}),
    ...(window.endDate ? { endDate: window.endDate } : {}),
  };
}

/**
 * The rows of a population read that reached its own reported `total`, or a
 * throw.
 *
 * ISS-6891: the follower reports `hasMore` when it could NOT exhaust the
 * population — a read that stopped short of its own `total`. Every value this
 * endpoint returns is reduced over what came back (facet counts, both summary
 * aggregates, `filteredTotal`), so taking `.items` regardless would put it right
 * back where the ticket found it: a partial population served as the org, in
 * numbers that carry no sign of it.
 *
 * #6483 (whitlockk, chatgpt-codex-connector): logging that and reducing anyway
 * discarded the very signal it had just established. A count over a prefix is
 * not a count, and there is no honest value to substitute for one, so the read
 * FAILS rather than answering with exact-looking numbers it knows are short. The
 * log stays — it is the monitored event that says which org and by how much —
 * and the throw is what keeps the wrong number off the screen.
 */
function requireCompletePopulation(
  organizationId: string,
  population: AgentComponentListResponse
): AgentComponent[] {
  if (population.hasMore) {
    log.error(PARTIAL_POPULATION_LOG_EVENT, {
      organizationId,
      readCount: population.items.length,
      reportedTotal: population.total,
    });
    throw new Error(
      `${PARTIAL_POPULATION_LOG_EVENT}: read ${population.items.length} of a reported ${population.total}`
    );
  }
  return population.items;
}

/**
 * #6483 (davetho): `listForOrg` is an IN-PROCESS call here, not the HTTP
 * route, so the wire `limit` ceiling does not apply and the whole remainder can
 * be asked for in ONE call. That matters because the read rebuilds the entire
 * org population before slicing: walking the pages made each window
 * O(page_count x population), against up to three windows started concurrently.
 * Two builds per window, whatever the org's size.
 */
const POPULATION_BOUNDS = {
  pageSize: AGENT_COMPONENT_INVENTORY_CAP,
  maxPageSize: Number.POSITIVE_INFINITY,
};

/**
 * The monitored event — and the thrown message — for a population read that
 * could not be exhausted. One constant so the alert key and the failure a caller
 * sees name the same condition.
 */
const PARTIAL_POPULATION_LOG_EVENT =
  "agent_components_page_data_partial_population";

/** The validated facet params as the shared reduction's filter shape. */
function toFilters(
  params: AgentComponentPageDataQueryParams
): AgentComponentFilters {
  return {
    kinds: params.kinds as AgentComponentKind[],
    collaborators: params.collaborators,
    sources: params.sources,
    harnesses: params.harnesses as Harness[],
    search: params.search,
  };
}
