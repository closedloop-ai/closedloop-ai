"use client";

import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { BotIcon, CircleDotIcon, FolderGitIcon, UserIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  DATE_RANGES,
  type DateRange,
  GroupBy,
  HARNESS_CONFIG,
  type Harness,
  Harness as HarnessEnum,
  SESSION_STATUS_CONFIG,
  type SessionRow,
  type SessionStatus,
  SessionStatus as SessionStatusEnum,
  shortRepoName,
} from "../mock";
import { SessionsFilterMenu } from "./sessions-filter-menu";

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  [GroupBy.None]: "None",
  [GroupBy.Status]: "Status",
  [GroupBy.Harness]: "Harness",
  [GroupBy.Owner]: "Owner",
};

// Labels for the canonical DATE_RANGES ids exported from mock.ts (SSOT) — the
// toolbar maps each id to its display label rather than re-listing the ranges.
const DATE_RANGE_LABELS: Record<DateRange, { label: string; short: string }> = {
  "7d": { label: "Last 7 days", short: "7d" },
  "30d": { label: "Last 30 days", short: "30d" },
  "90d": { label: "Last 90 days", short: "90d" },
  all: { label: "All time", short: "All" },
};

// The toggleable data columns — kept in lockstep with SessionsTable's
// COLUMN_SPECS ids/labels (the fixed lead column is excluded). This is the
// single source for the View menu and the default-visibility set.
export const TOGGLEABLE_COLUMNS: { id: string; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "tags", label: "Tags" },
  { id: "owner", label: "Owner" },
  { id: "collaborators", label: "Collaborators" },
  { id: "autonomy", label: "Autonomy" },
  { id: "projects", label: "Projects" },
  { id: "repo", label: "Repository" },
  { id: "branches", label: "Linked branches" },
  { id: "issues", label: "Linked issues" },
  { id: "agents", label: "Linked agents" },
  { id: "harness", label: "Harness" },
  { id: "model", label: "Model" },
  { id: "duration", label: "Duration" },
  { id: "cost", label: "Cost" },
  { id: "started", label: "Started" },
  { id: "updated", label: "Updated" },
  { id: "lastActivity", label: "Last active" },
];

/** Fallback owner key for a null session owner. */
export const OWNER_UNATTRIBUTED = "Unattributed";

export type SessionFilters = {
  statuses: SessionStatus[];
  harnesses: Harness[];
  owners: string[];
  repos: string[];
};

// One facet group in the Sessions filter menu (Status / Harness / Owner /
// Repository) — an id + label + icon, its options with live counts, and the
// current selection with a toggle. Consumed by `SessionsFilterMenu`.
export type SessionFacetGroup = {
  id: string;
  label: string;
  icon?: ReactNode;
  options: { id: string; label: string; count?: number }[];
  selectedValues: string[];
  onToggle: (value: string) => void;
};

function toggleFacetValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function countBy<T extends string>(
  rows: readonly SessionRow[],
  select: (row: SessionRow) => T
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const row of rows) {
    const key = select(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sessionFilterFacetGroups(
  rows: readonly SessionRow[],
  filters: SessionFilters,
  onChange: (next: SessionFilters) => void
): SessionFacetGroup[] {
  const statusCounts = countBy(rows, (row) => row.status);
  const harnessCounts = countBy(rows, (row) => row.harness);
  const ownerCounts = countBy(
    rows,
    (row) => row.user?.name ?? OWNER_UNATTRIBUTED
  );
  const repoCounts = countBy(rows, (row) =>
    row.repo ? shortRepoName(row.repo) : "No repository"
  );

  return [
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: Object.values(SessionStatusEnum).map((status) => ({
        id: status,
        label: SESSION_STATUS_CONFIG[status].label,
        count: statusCounts.get(status) ?? 0,
      })),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(filters.statuses, value as SessionStatus),
        }),
    },
    {
      id: "harness",
      label: "Harness",
      icon: <BotIcon className="size-4" />,
      options: Object.values(HarnessEnum).map((harness) => ({
        id: harness,
        label: HARNESS_CONFIG[harness].label,
        count: harnessCounts.get(harness) ?? 0,
      })),
      selectedValues: filters.harnesses,
      onToggle: (value) =>
        onChange({
          ...filters,
          harnesses: toggleFacetValue(filters.harnesses, value as Harness),
        }),
    },
    {
      id: "owner",
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: [...ownerCounts.keys()].sort().map((owner) => ({
        id: owner,
        label: owner,
        count: ownerCounts.get(owner) ?? 0,
      })),
      selectedValues: filters.owners,
      onToggle: (value) =>
        onChange({
          ...filters,
          owners: toggleFacetValue(filters.owners, value),
        }),
    },
    {
      id: "repo",
      label: "Repository",
      icon: <FolderGitIcon className="size-4" />,
      options: [...repoCounts.keys()].sort().map((repo) => ({
        id: repo,
        label: repo,
        count: repoCounts.get(repo) ?? 0,
      })),
      selectedValues: filters.repos,
      onToggle: (value) =>
        onChange({ ...filters, repos: toggleFacetValue(filters.repos, value) }),
    },
  ];
}

export function SessionsToolbar({
  dateRange,
  onDateRangeChange,
  filters,
  onFiltersChange,
  rows,
  visibleColumns,
  onToggleColumn,
  groupBy,
  onGroupByChange,
}: {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  filters: SessionFilters;
  onFiltersChange: (next: SessionFilters) => void;
  rows: readonly SessionRow[];
  visibleColumns: Set<string>;
  onToggleColumn: (id: string) => void;
  groupBy: GroupBy;
  onGroupByChange: (value: GroupBy) => void;
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
        {DATE_RANGES.map((id) => (
          <ToggleGroupItem
            aria-label={DATE_RANGE_LABELS[id].label}
            className="px-2.5 data-[variant=outline]:h-[26px]"
            key={id}
            value={id}
          >
            {DATE_RANGE_LABELS[id].short}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <SessionsFilterMenu
        facetGroups={sessionFilterFacetGroups(rows, filters, onFiltersChange)}
      />

      {/* Group-by lives at the top of the View menu (the Project-details
          pattern), not as a standalone toolbar control. */}
      <TableViewMenu
        align="start"
        columns={TOGGLEABLE_COLUMNS.map((column) => ({
          id: column.id,
          label: column.label,
          visible: visibleColumns.has(column.id),
        }))}
        groupByOptions={Object.values(GroupBy).map((value) => ({
          value,
          label: GROUP_BY_LABELS[value],
        }))}
        groupByValue={groupBy}
        onChangeGroupBy={(value) => onGroupByChange(value as GroupBy)}
        onToggleColumn={onToggleColumn}
      />
    </div>
  );
}
