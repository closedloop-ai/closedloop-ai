import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  type BranchFilters,
  type BranchRow,
  BranchRowStatus,
} from "../../lib/branch-row";
import { useBranchFilterState } from "../use-branch-filter-state";

/**
 * Behavior coverage for the shared filter+pagination hook consumed by both the
 * web `/branches` page and the desktop Branches view (PRD-454). Guards the
 * page-reset-on-filter-change invariant the two surfaces would otherwise each
 * have to re-implement.
 */
function makeRow(
  id: string,
  owner: string,
  status: BranchRowStatus
): BranchRow {
  return {
    id,
    branchName: `agent/${id}`,
    baseBranch: "main",
    repo: `acme/${id}`,
    owner,
    status,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: 0,
    ahead: 1,
    additions: 1,
    deletions: 0,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1h ago",
  };
}

const ROWS: BranchRow[] = [
  makeRow("a", "Alex", BranchRowStatus.Open),
  makeRow("b", "Alex", BranchRowStatus.Open),
  makeRow("c", "Sam", BranchRowStatus.Merged),
  makeRow("d", "Sam", BranchRowStatus.Open),
  makeRow("e", "Jordan", BranchRowStatus.Open),
  makeRow("f", "Jordan", BranchRowStatus.Open),
];

const ownerFilter = (owner: string): BranchFilters => ({
  statuses: [],
  owners: [owner],
  repos: [],
});

describe("useBranchFilterState", () => {
  test("paginates the rows by the given page size and reports the visible range", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

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
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.setPage(1);
    });

    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
    expect(result.current.from).toBe(5);
    expect(result.current.to).toBe(6);
  });

  test("filtering narrows the rows and recomputes totals", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Alex"));
    });

    expect(result.current.total).toBe(2);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("changing filters resets back to the first page", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Jordan"));
    });

    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
  });

  test("clamps the page when the row set shrinks beneath the current page without a filter change", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useBranchFilterState(rows, 4),
      { initialProps: { rows: ROWS } }
    );

    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);

    // A live data push / refetch drops rows down to a single page. The viewer
    // must fall back to a page that still has rows rather than an empty table.
    rerender({ rows: ROWS.slice(0, 2) });

    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(2);
  });

  test("does not resurrect a stale page index after the corpus shrinks then regrows", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useBranchFilterState(rows, 4),
      { initialProps: { rows: ROWS } }
    );

    // Viewer navigates to page 1 (rows e, f).
    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);

    // A push shrinks the corpus to a single page — the clamp must persist to
    // page 0, not just be derived for this render.
    rerender({ rows: ROWS.slice(0, 2) });
    expect(result.current.page).toBe(0);

    // A later push regrows the corpus. The viewer stays on the page they were
    // shown (0) instead of jumping back to the stale page-1 index.
    rerender({ rows: ROWS });
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("keeps at least one page and a zeroed range when nothing matches", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Nobody"));
    });

    expect(result.current.total).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedRows).toEqual([]);
    expect(result.current.from).toBe(0);
    expect(result.current.to).toBe(0);
  });
});
