"use client";

import type {
  AgentComponent,
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { Harness as HarnessValues } from "@repo/api/src/types/agent-component";
import { useCallback } from "react";
import { usePaginatedFilterState } from "../../shared/hooks/use-paginated-filter-state";
import { sourceFacetValue } from "../lib/agent-component-sort-group";

/**
 * Filter state for the Agents workspace inventory table (T-2.4).
 *
 * Shape mirrors `BranchFilters` from `branch-row.ts` but extended for the
 * richer facets available in the Agents workspace:
 * - `kinds`    — type-tab selection; empty = "All" (no narrowing by kind).
 * - `collaborators` — author (collaborator) facet; empty = any author.
 * - `sources`  — source facet; empty = any source.
 * - `harnesses` — harness facet; empty = any harness.
 * - `search`   — substring match applied to component name; empty = no filter.
 */
export type AgentComponentFilters = {
  kinds: AgentComponentKind[];
  // FEA-4098 (Slice 3): author (collaborator) facet, replacing the single-owner
  // facet. A component matches when any of its authors is selected.
  collaborators: string[];
  sources: string[];
  harnesses: Harness[];
  search: string;
};

export const DEFAULT_AGENT_COMPONENT_FILTERS: AgentComponentFilters = {
  kinds: [],
  collaborators: [],
  sources: [],
  harnesses: [],
  search: "",
};

/** Default page size for the Agents workspace table. */
export const AGENT_COMPONENT_PAGE_SIZE = 25;

/**
 * Filter rows from the full inventory corpus according to `AgentComponentFilters`.
 *
 * - `kinds`    — empty array means "All" (include every kind).
 * - `collaborators` — empty array means any author is included; otherwise a row
 *   matches when at least one of its authors is selected.
 * - `sources`  — empty array means any source is included.
 * - `harnesses` — empty array means any harness is included.
 * - `search`   — case-insensitive substring match on `name`.
 *
 * ISS-5009: `honestSourceEnabled` MUST carry the same value the Source facet's
 * option universe and counts were built with (`countFacetValues`). The two
 * projections diverge for any row whose real provenance lives on a branch the
 * legacy `source` chain cannot reach, so a menu built one way and matched the
 * other offers an option with a positive count that selects zero rows. It
 * defaults to `false` — today's behavior — for callers that have not adopted the
 * flag.
 */
export function filterAgentComponentRows(
  rows: AgentComponent[],
  filters: AgentComponentFilters,
  honestSourceEnabled = false
): AgentComponent[] {
  // FEA-4086: trim once so a whitespace-only search string ("") is treated as
  // "no search" here exactly as it is by the empty-state honesty helpers in
  // agents-grouped-list.tsx (`normalizedSearch`). A single space must never
  // both empty the list AND leave the honest-empty copy claiming a full
  // inventory — normalizing at both boundaries keeps them in lockstep.
  const searchLower = normalizedSearch(filters).toLowerCase();
  return rows.filter((row) => {
    // A `null` facet value means the row carries no source to filter on, so an
    // active Source selection excludes it — it is absent from the option
    // universe and from every count, and matching it would resurrect the
    // identity-key echo through the back door.
    const source = sourceFacetValue(row, honestSourceEnabled);
    return (
      (filters.kinds.length === 0 || filters.kinds.includes(row.kind)) &&
      (filters.collaborators.length === 0 ||
        row.collaborators.some((c) => filters.collaborators.includes(c))) &&
      (filters.sources.length === 0 ||
        (source !== null && filters.sources.includes(source))) &&
      (filters.harnesses.length === 0 ||
        harnessMatchesFacet(row.harness, filters.harnesses)) &&
      (searchLower === "" || row.name.toLowerCase().includes(searchLower))
    );
  });
}

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

/**
 * FEA-4086: the canonical trimmed search string for the Agents inventory.
 * `filterAgentComponentRows` (membership) and the empty-state honesty helpers
 * in `agents-grouped-list.tsx` MUST read the search box through this single
 * helper so a whitespace-only entry can never be treated as an active search by
 * one path and as "no search" by the other — the divergence that let a single
 * space empty the plugins list while the copy still claimed a full inventory.
 */
export function normalizedSearch(filters: AgentComponentFilters): string {
  return filters.search.trim();
}

/**
 * FEA-4086 / ISS-4386: does a row's DISPLAYED harness satisfy the selected
 * harness facet?
 *
 * The rollup folds a component's per-session harnesses into one value: a
 * component that ran in MORE THAN ONE harness carries `harness === Harness.Both`
 * (see `resolveComponentHarness` in the API's harness-attribution). With
 * OpenCode a first-class harness, "more than one" now includes Claude+OpenCode
 * and Codex+OpenCode, not only Claude+Codex. A naive `selected.includes(
 * row.harness)` membership drops that multi-harness row out of a single-harness
 * facet, so a component installed for both Claude and OpenCode disappears under
 * the OpenCode facet and the empty state wrongly reads "No plugins installed for
 * OpenCode." A `Both` row is a member of the installed SET of individual
 * harnesses, so it matches whenever ANY individual harness is among the
 * selection (and, trivially, when `Both` itself is selected). Single-harness
 * rows match only their own value.
 */
export function harnessMatchesFacet(
  rowHarness: Harness,
  selected: Harness[]
): boolean {
  if (selected.includes(rowHarness)) {
    return true;
  }
  if (rowHarness === HarnessValues.Both) {
    // Matches any INDIVIDUAL harness selection (Claude, Codex, OpenCode, …) —
    // every non-`Both` selected value.
    return selected.some((h) => h !== HarnessValues.Both);
  }
  return false;
}
