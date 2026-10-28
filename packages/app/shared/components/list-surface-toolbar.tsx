"use client";

import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import type { GridTableListSurfaceMode } from "@repo/design-system/components/ui/grid-table-list-surface";
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import type { TableDateRangeOption } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import type { ComponentProps, ReactNode } from "react";
import { ListSurfaceToolbarLayout } from "./list-surface-toolbar-layout";
import {
  ListSurfaceActiveFiltersRow,
  type ListSurfaceLayoutToggle,
  type ListSurfaceSortGrouping,
  withListToolbarFilterLabel,
} from "./list-surface-toolbar-parts";
import {
  ListToolbarSearch,
  type ListToolbarSearchControl,
} from "./list-toolbar-search";

/**
 * ISS-13007: the ONE toolbar Documents, Issues, Projects, Project Detail and,
 * under `gridview-adoption`, Sessions and Branches render. What those pages have
 * and Sessions and Branches do not (the List/Board toggle, saved views, Add
 * field, a controlled filter menu) arrive as omitted-by-default props, so a page
 * supplies its fields and data and never its own layout.
 *
 * It reads no flag: each page decides at its own read whether to mount it
 * (ISS-13035). Sessions and Branches reach it through `ListSurfaceToolbarV2`.
 */
export function ListSurfaceToolbar<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  activeFiltersViewModel,
  columns,
  dateRange,
  dateRangeLabel,
  dateRangeOptions,
  filterController,
  filterMenu,
  filtersActive,
  framed,
  filterViewModel,
  layoutToggle,
  leadingTrailing,
  metrics,
  mode,
  onClearFilters,
  onAddField,
  onDateRangeChange,
  onToggleColumn,
  onToggleMetric,
  optionsTrailing,
  primary,
  savedViews,
  search,
  sortGrouping,
  trailing,
  visibleColumnIds,
  visibleMetricKeys,
}: ListSurfaceToolbarProps<TStatus, TPriority>) {
  const barViewModel = activeFiltersViewModel ?? filterViewModel;
  return (
    <ListSurfaceToolbarLayout
      activeFilters={
        <ListSurfaceActiveFiltersRow
          controller={filterController}
          filtersActive={filtersActive}
          renderRangeSubmenu={filterMenu?.renderRangeSubmenu}
          viewModel={barViewModel}
        />
      }
      columns={columns}
      dateRange={dateRange}
      dateRangeLabel={dateRangeLabel}
      dateRangeOptions={dateRangeOptions}
      filterPopover={
        <FilterPopover
          controller={filterController}
          onClear={onClearFilters}
          viewModel={withListToolbarFilterLabel(filterViewModel)}
          {...filterMenu}
        />
      }
      framed={framed}
      layoutToggle={layoutToggle}
      leadingSearch={
        search ? (
          <ListToolbarSearch onChange={search.onChange} value={search.value} />
        ) : null
      }
      leadingTrailing={leadingTrailing}
      metrics={metrics}
      mode={mode}
      onAddField={onAddField}
      onDateRangeChange={onDateRangeChange}
      onToggleColumn={onToggleColumn}
      onToggleMetric={onToggleMetric}
      optionsTrailing={optionsTrailing}
      primary={primary}
      savedViews={savedViews}
      sortGrouping={sortGrouping}
      trailing={trailing}
      visibleColumnIds={visibleColumnIds}
      visibleMetricKeys={visibleMetricKeys}
    />
  );
}

export type ListSurfaceToolbarProps<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  /** The model the removable-chip row reads, when it differs from the menu's. */
  activeFiltersViewModel?: TableFiltersViewModel<TStatus, TPriority>;
  columns: readonly TableToggleOption[];
  /** The selected preset, or `""` while an explicit window supersedes it. */
  dateRange?: string;
  /** Names the range group for screen readers and its tooltip. */
  dateRangeLabel?: string;
  dateRangeOptions?: readonly TableDateRangeOption[];
  filterController: TableFiltersController<TStatus, TPriority>;
  /** A page that owns the filter menu's open state, or renders range facets. */
  filterMenu?: Pick<
    ComponentProps<typeof FilterPopover>,
    "onOpenChange" | "open" | "renderRangeSubmenu"
  >;
  /** Overrides the chip-derived answer to "is anything narrowing the list". */
  filtersActive?: boolean;
  /** Draws the `border-b px-4 py-3` band itself. */
  framed?: boolean;
  filterViewModel: TableFiltersViewModel<TStatus, TPriority>;
  /** The List/Board switch, present only on a page that has a board. */
  layoutToggle?: ListSurfaceLayoutToggle;
  /** Controls between the date-range toggle and the filter popover. */
  leadingTrailing?: ReactNode;
  /** Toggleable summary cards, or omitted for a surface with no metric row. */
  metrics?: readonly TableToggleOption[];
  /** Opt into the list surface's measured slot instead of viewport CSS. */
  mode?: GridTableListSurfaceMode;
  /** ISS-10361: omitted by a surface whose filters have no clear-all action. */
  onClearFilters?: () => void;
  /** Omit to hide Add field, wide and folded. */
  onAddField?: () => void;
  onDateRangeChange?: (value: string) => void;
  onToggleColumn: (columnId: string) => void;
  onToggleMetric?: (metricKey: string) => void;
  /** Rows appended inside the options menu, wide and folded alike. */
  optionsTrailing?: ReactNode;
  /** Between the leading cluster and the right cluster, at every width. */
  primary?: ReactNode;
  /** Saved-views menu, after Options wide and before View when folded. */
  savedViews?: ReactNode;
  /** PRD-721: the free-text search, first in the leading cluster. */
  search?: ListToolbarSearchControl;
  /** The ordering and grouping cluster; omitted, neither menu renders. */
  sortGrouping?: ListSurfaceSortGrouping;
  /** After both clusters, at every width. */
  trailing?: ReactNode;
  visibleColumnIds: ReadonlySet<string>;
  visibleMetricKeys?: ReadonlySet<string>;
};
