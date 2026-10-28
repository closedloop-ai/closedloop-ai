"use client";

import { Button } from "@repo/design-system/components/ui/button";
import type { GridTableListSurfaceMode } from "@repo/design-system/components/ui/grid-table-list-surface";
import { GridTableToolbar } from "@repo/design-system/components/ui/grid-table-toolbar";
import { TableCompactViewMenu } from "@repo/design-system/components/ui/table-compact-view-menu-v2";
import { TableGroupMenu } from "@repo/design-system/components/ui/table-group-menu-v2";
import { TableOptionsMenu } from "@repo/design-system/components/ui/table-options-menu-v2";
import { TableSortMenu } from "@repo/design-system/components/ui/table-sort-menu-v2";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  type TableDateRangeOption,
  TableDateRangeToggle,
} from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  type ListSurfaceLayoutToggle,
  ListSurfaceLayoutToggleControl,
  type ListSurfaceSortGrouping,
  resolveListSurfaceGrouping,
} from "./list-surface-toolbar-parts";
import { LIST_TOOLBAR_ADD_FIELD_LABEL } from "./list-toolbar-copy";

/**
 * The layout every list-surface toolbar shares, with the pieces that differ
 * between the shared toolbar and the pre-ISS-13007 fork handed in as slots, so
 * neither wrapper reads a flag in here and none is passed down (ISS-13035).
 *
 * @see ListSurfaceToolbar the shared shape
 * @see ListSurfaceToolbarV2 the one `gridview-adoption` read that picks
 */
export function ListSurfaceToolbarLayout({
  activeFilters,
  columns,
  dateRange,
  dateRangeLabel,
  dateRangeOptions,
  filterPopover,
  framed,
  layoutToggle,
  leadingSearch,
  leadingTrailing,
  metrics,
  mode,
  onAddField,
  onDateRangeChange,
  onToggleColumn,
  onToggleMetric,
  optionsTrailing,
  primary,
  savedViews,
  sortGrouping,
  sortPlacement = "all",
  trailing,
  visibleColumnIds,
  visibleMetricKeys,
}: {
  activeFilters?: ReactNode;
  columns: readonly TableToggleOption[];
  /** Omit it on a page with no time dimension: the range control is absent. */
  dateRange?: string;
  dateRangeLabel?: string;
  dateRangeOptions?: readonly TableDateRangeOption[];
  /** The filter menu, already built for the shape being drawn. */
  filterPopover: ReactNode;
  /** Draws the `border-b px-4 py-3` band for a host with no list surface. */
  framed?: boolean;
  layoutToggle?: ListSurfaceLayoutToggle;
  /** First in the leading cluster. */
  leadingSearch?: ReactNode;
  leadingTrailing?: ReactNode;
  metrics?: readonly TableToggleOption[];
  mode?: GridTableListSurfaceMode;
  /** Omit to hide Add field, wide and folded. */
  onAddField?: () => void;
  onDateRangeChange?: (value: string) => void;
  onToggleColumn: (columnId: string) => void;
  onToggleMetric?: (metricKey: string) => void;
  optionsTrailing?: ReactNode;
  primary?: ReactNode;
  /** Saved-views menu, after Options wide and before View when folded. */
  savedViews?: ReactNode;
  sortGrouping?: ListSurfaceSortGrouping;
  sortPlacement?: "all" | "compact";
  trailing?: ReactNode;
  visibleColumnIds: ReadonlySet<string>;
  visibleMetricKeys?: ReadonlySet<string>;
}) {
  const grouping = resolveListSurfaceGrouping(sortGrouping);
  // ONE prop set, rendered at whichever width asks for it. Two literals is the
  // exact drift this module exists to stop: `GridTableToolbar` renders
  // `expanded` and `compact` as sibling slots with CSS hiding one, so a prop
  // added to one copy and not the other silently drops a capability at the `md`
  // boundary.
  const renderOptionsMenu = (align: "start" | "end") => (
    <TableOptionsMenu
      align={align}
      columns={columns}
      metrics={metrics}
      onToggleColumn={onToggleColumn}
      onToggleMetric={onToggleMetric}
      trailing={optionsTrailing}
      visibleColumnIds={visibleColumnIds}
      visibleMetricKeys={visibleMetricKeys}
    />
  );
  const renderLayoutToggle = (iconOnly: boolean) =>
    layoutToggle ? (
      <ListSurfaceLayoutToggleControl {...layoutToggle} iconOnly={iconOnly} />
    ) : null;
  const toolbar = (
    <GridTableToolbar
      activeFilters={activeFilters}
      compact={
        <>
          {renderLayoutToggle(true)}
          {savedViews}
          {sortGrouping ? (
            <TableCompactViewMenu
              columns={columns}
              grouping={grouping?.grouping}
              groupOptions={grouping?.groupOptions}
              maxSortRules={sortGrouping.maxSortRules}
              metrics={metrics}
              onAddField={onAddField}
              onClearSort={sortGrouping.onClearSort}
              onGroupingChange={grouping?.onGroupingChange}
              onSort={sortGrouping.onSort}
              onSortsChange={sortGrouping.onSortsChange}
              onToggleColumn={onToggleColumn}
              onToggleMetric={onToggleMetric}
              sortBy={sortGrouping.sortBy}
              sortOptions={sortGrouping.sortOptions}
              sorts={sortGrouping.sorts}
              trailing={optionsTrailing}
              visibleColumnIds={visibleColumnIds}
              visibleMetricKeys={visibleMetricKeys}
            />
          ) : (
            // `end` matches `TableCompactViewMenu`'s own default for this slot,
            // and the slot is `ml-auto`-right-aligned: opening from the start
            // edge at phone width runs the menu off the screen. The wide mount
            // keeps the catalog's `start` default, which is what Sessions ships.
            renderOptionsMenu("end")
          )}
        </>
      }
      expanded={
        <>
          {renderLayoutToggle(false)}
          {sortGrouping ? (
            <>
              {sortPlacement === "all" ? (
                <TableSortMenu
                  maxSortRules={sortGrouping.maxSortRules}
                  onClear={sortGrouping.onClearSort}
                  onSort={sortGrouping.onSort}
                  onSortsChange={sortGrouping.onSortsChange}
                  options={sortGrouping.sortOptions}
                  sortBy={sortGrouping.sortBy}
                  sorts={sortGrouping.sorts}
                />
              ) : null}
              {grouping ? (
                <TableGroupMenu
                  allowEmptyGroups={sortGrouping.allowEmptyGroups}
                  grouping={grouping.grouping}
                  onGroupingChange={grouping.onGroupingChange}
                  options={grouping.groupOptions}
                />
              ) : null}
            </>
          ) : null}
          {renderOptionsMenu("start")}
          {savedViews}
          {onAddField ? (
            <Button onClick={onAddField} size="sm" variant="outline">
              <PlusIcon />
              {LIST_TOOLBAR_ADD_FIELD_LABEL}
            </Button>
          ) : null}
        </>
      }
      leading={
        <>
          {leadingSearch}
          {dateRange !== undefined && dateRangeOptions && onDateRangeChange ? (
            <TableDateRangeToggle
              label={dateRangeLabel}
              onValueChange={onDateRangeChange}
              options={dateRangeOptions}
              value={dateRange}
            />
          ) : null}
          {leadingTrailing}
          {filterPopover}
        </>
      }
      mode={mode}
      primary={primary}
      trailing={trailing}
    />
  );
  return framed ? <div className="border-b px-4 py-3">{toolbar}</div> : toolbar;
}
