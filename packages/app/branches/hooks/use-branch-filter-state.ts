"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
 */
export function useBranchFilterState(
  rows: BranchRow[],
  pageSize: number = BRANCH_PAGE_SIZE
) {
  const [filters, setFilters] = useState<BranchFilters>(DEFAULT_BRANCH_FILTERS);
  const [pageInput, setPage] = useState(0);

  const filteredRows = useMemo(
    () => filterBranchRows(rows, filters),
    [rows, filters]
  );
  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp the requested page to the available range. `handleFiltersChange`
  // resets to page 0 on a filter change, but the row set can also shrink without
  // one — a live desktop DB push or a list refetch dropping rows — which would
  // otherwise strand a viewer on a now-empty later page (FEA-2540). Deriving the
  // effective page keeps pagedRows, the visible range, and the exposed page
  // index consistent instead of correcting after an extra render.
  const page = Math.min(pageInput, totalPages - 1);
  // Persist the clamp: `page` keeps the *current* render correct, but the stored
  // `pageInput` must follow it down when the corpus shrinks. Otherwise a later
  // push/refetch that regrows the row set would resurrect the stale out-of-range
  // index and jump the viewer back off the last page they were shown (FEA-2540).
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

  const handleFiltersChange = useCallback((next: BranchFilters) => {
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

/** Default page size for the Branches table. Raised from the scaffold's 5 to 25
 *  now that the list is wired to the real local branch corpus (FEA-1948 / B2). */
export const BRANCH_PAGE_SIZE = 25;
