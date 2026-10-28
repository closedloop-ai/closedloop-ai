"use client";

import {
  ActiveFiltersBar,
  hasVisibleActiveFilters,
} from "@repo/design-system/components/ui/active-filters-bar";
import type { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";
import type {
  TableFieldOption,
  TableGroupingState,
  TableSortRule,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { ComponentProps } from "react";
import { type ListLayout, ListLayoutToggle } from "./list-layout-toggle";
import { LIST_TOOLBAR_FILTER_LABEL } from "./list-toolbar-copy";

/** Pieces of the shared list toolbar that are not its layout. */

export type RenderRangeSubmenu = ComponentProps<
  typeof FilterPopover
>["renderRangeSubmenu"];

/** The view model with the shared toolbar's trigger label applied. */
export function withListToolbarFilterLabel<
  TStatus extends string,
  TPriority extends string,
>(
  viewModel: TableFiltersViewModel<TStatus, TPriority>
): TableFiltersViewModel<TStatus, TPriority> {
  return {
    ...viewModel,
    labels: { ...viewModel.labels, filterButton: LIST_TOOLBAR_FILTER_LABEL },
  };
}

/**
 * The chip row of the shared toolbar: it shows only while a chip or facet is
 * active, on every page. The pre-ISS-13007 chip row is drawn by
 * `ListSurfaceToolbarV2` itself, the one place the flag is read.
 */
export function ListSurfaceActiveFiltersRow<
  TStatus extends string,
  TPriority extends string,
>({
  controller,
  filtersActive,
  renderRangeSubmenu,
  viewModel,
}: {
  controller: TableFiltersController<TStatus, TPriority>;
  filtersActive: boolean | undefined;
  renderRangeSubmenu?: RenderRangeSubmenu;
  viewModel: TableFiltersViewModel<TStatus, TPriority>;
}) {
  const visible =
    filtersActive ?? hasVisibleActiveFilters(controller, viewModel);
  if (!visible) {
    return null;
  }
  return (
    <div className="-mx-4">
      <ActiveFiltersBar
        controller={controller}
        renderRangeSubmenu={renderRangeSubmenu}
        viewModel={viewModel}
      />
    </div>
  );
}

const WIDE_LAYOUT_ITEM_CLASS = "px-2 data-[variant=outline]:h-[26px]";

/** The List/Board switch of a page that has a board. */
export type ListSurfaceLayoutToggle = {
  /** The group's accessible name; a page keeps the one it ships. */
  ariaLabel?: string;
  onChange: (layout: ListLayout) => void;
  value: ListLayout;
};

export function ListSurfaceLayoutToggleControl({
  ariaLabel = "Artifact layout",
  iconOnly,
  onChange,
  value,
}: ListSurfaceLayoutToggle & { iconOnly: boolean }) {
  return (
    <ListLayoutToggle
      ariaLabel={ariaLabel}
      className={iconOnly ? "shrink-0" : undefined}
      itemClassName={iconOnly ? undefined : WIDE_LAYOUT_ITEM_CLASS}
      onChange={onChange}
      showLabels={!iconOnly}
      value={value}
    />
  );
}

/**
 * The ordering controls a surface offers, with an optional grouping extension.
 * The wide menus and narrow fold read the same fields.
 */
export type ListSurfaceSortGrouping = {
  /** @see TableGroupMenu.allowEmptyGroups */
  allowEmptyGroups?: boolean;
  /** Omit the grouping trio when sorting exists without grouping. */
  grouping?: TableGroupingState;
  groupOptions?: readonly TableFieldOption[];
  /** @see TableSortMenu.maxSortRules */
  maxSortRules?: number;
  onClearSort: () => void;
  onGroupingChange?: (grouping: TableGroupingState) => void;
  onSort: (fieldId: string, direction?: SortDirection) => void;
  /** Omit when the page orders by one rule and has no multi-rule model. */
  onSortsChange?: (sorts: readonly TableSortRule[]) => void;
  sortBy: string | null;
  sortOptions: readonly TableFieldOption[];
  sorts?: readonly TableSortRule[];
};

export function resolveListSurfaceGrouping(
  controls: ListSurfaceSortGrouping | undefined
):
  | {
      grouping: TableGroupingState;
      groupOptions: readonly TableFieldOption[];
      onGroupingChange: (grouping: TableGroupingState) => void;
    }
  | undefined {
  if (
    controls?.grouping === undefined ||
    controls.groupOptions === undefined ||
    controls.onGroupingChange === undefined
  ) {
    return;
  }
  return {
    grouping: controls.grouping,
    groupOptions: controls.groupOptions,
    onGroupingChange: controls.onGroupingChange,
  };
}
