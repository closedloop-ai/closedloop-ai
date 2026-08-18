"use client";

import type { GridTableGroup } from "@repo/design-system/components/ui/grid-table";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FilterDimension, FilterOption } from "./agents-filter-menu";
import type { GroupByOption, ViewMenuColumn } from "./agents-view-menu";

// Column shown in the View menu's Show / Hide list.
export type TableColumn = { id: string; label: string; icon: ReactNode };

// A filterable / groupable facet of a row. `value` maps a row to its raw key;
// `display` optionally maps that key to a human label; `sortOptions` optionally
// overrides the default alphabetical ordering of the filter submenu.
export type TableDimension<T> = {
  key: string;
  label: string;
  icon: ReactNode;
  value: (item: T) => string;
  display?: (value: string) => string;
  sortOptions?: (a: FilterOption, b: FilterOption) => number;
};

export const NO_GROUP = "none";

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const toggleValue = (
  set: ReadonlySet<string>,
  value: string
): ReadonlySet<string> => {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
};

const labelFor = <T>(dimension: TableDimension<T>, value: string): string =>
  dimension.display ? dimension.display(value) : value;

// Shared Filter + View + Group state for one of the detail tables. Works for any
// row type via the `value` accessors on each dimension, so the Sessions and
// Branches tables reuse the exact same control behavior as the main inventory.
export const useTableControls = <T>({
  items,
  columns,
  dimensions,
  groupables,
}: {
  items: readonly T[];
  columns: readonly TableColumn[];
  dimensions: readonly TableDimension<T>[];
  groupables: readonly TableDimension<T>[];
}) => {
  const [hiddenColumns, setHiddenColumns] =
    useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [groupBy, setGroupBy] = useState<string>(NO_GROUP);
  const [selections, setSelections] = useState<
    Record<string, ReadonlySet<string>>
  >({});

  const selectionFor = (key: string) => selections[key] ?? EMPTY_SELECTION;

  const filteredItems = items.filter((item) =>
    dimensions.every((dimension) => {
      const selected = selectionFor(dimension.key);
      return selected.size === 0 || selected.has(dimension.value(item));
    })
  );

  const filterDimensions: FilterDimension[] = dimensions.map((dimension) => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const value = dimension.value(item);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const options: FilterOption[] = [...counts.entries()]
      .map(([value, count]) => ({
        value,
        label: labelFor(dimension, value),
        count,
      }))
      .sort(
        dimension.sortOptions ?? ((a, b) => a.label.localeCompare(b.label))
      );
    return {
      key: dimension.key,
      label: dimension.label,
      icon: dimension.icon,
      options,
      selected: selectionFor(dimension.key),
      onToggle: (value: string) =>
        setSelections((prev) => ({
          ...prev,
          [dimension.key]: toggleValue(
            prev[dimension.key] ?? EMPTY_SELECTION,
            value
          ),
        })),
    };
  });

  const viewColumns: ViewMenuColumn[] = columns.map((column) => ({
    id: column.id,
    label: column.label,
    icon: column.icon,
    visible: !hiddenColumns.has(column.id),
  }));

  const groupByOptions: GroupByOption[] = [
    { value: NO_GROUP, label: "None" },
    ...groupables.map((groupable) => ({
      value: groupable.key,
      label: groupable.label,
    })),
  ];

  const activeGroup = groupables.find((groupable) => groupable.key === groupBy);
  const groups: GridTableGroup<T>[] | undefined = activeGroup
    ? [...new Set(filteredItems.map((item) => activeGroup.value(item)))]
        .sort((a, b) =>
          labelFor(activeGroup, a).localeCompare(labelFor(activeGroup, b))
        )
        .map((value) => ({
          key: `${activeGroup.key}-${value}`,
          label: labelFor(activeGroup, value),
          items: filteredItems.filter(
            (item) => activeGroup.value(item) === value
          ),
        }))
    : undefined;

  return {
    hiddenColumns,
    groupIcon: activeGroup?.icon ?? null,
    filterMenu: { dimensions: filterDimensions },
    viewMenu: {
      columns: viewColumns,
      groupBy,
      groupByOptions,
      onGroupByChange: setGroupBy,
      onToggleColumn: (id: string) =>
        setHiddenColumns((prev) => toggleValue(prev, id)),
      onReset: () => {
        setHiddenColumns(EMPTY_SELECTION);
        setGroupBy(NO_GROUP);
      },
    },
    flatItems: groups ? [] : filteredItems,
    groups,
  };
};
