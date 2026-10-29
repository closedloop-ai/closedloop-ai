"use client";

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_PAGE_SIZE } from "@repo/api/src/utils/agent-component-page-data";
import type { AgentComponentFilters } from "@repo/api/src/utils/agent-component-reduce";
import {
  DEFAULT_AGENT_COMPONENT_FILTERS,
  filterAgentComponentRows,
} from "@repo/api/src/utils/agent-component-reduce";
import { useCallback } from "react";
import { usePaginatedFilterState } from "../../shared/hooks/use-paginated-filter-state";

/**
 * ISS-6822: the filter SHAPE and its membership predicate moved to
 * `@repo/api/src/utils/agent-component-reduce` so the server can apply exactly
 * the same narrowing and return a bounded page. Import them from there
 * directly — this module deliberately does not re-export them (a file of
 * pass-throughs is a barrel). Only the React state machine below is client-side.
 *
 * The `pageSize` default reads the canonical `AGENT_COMPONENT_PAGE_SIZE` for the
 * same reason. It previously defaulted to a 25 declared here, which shared the
 * canonical constant's NAME while disagreeing with its value — every real caller
 * passes `pageSize` explicitly, so the 25 never reached a pager, but a reader
 * comparing the two names had no way to tell which page size was in force.
 */

/**
 * Owns the filter + pagination state for the Agents workspace table, shared by
 * the web `/[orgSlug]/agents` page and the desktop Agents view so both surfaces
 * stay in sync (mirroring `useBranchFilterState` from
 * `packages/app/branches/hooks/use-branch-filter-state.ts`).
 *
 * Callers pass the full row set from the data source and render the returned
 * slices. Resetting to page 0 on a filter change lives here so neither surface
 * can forget it.
 *
 * The `toggleFacetValue` helper from `packages/app/shared/lib/facet-filter.ts`
 * is re-exported for consumers that drive the Collaborators/Source/Harness facet
 * toggles (e.g. `agent-component-filter-adapter.tsx`), avoiding a separate import.
 *
 * ISS-5009: `honestSourceEnabled` is passed IN rather than read from the flag
 * port here, so the surface resolves the flag once and hands the identical value
 * to this membership predicate and to the facet menu that builds the options the
 * user picks from. Two independent reads of the same key would still be one
 * flag, but only one call site makes the coupling impossible to forget.
 */
export function useAgentComponentsFilterState(
  rows: AgentComponent[],
  pageSize: number = AGENT_COMPONENT_PAGE_SIZE,
  initialFilters: AgentComponentFilters = DEFAULT_AGENT_COMPONENT_FILTERS,
  honestSourceEnabled = false
) {
  // Bind the flag into a stable filter function: `usePaginatedFilterState`
  // memoizes the filtered rows on the function identity, so an inline closure
  // would recompute the whole filter on every render.
  const filterRows = useCallback(
    (candidateRows: AgentComponent[], filters: AgentComponentFilters) =>
      filterAgentComponentRows(candidateRows, filters, honestSourceEnabled),
    [honestSourceEnabled]
  );

  // `initialFilters` seeds the FIRST render so a URL-driven narrowing (e.g. the
  // `?kind=` type-tab permalink) is applied before paint, instead of flashing
  // the unfiltered set for one frame and correcting in a post-render effect.
  // It is a mount-only seed (useState reads it once); later URL/tab changes flow
  // through `handleFiltersChange`, so this is not a controlled `filters` prop.
  return usePaginatedFilterState(
    rows,
    filterRows,
    DEFAULT_AGENT_COMPONENT_FILTERS,
    pageSize,
    initialFilters
  );
}
