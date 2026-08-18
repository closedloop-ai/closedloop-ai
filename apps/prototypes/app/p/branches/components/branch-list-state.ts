import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { type DateRange, DateRange as DateRangeValue } from "../mock";
import {
  type BranchFilters,
  createDefaultBranchFilters,
} from "./branch-list-filter";

export const BRANCH_LIST_PAGE_SIZE = 20;

export type BranchListViewState = {
  dateRange: DateRange;
  filters: BranchFilters;
  visibleColumns: Set<string>;
  sortBy: string;
  sortDir: SortDirection;
  page: number;
};

/** Creates route-owned state that survives list/detail replacement. */
export function createDefaultBranchListViewState(
  columnIds: readonly string[]
): BranchListViewState {
  return {
    dateRange: DateRangeValue.ThirtyDays,
    filters: createDefaultBranchFilters(),
    visibleColumns: new Set(columnIds),
    sortBy: "name",
    sortDir: "asc",
    page: 0,
  };
}

/** Produces the exact one-based range announced beside pagination. */
export function branchPageRange(
  page: number,
  totalRows: number,
  pageSize = BRANCH_LIST_PAGE_SIZE
): string {
  if (totalRows === 0) {
    return "0 of 0";
  }
  const start = page * pageSize + 1;
  const end = Math.min(totalRows, start + pageSize - 1);
  return `${start}\u2013${end} of ${totalRows}`;
}
