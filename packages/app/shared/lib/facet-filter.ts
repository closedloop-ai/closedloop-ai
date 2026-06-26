import type {
  TableFiltersController,
  TableFiltersState,
} from "@repo/design-system/components/ui/table-filters";

/**
 * Shared scaffolding for the generic `FilterPopover` when it is driven purely by
 * `viewModel.facetGroups` (the Sessions/Branches multi-select facet UX). That
 * code path never reads the built-in controller — the facet groups own their
 * own state and toggle handlers, and the count badge reads the groups directly —
 * but `FilterPopover` still requires a `controller`, so surfaces pass this no-op.
 */

export const EMPTY_TABLE_FILTERS_STATE: TableFiltersState = {
  assigneeIds: [],
  assignToMe: false,
  hideCompletedItems: false,
  favoritesOnly: false,
  statuses: [],
  priorities: [],
  date: null,
  tagIds: [],
};

export const NOOP_TABLE_FILTERS_CONTROLLER: TableFiltersController = {
  filters: EMPTY_TABLE_FILTERS_STATE,
  toggleAssignee: () => undefined,
  toggleAssignToMe: () => undefined,
  toggleHideCompletedItems: () => undefined,
  toggleFavoritesOnly: () => undefined,
  toggleStatus: () => undefined,
  togglePriority: () => undefined,
  setDateFilter: () => undefined,
  toggleTag: () => undefined,
  clearCategoryFilter: () => undefined,
  clearAllFilters: () => undefined,
  activeChips: [],
};

/** Add or remove a value from a multi-select facet selection. */
export function toggleFacetValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}
