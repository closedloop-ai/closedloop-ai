"use client";

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { ComponentProps } from "react";
import { ListSurfaceToolbar } from "../../shared/components/list-surface-toolbar";
import type { ListToolbarSearchControl } from "../../shared/components/list-toolbar-search";
import {
  buildColumnOptions,
  buildToolbarSortGrouping,
  type TableToolbarGroupOrder,
  TableToolbarSavedViewsMenu,
  toggleSetValue,
} from "../../shared/components/table-toolbar-controls";
import { PROJECT_SUMMARY_COLUMNS } from "../lib/project-summary-columns";
import type {
  ProjectFilterController,
  ProjectFilterViewModel,
} from "../lib/project-summary-filter-model";
import type { ProjectLayout } from "../lib/project-summary-view";

type SavedViewsProps = ComponentProps<typeof TableToolbarSavedViewsMenu>;

const NO_CUSTOM_FIELDS: [] = [];

/**
 * ISS-13007: the Projects list header under `gridview-adoption`, handed to the
 * one shared list toolbar. It supplies the Projects fields and state only.
 */
export function ProjectListSharedToolbar({
  filterController,
  filterMenu,
  filterViewModel,
  groupBy,
  groupOrder,
  layout,
  onClearFilters,
  onClearSort,
  onLayoutChange,
  onSort,
  savedViews,
  search,
  secondaryGroupBy,
  secondaryGroupOrder,
  setGroupBy,
  setGroupOrder,
  setSecondaryGroupBy,
  setSecondaryGroupOrder,
  setShowEmptyGroups,
  setShowEmptySubgroups,
  setVisibleColumnIds,
  showEmptyGroups,
  showEmptySubgroups,
  sortActive,
  sortBy,
  visibleColumnIds,
}: {
  filterController: ProjectFilterController;
  filterMenu: { onOpenChange: (open: boolean) => void; open: boolean };
  filterViewModel: ProjectFilterViewModel;
  groupBy: string;
  groupOrder: TableToolbarGroupOrder;
  layout: ProjectLayout;
  onClearFilters: () => void;
  onClearSort: () => void;
  onLayoutChange: (layout: ProjectLayout) => void;
  onSort: (column: string, direction?: SortDirection) => void;
  savedViews: SavedViewsProps;
  search: ListToolbarSearchControl;
  secondaryGroupBy: string;
  secondaryGroupOrder: TableToolbarGroupOrder;
  setGroupBy: (groupBy: string) => void;
  setGroupOrder: (order: TableToolbarGroupOrder) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
  setSecondaryGroupOrder: (order: TableToolbarGroupOrder) => void;
  setShowEmptyGroups: (show: boolean) => void;
  setShowEmptySubgroups: (show: boolean) => void;
  setVisibleColumnIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  sortActive: boolean;
  sortBy: string;
  visibleColumnIds: Set<string>;
}) {
  return (
    <ListSurfaceToolbar
      columns={buildColumnOptions(PROJECT_SUMMARY_COLUMNS, NO_CUSTOM_FIELDS)}
      filterController={filterController}
      filterMenu={filterMenu}
      filterViewModel={filterViewModel}
      framed
      layoutToggle={{
        ariaLabel: PROJECT_LAYOUT_LABEL,
        onChange: onLayoutChange,
        value: layout,
      }}
      onClearFilters={onClearFilters}
      onToggleColumn={(key) => toggleSetValue(setVisibleColumnIds, key)}
      savedViews={<TableToolbarSavedViewsMenu {...savedViews} />}
      search={search}
      sortGrouping={buildToolbarSortGrouping({
        columns: PROJECT_SUMMARY_COLUMNS,
        customFields: NO_CUSTOM_FIELDS,
        groupBy,
        groupOrder,
        leadingLabel: "Project",
        onClearSort,
        onSort,
        secondaryGroupBy,
        secondaryGroupOrder,
        setGroupBy,
        setGroupOrder,
        setSecondaryGroupBy,
        setSecondaryGroupOrder,
        setShowEmptyGroups,
        setShowEmptySubgroups,
        showEmptyGroups,
        showEmptySubgroups,
        sortActive,
        sortBy,
      })}
      visibleColumnIds={visibleColumnIds}
    />
  );
}

/** The accessible name the Projects layout switch has always had. */
export const PROJECT_LAYOUT_LABEL = "Project layout";
