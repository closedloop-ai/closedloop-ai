import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { usePaginatedFilterState } from "../use-paginated-filter-state";

/**
 * Behavior coverage for the generic filter+pagination hook that
 * `useBranchFilterState` and `useAgentComponentsFilterState` both wrap
 * (FEA-3602). Guards the invariants those surfaces would otherwise each
 * re-implement: page-reset-on-filter-change, the shrink-clamp persist
 * (FEA-2540), the visible-range readout, and the mount-only `initialFilters`
 * seed.
 */

type Row = { id: string; owner: string };
type Filters = { owner: string | null };

const ROWS: Row[] = [
  { id: "a", owner: "Alex" },
  { id: "b", owner: "Alex" },
  { id: "c", owner: "Sam" },
  { id: "d", owner: "Sam" },
  { id: "e", owner: "Jordan" },
  { id: "f", owner: "Jordan" },
];

const DEFAULT_FILTERS: Filters = { owner: null };

const filterRows = (rows: Row[], filters: Filters): Row[] =>
  filters.owner === null
    ? rows
    : rows.filter((row) => row.owner === filters.owner);

describe("usePaginatedFilterState", () => {
  test("paginates by the given page size and reports the visible range", () => {
    const { result } = renderHook(() =>
      usePaginatedFilterState(ROWS, filterRows, DEFAULT_FILTERS, 4)
    );

    expect(result.current.total).toBe(6);
    expect(result.current.totalPages).toBe(2);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(4);
  });

  test("advances to the next page and slices the tail", () => {
    const { result } = renderHook(() =>
      usePaginatedFilterState(ROWS, filterRows, DEFAULT_FILTERS, 4)
    );

    act(() => {
      result.current.setPage(1);
    });

    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
    expect(result.current.from).toBe(5);
    expect(result.current.to).toBe(6);
  });

  test("filtering narrows the rows and recomputes totals", () => {
    const { result } = renderHook(() =>
      usePaginatedFilterState(ROWS, filterRows, DEFAULT_FILTERS, 4)
    );

    act(() => {
      result.current.handleFiltersChange({ owner: "Alex" });
    });

    expect(result.current.total).toBe(2);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("changing filters resets back to the first page", () => {
    const { result } = renderHook(() =>
      usePaginatedFilterState(ROWS, filterRows, DEFAULT_FILTERS, 4)
    );

    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);

    act(() => {
      result.current.handleFiltersChange({ owner: "Jordan" });
    });
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
  });

  // The interaction FEA-3602's suite missed and this fix pins: seed >1 page, go
  // to a LATER page, then apply a filter whose result set is smaller than the
  // current page offset. The viewer must land on a valid page showing the
  // filtered rows — never a blank, out-of-range page. Uses a 4-page corpus so
  // the starting page (index 2) is strictly beyond the filtered set's single
  // page, exercising the reset rather than an already-in-range no-op.
  test("filtering below the current page resets to a populated first page (not blank)", () => {
    const wide: Row[] = [
      ...ROWS,
      { id: "g", owner: "Kim" },
      { id: "h", owner: "Kim" },
      { id: "i", owner: "Kim" },
      { id: "j", owner: "Kim" },
    ]; // 10 rows @ pageSize 4 → 3 pages
    const { result } = renderHook(() =>
      usePaginatedFilterState(wide, filterRows, DEFAULT_FILTERS, 4)
    );

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["i", "j"]);

    // Alex matches 2 rows → a single page; the old page 2 is out of range.
    act(() => {
      result.current.handleFiltersChange({ owner: "Alex" });
    });

    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(0);
    // The filtered rows are actually shown — NOT a blank out-of-range slice.
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.current.pagedRows.length).toBeGreaterThan(0);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(2);
  });

  // Distinguishes a page RESET (→ page 0, first slice of the new result set) from
  // a mere CLAMP (→ last valid page). On a later page, apply a filter whose
  // result set is still MULTIPLE pages but fewer than the current index: a clamp
  // alone would leave the viewer on the filtered set's *last* page, mid-list; the
  // correct behavior for a deliberate filter change is to restart at page 0. This
  // is the assertion the single-page cases above cannot make (there, reset and
  // clamp both yield page 0), and the one that fails if the reset is dropped in
  // favor of the clamp — the exact FEA-3602 extract-time hazard.
  test("filtering resets to page 0, not merely clamps to the last valid page", () => {
    // 12 rows, owner "Big" on 8 of them. @ pageSize 2: full set = 6 pages,
    // Big-filtered = 4 pages. Start on page 5 (index) which is beyond both.
    const big: Row[] = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      owner: i < 8 ? "Big" : "Small",
    }));
    const { result } = renderHook(() =>
      usePaginatedFilterState(big, filterRows, DEFAULT_FILTERS, 2)
    );

    act(() => {
      result.current.setPage(5);
    });
    expect(result.current.page).toBe(5);

    act(() => {
      result.current.handleFiltersChange({ owner: "Big" });
    });

    // Big → 8 rows → 4 pages (indices 0-3). A clamp would land on page 3; the
    // reset must land on page 0 with the FIRST filtered slice.
    expect(result.current.totalPages).toBe(4);
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["n0", "n1"]);
  });

  // Defense in depth: the reset is intrinsic to the hook (it fires on any change
  // of the `filters` identity during render), so it does not depend on
  // `handleFiltersChange` being the mutation path. Widening back out on a later
  // page must also start the new, larger result set from page 0 rather than
  // clamping to the old page — a filter change is a deliberate context switch,
  // not a corpus shrink.
  test("widening the filter on a later page also restarts at page 0", () => {
    const { result } = renderHook(() =>
      usePaginatedFilterState(ROWS, filterRows, DEFAULT_FILTERS, 2)
    );

    // Narrow to Jordan (rows e, f → 1 page), then page around the full set.
    act(() => {
      result.current.handleFiltersChange({ owner: "Jordan" });
    });
    act(() => {
      result.current.setPage(0);
    });

    // Clear the filter: 6 rows @ pageSize 2 → 3 pages. Advancing then clearing
    // must land on page 0 of the widened set, showing its first slice.
    act(() => {
      result.current.setPage(0);
      result.current.handleFiltersChange(DEFAULT_FILTERS);
    });

    expect(result.current.totalPages).toBe(3);
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("clamps and persists the page down when the corpus shrinks (FEA-2540)", () => {
    const { result, rerender } = renderHook(
      ({ rows }) =>
        usePaginatedFilterState(rows, filterRows, DEFAULT_FILTERS, 4),
      { initialProps: { rows: ROWS } }
    );

    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);

    // Corpus shrinks to a single page without a filter change.
    rerender({ rows: ROWS.slice(0, 2) });
    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(0);

    // Re-growing must NOT resurrect the stale out-of-range index.
    rerender({ rows: ROWS });
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("seeds the first render from initialFilters when provided", () => {
    const { result } = renderHook(() =>
      usePaginatedFilterState(ROWS, filterRows, DEFAULT_FILTERS, 4, {
        owner: "Sam",
      })
    );

    expect(result.current.filters).toEqual({ owner: "Sam" });
    expect(result.current.total).toBe(2);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["c", "d"]);
  });
});
