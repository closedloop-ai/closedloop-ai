"use client";

import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  type BranchRow,
  type DateRange,
  DateRange as DateRangeValue,
} from "../mock";
import { buildBranchFilterFacetGroups } from "./branch-filter-facets";
import type { BranchFilters } from "./branch-list-filter";

const DATE_RANGE_OPTIONS: {
  id: DateRange;
  label: string;
  short: string;
}[] = [
  { id: DateRangeValue.SevenDays, label: "Last 7 days", short: "7d" },
  { id: DateRangeValue.ThirtyDays, label: "Last 30 days", short: "30d" },
  { id: DateRangeValue.NinetyDays, label: "Last 90 days", short: "90d" },
  { id: DateRangeValue.All, label: "All time", short: "All" },
];

export const TOGGLEABLE_COLUMNS: { id: string; label: string }[] = [
  { id: "owner", label: "Owner" },
  { id: "collaborators", label: "Collaborators" },
  { id: "sessions", label: "Linked sessions" },
  { id: "changes", label: "Changes" },
  { id: "status", label: "Status" },
  { id: "pullRequest", label: "Pull request" },
  { id: "lastActivity", label: "Last active" },
  { id: "repo", label: "Repository" },
  { id: "tags", label: "Tags" },
];

type NoopFiltersController = {
  filters: {
    assigneeIds: string[];
    assignToMe: boolean;
    hideCompletedItems: boolean;
    favoritesOnly: boolean;
    statuses: string[];
    priorities: string[];
    date: null;
    tagIds: string[];
  };
  toggleAssignee: (id: string) => void;
  toggleAssignToMe: () => void;
  toggleHideCompletedItems: () => void;
  toggleFavoritesOnly: () => void;
  toggleStatus: (status: string) => void;
  togglePriority: (priority: string) => void;
  setDateFilter: (date: unknown) => void;
  toggleTag: (tagId: string) => void;
  clearCategoryFilter: (category: string) => void;
  clearAllFilters: () => void;
  activeChips: never[];
};

const NOOP = () => undefined;
const NOOP_CONTROLLER: NoopFiltersController = {
  filters: {
    assigneeIds: [],
    assignToMe: false,
    hideCompletedItems: false,
    favoritesOnly: false,
    statuses: [],
    priorities: [],
    date: null,
    tagIds: [],
  },
  toggleAssignee: NOOP,
  toggleAssignToMe: NOOP,
  toggleHideCompletedItems: NOOP,
  toggleFavoritesOnly: NOOP,
  toggleStatus: NOOP,
  togglePriority: NOOP,
  setDateFilter: NOOP,
  toggleTag: NOOP,
  clearCategoryFilter: NOOP,
  clearAllFilters: NOOP,
  activeChips: [],
};

export function BranchesToolbar({
  dateRange,
  onDateRangeChange,
  filters,
  onFiltersChange,
  rows,
  visibleColumns,
  onToggleColumn,
  now,
}: {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  filters: BranchFilters;
  onFiltersChange: (next: BranchFilters) => void;
  rows: readonly BranchRow[];
  visibleColumns: Set<string>;
  onToggleColumn: (id: string) => void;
  now: Date;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        aria-label="Date range"
        onValueChange={(next) => next && onDateRangeChange(next as DateRange)}
        type="single"
        value={dateRange}
        variant="outline"
      >
        {DATE_RANGE_OPTIONS.map((range) => (
          <ToggleGroupItem
            aria-label={range.label}
            className="px-2.5 data-[variant=outline]:h-[26px]"
            key={range.id}
            value={range.id}
          >
            {range.short}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={{
          teamMembers: [],
          statusOptions: [],
          priorityOptions: [],
          hideQuickToggles: true,
          facetGroups: buildBranchFilterFacetGroups(
            rows,
            dateRange,
            filters,
            onFiltersChange,
            now
          ),
        }}
      />

      <TableViewMenu
        align="start"
        columns={TOGGLEABLE_COLUMNS.map((column) => ({
          id: column.id,
          label: column.label,
          visible: visibleColumns.has(column.id),
        }))}
        onToggleColumn={onToggleColumn}
      />
    </div>
  );
}
