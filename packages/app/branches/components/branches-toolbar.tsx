"use client";

import type { ReadSource } from "@repo/api/src/types/read-source";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import type { ReactNode } from "react";
import { DateRangeFilter } from "../../shared/components/date-range-filter";
import { ReadSourceBadge } from "../../shared/components/read-source-badge";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../shared/lib/facet-filter";
import { READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  BRANCH_TOGGLEABLE_COLUMNS,
  type BranchColumnId,
} from "../hooks/use-branch-view-state";
import { branchFilterFacetGroups } from "../lib/branch-filter-adapter";
import type { BranchFilters, BranchRow } from "../lib/branch-row";

export type BranchesToolbarProps = {
  filters: BranchFilters;
  onFiltersChange: (next: BranchFilters) => void;
  rows: BranchRow[];
  /** First-class time window — drives the list query AND the summary metrics. */
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  visibleColumns: Set<string>;
  onToggleColumn: (id: BranchColumnId) => void;
  /**
   * FEA-3120: which store the current branch rows were read from. Rendered as a
   * small badge (behind the read-source-indicator flag) so QA can tell a data
   * bug from a sync gap. Undefined ⇒ no badge (unknown source).
   */
  readSource?: ReadSource;
  /** Extra actions render after the built-in controls. */
  trailing?: ReactNode;
};

/**
 * Branches toolbar — a left-aligned time-window + "Filter" + "View" cluster
 * shared by the web `/branches` page and the desktop Branches view. The time
 * window (`DateRangeFilter`) is first-class so it stays visible; "Filter" is the
 * generic `FilterPopover` (Status/Repository facets); "View" is the generic
 * `TableViewMenu` (Show/Hide Columns). Sorting is driven by clickable column
 * headers in `BranchesTable`. View state lives in `useBranchViewState`; filter
 * state in `useBranchFilterState`.
 */
export function BranchesToolbar({
  filters,
  onFiltersChange,
  rows,
  dateRange,
  onDateRangeChange,
  visibleColumns,
  onToggleColumn,
  readSource,
  trailing,
}: BranchesToolbarProps) {
  const readSourceIndicatorEnabled = useFeatureFlagEnabled(
    READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangeFilter onChange={onDateRangeChange} value={dateRange} />

      <FilterPopover
        controller={NOOP_TABLE_FILTERS_CONTROLLER}
        viewModel={{
          teamMembers: [],
          statusOptions: [],
          priorityOptions: [],
          hideQuickToggles: true,
          facetGroups: branchFilterFacetGroups(rows, filters, onFiltersChange),
        }}
      />

      <TableViewMenu
        align="start"
        columns={BRANCH_TOGGLEABLE_COLUMNS.map((column) => ({
          id: column.id,
          label: column.label,
          visible: visibleColumns.has(column.id),
        }))}
        onToggleColumn={(id) => onToggleColumn(id as BranchColumnId)}
      />

      {readSourceIndicatorEnabled && (
        <ReadSourceBadge readSource={readSource} surfaceLabel="branches" />
      )}

      {trailing}
    </div>
  );
}
