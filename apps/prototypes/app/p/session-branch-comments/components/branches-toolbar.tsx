"use client";

import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  CircleDotIcon,
  ClockIcon,
  CodeXmlIcon,
  FolderGitIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  TagsIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  type BranchStatus,
  BranchStatus as BranchStatusEnum,
  type DateRange,
  shortRepoName,
} from "../mock";

const DATE_RANGES: { id: DateRange; label: string; short: string }[] = [
  { id: "7d", label: "Last 7 days", short: "7d" },
  { id: "30d", label: "Last 30 days", short: "30d" },
  { id: "90d", label: "Last 90 days", short: "90d" },
  { id: "all", label: "All time", short: "All" },
];
const HOURS_AGO_PATTERN = /^(\d+)h ago$/;

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

/** Fallback owner key for a null branch owner (mirrors RENDER_UNATTRIBUTED). */
export const OWNER_UNATTRIBUTED = "unattributed";
export const NO_COLLABORATORS = "none";
export const PullRequestPresence = {
  Linked: "linked",
  None: "none",
} as const;
export type PullRequestPresence =
  (typeof PullRequestPresence)[keyof typeof PullRequestPresence];

export type ChangesRange = "under-100" | "100-499" | "500-plus";
export type ActivityRange =
  | "last-hour"
  | "2-6-hours"
  | "7-24-hours"
  | "1d-plus";

export type BranchFilters = {
  names: string[];
  statuses: BranchStatus[];
  owners: string[];
  collaborators: string[];
  changes: ChangesRange[];
  pullRequests: PullRequestPresence[];
  activity: ActivityRange[];
  repos: string[];
  tags: string[];
};

// Structural shapes matching FilterPopover's `TableFiltersController` /
// `FilterFacetGroup` props. Declared locally so the prototype imports only the
// catalog-listed `filter-popover` component (the types module is not a catalog
// entry); TypeScript checks compatibility structurally at the call site.
type FacetGroup = {
  id: string;
  label: string;
  icon?: ReactNode;
  options: { id: string; label: string; count?: number }[];
  selectedValues: string[];
  onToggle: (value: string) => void;
  submenuClassName?: string;
};

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

// The Branches facet menu drives its own state via `facetGroups`, so the
// built-in assignee/status/priority controller is inert here (mirrors the
// product's NOOP_TABLE_FILTERS_CONTROLLER).
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

function toggleFacetValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function countBy<T extends string>(
  rows: readonly BranchRow[],
  select: (row: BranchRow) => T
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const row of rows) {
    const key = select(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countMany(
  rows: readonly BranchRow[],
  select: (row: BranchRow) => readonly string[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of new Set(select(row))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function changesRange(row: BranchRow): ChangesRange {
  const total = (row.additions ?? 0) + (row.deletions ?? 0);
  if (total < 100) {
    return "under-100";
  }
  if (total < 500) {
    return "100-499";
  }
  return "500-plus";
}

export function activityRange(row: BranchRow): ActivityRange {
  const label = row.lastActivityLabel.toLowerCase();
  const hours = label.match(HOURS_AGO_PATTERN)?.[1];
  if (hours) {
    const value = Number(hours);
    if (value <= 1) {
      return "last-hour";
    }
    if (value <= 6) {
      return "2-6-hours";
    }
    return "7-24-hours";
  }
  return "1d-plus";
}

function branchFilterFacetGroups(
  rows: readonly BranchRow[],
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void
): FacetGroup[] {
  const statusCounts = countBy(rows, (row) => row.status);
  const ownerCounts = countBy(rows, (row) => row.owner ?? OWNER_UNATTRIBUTED);
  const collaboratorCounts = countMany(rows, (row) =>
    row.collaborators.length > 0 ? row.collaborators : [NO_COLLABORATORS]
  );
  const changesCounts = countBy(rows, changesRange);
  const pullRequestCounts = countBy(rows, (row) =>
    row.prUrl ? PullRequestPresence.Linked : PullRequestPresence.None
  );
  const activityCounts = countBy(rows, activityRange);
  const repoCounts = countBy(rows, (row) => shortRepoName(row.repo));
  const tagCounts = countMany(rows, (row) => row.tags);

  return [
    {
      id: "name",
      label: "Name",
      icon: <GitBranchIcon className="size-4" />,
      options: rows.map((row) => ({
        id: row.branchName,
        label: row.branchName,
        count: 1,
      })),
      selectedValues: filters.names,
      onToggle: (value) =>
        onChange({
          ...filters,
          names: toggleFacetValue(filters.names, value),
        }),
      submenuClassName: "w-80",
    },
    {
      id: "owner",
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: [...ownerCounts.keys()].sort().map((owner) => ({
        id: owner,
        label: owner === OWNER_UNATTRIBUTED ? "No owner" : owner,
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
      id: "collaborators",
      label: "Collaborators",
      icon: <UsersIcon className="size-4" />,
      options: [...collaboratorCounts.keys()].sort().map((collaborator) => ({
        id: collaborator,
        label:
          collaborator === NO_COLLABORATORS ? "No collaborators" : collaborator,
        count: collaboratorCounts.get(collaborator) ?? 0,
      })),
      selectedValues: filters.collaborators,
      onToggle: (value) =>
        onChange({
          ...filters,
          collaborators: toggleFacetValue(filters.collaborators, value),
        }),
    },
    {
      id: "changes",
      label: "Changes",
      icon: <CodeXmlIcon className="size-4" />,
      options: [
        { id: "under-100", label: "Under 100 lines" },
        { id: "100-499", label: "100–499 lines" },
        { id: "500-plus", label: "500+ lines" },
      ].map((option) => ({
        ...option,
        count: changesCounts.get(option.id as ChangesRange) ?? 0,
      })),
      selectedValues: filters.changes,
      onToggle: (value) =>
        onChange({
          ...filters,
          changes: toggleFacetValue(filters.changes, value as ChangesRange),
        }),
    },
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: Object.values(BranchStatusEnum).map((status) => ({
        id: status,
        label: BRANCH_STATUS_CONFIG[status].label,
        count: statusCounts.get(status) ?? 0,
      })),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(filters.statuses, value as BranchStatus),
        }),
    },
    {
      id: "pull-request",
      label: "Pull request",
      icon: <GitPullRequestIcon className="size-4" />,
      options: [
        { id: PullRequestPresence.Linked, label: "Linked pull request" },
        { id: PullRequestPresence.None, label: "No pull request" },
      ].map((option) => ({
        ...option,
        count: pullRequestCounts.get(option.id) ?? 0,
      })),
      selectedValues: filters.pullRequests,
      onToggle: (value) =>
        onChange({
          ...filters,
          pullRequests: toggleFacetValue(
            filters.pullRequests,
            value as PullRequestPresence
          ),
        }),
    },
    {
      id: "last-activity",
      label: "Last active",
      icon: <ClockIcon className="size-4" />,
      options: [
        { id: "last-hour", label: "Within the last hour" },
        { id: "2-6-hours", label: "2–6 hours ago" },
        { id: "7-24-hours", label: "7–24 hours ago" },
        { id: "1d-plus", label: "1 day or more" },
      ].map((option) => ({
        ...option,
        count: activityCounts.get(option.id as ActivityRange) ?? 0,
      })),
      selectedValues: filters.activity,
      onToggle: (value) =>
        onChange({
          ...filters,
          activity: toggleFacetValue(filters.activity, value as ActivityRange),
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
    {
      id: "tags",
      label: "Tags",
      icon: <TagsIcon className="size-4" />,
      options: [...tagCounts.keys()].sort().map((tag) => ({
        id: tag,
        label: tag,
        count: tagCounts.get(tag) ?? 0,
      })),
      selectedValues: filters.tags,
      onToggle: (value) =>
        onChange({ ...filters, tags: toggleFacetValue(filters.tags, value) }),
    },
  ];
}

export function BranchesToolbar({
  dateRange,
  onDateRangeChange,
  filters,
  onFiltersChange,
  rows,
  visibleColumns,
  onToggleColumn,
}: {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  filters: BranchFilters;
  onFiltersChange: (next: BranchFilters) => void;
  rows: readonly BranchRow[];
  visibleColumns: Set<string>;
  onToggleColumn: (id: string) => void;
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
        {DATE_RANGES.map((range) => (
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
          facetGroups: branchFilterFacetGroups(rows, filters, onFiltersChange),
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
