"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { ReadSource } from "@repo/api/src/types/read-source";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import type { ReactNode } from "react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import { ReadSourceBadge } from "../../../shared/components/read-source-badge";
import { useFeatureFlagEnabled } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../../shared/lib/facet-filter";
import {
  READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY,
  SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY,
} from "../../../shared/lib/feature-flags";
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
  /**
   * FEA-3120: which store the current list rows were read from. Rendered as a
   * small badge (behind the read-source-indicator flag) so QA can tell a data
   * bug from a sync gap. Undefined ⇒ no badge (unknown source).
   */
  readSource?: ReadSource;
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
  readSource,
  trailing,
}: SessionsToolbarProps) {
  const changePrFiltersEnabled = useFeatureFlagEnabled(
    SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY
  );
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
          facetGroups: sessionFilterFacetGroups(
            filters,
            onFiltersChange,
            usage,
            {
              includeChangePrFilters: changePrFiltersEnabled,
            }
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

      {readSourceIndicatorEnabled && (
        <ReadSourceBadge readSource={readSource} surfaceLabel="sessions" />
      )}

      {trailing}
    </div>
  );
}
