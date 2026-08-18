"use client";

import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePaginatedFilterState } from "../../shared/hooks/use-paginated-filter-state";
import { useReplaceListParams } from "../../shared/hooks/use-replace-list-params";
import { initialFacetParamsSource } from "../../shared/lib/facet-filter-params";
import {
  normalizeBranchFiltersForMode,
  parseBranchFilterParams,
  writeBranchFilterParams,
} from "../lib/branch-filter-params";
import {
  type BranchFilters,
  type BranchRow,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
} from "../lib/branch-row";

/**
 * Owns the filter + pagination state for the Branches table, shared by the web
 * `/branches` page and the desktop Branches view so both surfaces stay in sync
 * (PRD-454). Callers pass the row set (sample rows today, real branch rows once
 * the data layer lands) and render the returned slices; resetting to page 0 on
 * a filter change lives here so neither surface can forget it.
 *
 * Thin wrapper over the shared {@link usePaginatedFilterState} — this keeps the
 * Branches-specific filter type/function/defaults while the pagination + page-
 * clamp machinery (incl. the FEA-2540 persist-clamp) lives in one place.
 */
export function useBranchFilterState(
  rows: BranchRow[],
  pageSize: number = BRANCH_PAGE_SIZE,
  initialFilters: BranchFilters = DEFAULT_BRANCH_FILTERS,
  approved = false
) {
  // `initialFilters` seeds the FIRST render (FEA-3560: the pages parse it from
  // the list URL so a detail→back restore reopens the filtered view); later
  // changes flow through `handleFiltersChange`, so this is not a controlled
  // `filters` prop.
  return usePaginatedFilterState(
    rows,
    useCallback(
      (items: BranchRow[], filters: BranchFilters) =>
        filterBranchRows(items, filters, { approved }),
      [approved]
    ),
    DEFAULT_BRANCH_FILTERS,
    pageSize,
    initialFilters
  );
}

/**
 * {@link useBranchFilterState} plus the FEA-3560 URL mirroring, shared by the
 * web `/branches` page and the desktop Branches view so the seed-from-URL and
 * write-through glue exists once instead of per surface: the facet filters are
 * seeded from the list URL on mount (restoring a detail→back / reload), and the
 * returned `handleFiltersChange` mirrors every change back into the URL via a
 * history-neutral `replace`. Pagination stays client-side state here, so only
 * filter changes touch the URL.
 */
export function useUrlSyncedBranchFilterState(
  rows: BranchRow[],
  pageSize: number = BRANCH_PAGE_SIZE,
  approved = false
) {
  const searchParams = useSearchParamsValue();
  // Mount-only seed; `initialFacetParamsSource` falls back to the browser URL
  // while the web App Router snapshot is still reconciling (empty) on a
  // reload/deep link. On the desktop hash router the fallback never fires
  // (`location.search` sits outside the hash).
  const [initialFilters] = useState(() =>
    normalizeBranchFiltersForMode(
      parseBranchFilterParams(initialFacetParamsSource(searchParams)),
      approved
    )
  );
  const state = useBranchFilterState(rows, pageSize, initialFilters, approved);
  const { handleFiltersChange: applyFilters } = state;
  const replaceFacetParams = useReplaceListParams(writeBranchFilterParams);
  const handleFiltersChange = useCallback(
    (next: BranchFilters) => {
      applyFilters(next);
      replaceFacetParams(next);
    },
    [applyFilters, replaceFacetParams]
  );
  const previousMode = useRef(approved);
  useEffect(() => {
    if (previousMode.current === approved) {
      return;
    }
    previousMode.current = approved;
    applyFilters(DEFAULT_BRANCH_FILTERS);
    replaceFacetParams(DEFAULT_BRANCH_FILTERS);
  }, [approved, applyFilters, replaceFacetParams]);
  return { ...state, handleFiltersChange };
}

/** Default page size for the Branches table. Raised from the scaffold's 5 to 25
 *  now that the list is wired to the real local branch corpus (FEA-1948 / B2). */
const BRANCH_PAGE_SIZE = 25;
export const APPROVED_BRANCH_PAGE_SIZE = 20;
