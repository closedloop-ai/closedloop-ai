"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Generic filter + pagination state for a client-side table, shared by both the
 * web app and the desktop renderer. Owns the filter object, the page index, the
 * derived filtered/paged slices, and the visible-range readout — and, crucially,
 * the two invariants every table would otherwise re-implement:
 *
 * - **reset to page 0 on a filter change** (`handleFiltersChange`), so a
 *   narrowing never strands the viewer on a now-out-of-range page; and
 * - **clamp + persist the page when the corpus shrinks without a filter change**
 *   (a live desktop DB push or a list refetch dropping rows) so `pagedRows`, the
 *   visible range, and the exposed page index stay consistent instead of being
 *   corrected after an extra render (FEA-2540).
 *
 * Concrete hooks (`useBranchFilterState`, `useAgentComponentsFilterState`) wrap
 * this with their own filter type, filter function, and defaults; the return
 * shape is identical across surfaces so table components stay interchangeable.
 *
 * `initialFilters` seeds the FIRST render (a mount-only `useState` seed) so a
 * URL-driven narrowing — e.g. a `?kind=` type-tab permalink — is applied before
 * paint instead of flashing the unfiltered set for one frame; later changes flow
 * through `handleFiltersChange`. It defaults to `defaultFilters` for callers that
 * always mount unfiltered.
 */
export function usePaginatedFilterState<TRow, TFilters>(
  rows: TRow[],
  filterFn: (rows: TRow[], filters: TFilters) => TRow[],
  defaultFilters: TFilters,
  pageSize: number,
  initialFilters: TFilters = defaultFilters
) {
  const [filters, setFilters] = useState<TFilters>(initialFilters);
  const [pageInput, setPage] = useState(0);

  const filteredRows = useMemo(
    () => filterFn(rows, filters),
    [rows, filters, filterFn]
  );
  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Reset to page 0 whenever the *filters* change, regardless of how they were
  // changed. `handleFiltersChange` already resets, but consumers can (and do)
  // drive `filters` through other paths — the Agents kind-tab URL→filter sync
  // effect, or a future wrapper that forgets to route through the helper — and a
  // narrowing that shrinks the result below the
  // current page must land the viewer on a populated page, not a blank one. The
  // clamp below caps the page to the *last valid* index (correct for a live
  // corpus shrink), but a deliberate filter change should send the viewer to the
  // FIRST page of the new result set; without this, refining a filter on a later
  // page strands them mid-list. Detecting the change here (not in the setter)
  // makes the invariant intrinsic to the hook so no consumer can regress it
  // (FEA-3602 extracted the machinery; this closes the filter→page-reset gap its
  // test missed).
  const prevFiltersRef = useRef(filters);
  if (prevFiltersRef.current !== filters) {
    prevFiltersRef.current = filters;
    if (pageInput !== 0) {
      setPage(0);
    }
  }

  // Clamp the requested page to the available range. The reset above covers a
  // filter change, but the row set can also shrink WITHOUT one — a live desktop
  // DB push or a list refetch dropping rows — which would otherwise strand a
  // viewer on a now-empty later page (FEA-2540). Deriving the effective page
  // keeps pagedRows, the visible range, and the exposed page index consistent
  // instead of correcting after an extra render.
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

  // Publish the new filter object only — the page reset is intrinsic (the
  // render-time filter-identity check above), so it can't drift apart from the
  // filter mutation. Tying the reset to the filter *value* rather than to this
  // one setter is what closes the FEA-3602 extract-time gap: any path that
  // changes filters (this helper, the Agents kind-tab URL→filter sync effect, a
  // future consumer wrapper) resets the page, so none can strand the viewer on a
  // now-out-of-range page.
  const handleFiltersChange = useCallback((next: TFilters) => {
    setFilters(next);
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
