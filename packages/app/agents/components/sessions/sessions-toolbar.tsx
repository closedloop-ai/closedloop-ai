"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import type { ReactNode } from "react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../../shared/lib/facet-filter";
import type { DateRange } from "../../../shared/lib/format-utils";
import {
  SESSIONS_TOGGLEABLE_COLUMNS,
  type SessionColumnId,
} from "../../hooks/use-sessions-view-state";
import {
  type SessionFacetFilters,
  sessionFilterFacetGroups,
} from "../../lib/session-filter-adapter";

export type SessionsToolbarProps = {
  filters: SessionFacetFilters;
  onFiltersChange: (next: SessionFacetFilters) => void;
  /** First-class time window — drives the list query AND the summary metrics. */
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  /** Usage summary feeds the Repository facet options (full corpus). */
  usage?: AgentSessionUsageSummary;
  visibleColumns: Set<string>;
  onToggleColumn: (id: SessionColumnId) => void;
  /** Extra actions render after the built-in controls. */
  trailing?: ReactNode;
};

/**
 * Sessions toolbar — a left-aligned time-window + "Filter" + "View" cluster
 * shared by the web `/sessions` page and the desktop Sessions view. The time
 * window (`DateRangeFilter`) is first-class so it stays visible; "Filter" is the
 * generic `FilterPopover` (Status/Repository facets); "View" is the generic
 * `TableViewMenu` (Show/Hide Columns). Sorting is driven by clickable column
 * headers in the table.
 */
export function SessionsToolbar({
  filters,
  onFiltersChange,
  dateRange,
  onDateRangeChange,
  usage,
  visibleColumns,
  onToggleColumn,
  trailing,
}: SessionsToolbarProps) {
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
          facetGroups: sessionFilterFacetGroups(
            filters,
            onFiltersChange,
            usage
          ),
        }}
      />

      <TableViewMenu
        align="start"
        columns={SESSIONS_TOGGLEABLE_COLUMNS.map((column) => ({
          id: column.id,
          label: column.label,
          visible: visibleColumns.has(column.id),
        }))}
        onToggleColumn={(id) => onToggleColumn(id as SessionColumnId)}
      />

      {trailing}
    </div>
  );
}
