"use client";

import type {
  AgentComponent,
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Filter state for the Agents workspace inventory table (T-2.4).
 *
 * Shape mirrors `BranchFilters` from `branch-row.ts` but extended for the
 * richer facets available in the Agents workspace:
 * - `kinds`    — type-tab selection; empty = "All" (no narrowing by kind).
 * - `owners`   — owner facet; empty = any owner.
 * - `sources`  — source facet; empty = any source.
 * - `harnesses` — harness facet; empty = any harness.
 * - `search`   — substring match applied to component name; empty = no filter.
 */
export type AgentComponentFilters = {
  kinds: AgentComponentKind[];
  owners: string[];
  sources: string[];
  harnesses: Harness[];
  search: string;
};

export const DEFAULT_AGENT_COMPONENT_FILTERS: AgentComponentFilters = {
  kinds: [],
  owners: [],
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
 * - `owners`   — empty array means any owner is included.
 * - `sources`  — empty array means any source is included.
 * - `harnesses` — empty array means any harness is included.
 * - `search`   — case-insensitive substring match on `name`.
 */
export function filterAgentComponentRows(
  rows: AgentComponent[],
  filters: AgentComponentFilters
): AgentComponent[] {
  const searchLower = filters.search.toLowerCase();
  return rows.filter(
    (row) =>
      (filters.kinds.length === 0 || filters.kinds.includes(row.kind)) &&
      (filters.owners.length === 0 ||
        (row.owner !== null && filters.owners.includes(row.owner))) &&
      (filters.sources.length === 0 || filters.sources.includes(row.source)) &&
      (filters.harnesses.length === 0 ||
        filters.harnesses.includes(row.harness)) &&
      (searchLower === "" || row.name.toLowerCase().includes(searchLower))
  );
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
 * is re-exported for consumers that drive the Owner/Source/Harness facet toggles
 * (e.g. `agent-component-filter-adapter.tsx`), avoiding a separate import.
 */
export function useAgentComponentsFilterState(
  rows: AgentComponent[],
  pageSize: number = AGENT_COMPONENT_PAGE_SIZE
) {
  const [filters, setFilters] = useState<AgentComponentFilters>(
    DEFAULT_AGENT_COMPONENT_FILTERS
  );
  const [pageInput, setPage] = useState(0);

  const filteredRows = useMemo(
    () => filterAgentComponentRows(rows, filters),
    [rows, filters]
  );
  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Clamp the requested page to the available range. `handleFiltersChange`
  // resets to page 0 on a filter change, but the row set can also shrink without
  // a filter change — a data-source refetch dropping rows — which would otherwise
  // strand a viewer on a now-empty later page. Deriving the effective page keeps
  // pagedRows, the visible range, and the exposed page index consistent instead
  // of correcting after an extra render (mirrors the FEA-2540 fix in branches).
  const page = Math.min(pageInput, totalPages - 1);

  // Persist the clamp: `page` keeps the current render correct, but the stored
  // `pageInput` must follow it down when the corpus shrinks. Otherwise a later
  // refetch that regrows the row set would resurrect the stale out-of-range
  // index and jump the viewer back off the last page they were shown.
  useEffect(() => {
    if (pageInput > page) {
      setPage(page);
    }
  }, [pageInput, page]);

  const pagedRows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize]
  );
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  const handleFiltersChange = useCallback((next: AgentComponentFilters) => {
    setFilters(next);
    setPage(0);
  }, []);

  return {
    filters,
    page,
    setPage,
    filteredRows,
    pagedRows,
    total,
    totalPages,
    from,
    to,
    handleFiltersChange,
  };
}
