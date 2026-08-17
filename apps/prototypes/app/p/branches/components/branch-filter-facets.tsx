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
  BranchStatus as BranchStatusValue,
  type DateRange,
  shortRepoName,
} from "../mock";
import {
  ActivityRange,
  activityRange,
  BranchFilterFacet,
  type BranchFilters,
  ChangesRange,
  changesRange,
  NO_COLLABORATORS,
  OWNER_UNATTRIBUTED,
  PullRequestPresence,
  pullRequestPresence,
  selfExcludingFacetRows,
} from "./branch-list-filter";

export type BranchFacetGroup = {
  id: string;
  label: string;
  icon?: ReactNode;
  options: { id: string; label: string; count?: number }[];
  selectedValues: string[];
  onToggle: (value: string) => void;
  submenuClassName?: string;
};

/** Builds self-excluding facet groups from the shared filtered-row predicate. */
export function buildBranchFilterFacetGroups(
  rows: readonly BranchRow[],
  dateRange: DateRange,
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void,
  now: Date
): BranchFacetGroup[] {
  const population = (facet: BranchFilterFacet) =>
    selfExcludingFacetRows(rows, dateRange, filters, facet, now);
  const nameCounts = countBy(
    population(BranchFilterFacet.Name),
    (row) => row.branchName
  );
  const statusCounts = countBy(
    population(BranchFilterFacet.Status),
    (row) => row.status
  );
  const ownerCounts = countBy(
    population(BranchFilterFacet.Owner),
    (row) => row.owner ?? OWNER_UNATTRIBUTED
  );
  const collaboratorCounts = countMany(
    population(BranchFilterFacet.Collaborators),
    collaboratorValues
  );
  const changesCounts = countBy(
    population(BranchFilterFacet.Changes),
    changesRange
  );
  const pullRequestCounts = countBy(
    population(BranchFilterFacet.PullRequests),
    pullRequestValue
  );
  const activityCounts = countBy(
    population(BranchFilterFacet.Activity),
    (row) => activityRange(row, now)
  );
  const repoCounts = countBy(population(BranchFilterFacet.Repos), (row) =>
    shortRepoName(row.repo)
  );
  const tagCounts = countMany(
    population(BranchFilterFacet.Tags),
    (row) => row.tags
  );

  return [
    {
      id: "name",
      label: "Name",
      icon: <GitBranchIcon className="size-4" />,
      options: unique(rows.map((row) => row.branchName)).map((name) => ({
        id: name,
        label: name,
        count: nameCounts.get(name) ?? 0,
      })),
      selectedValues: filters.names,
      onToggle: (value) =>
        onChange({ ...filters, names: toggleValue(filters.names, value) }),
      // A 20rem nested menu cannot sit beside the 13rem filter panel at the
      // narrow prototype viewport. Keep the searchable name list compact at
      // 390px so Radix can place it on-screen, then restore the wide list once
      // the two-panel pattern has room.
      submenuClassName: "w-40 sm:w-80",
    },
    {
      id: "owner",
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: unique(rows.map((row) => row.owner ?? OWNER_UNATTRIBUTED)).map(
        (owner) => ({
          id: owner,
          label: owner === OWNER_UNATTRIBUTED ? "No owner" : owner,
          count: ownerCounts.get(owner) ?? 0,
        })
      ),
      selectedValues: filters.owners,
      onToggle: (value) =>
        onChange({ ...filters, owners: toggleValue(filters.owners, value) }),
    },
    {
      id: "collaborators",
      label: "Collaborators",
      icon: <UsersIcon className="size-4" />,
      options: unique(rows.flatMap(collaboratorValues)).map((value) => ({
        id: value,
        label: value === NO_COLLABORATORS ? "No collaborators" : value,
        count: collaboratorCounts.get(value) ?? 0,
      })),
      selectedValues: filters.collaborators,
      onToggle: (value) =>
        onChange({
          ...filters,
          collaborators: toggleValue(filters.collaborators, value),
        }),
    },
    {
      id: "changes",
      label: "Changes",
      icon: <CodeXmlIcon className="size-4" />,
      options: [
        { id: ChangesRange.Under100, label: "Under 100 lines" },
        { id: ChangesRange.Between100And499, label: "100–499 lines" },
        { id: ChangesRange.FiveHundredPlus, label: "500+ lines" },
      ].map((option) => ({
        ...option,
        count: changesCounts.get(option.id as ChangesRange) ?? 0,
      })),
      selectedValues: filters.changes,
      onToggle: (value) =>
        onChange({
          ...filters,
          changes: toggleValue(filters.changes, value as ChangesRange),
        }),
    },
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: Object.values(BranchStatusValue).map((status) => ({
        id: status,
        label: BRANCH_STATUS_CONFIG[status].label,
        count: statusCounts.get(status) ?? 0,
      })),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleValue(filters.statuses, value as BranchStatus),
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
          pullRequests: toggleValue(
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
        { id: ActivityRange.LastHour, label: "Within the last hour" },
        { id: ActivityRange.OneToSixHours, label: "1–6 hours ago" },
        {
          id: ActivityRange.SevenToTwentyFourHours,
          label: "7–24 hours ago",
        },
        { id: ActivityRange.OneDayPlus, label: "1 day or more" },
      ].map((option) => ({
        ...option,
        count: activityCounts.get(option.id as ActivityRange) ?? 0,
      })),
      selectedValues: filters.activity,
      onToggle: (value) =>
        onChange({
          ...filters,
          activity: toggleValue(filters.activity, value as ActivityRange),
        }),
    },
    {
      id: "repo",
      label: "Repository",
      icon: <FolderGitIcon className="size-4" />,
      options: unique(rows.map((row) => shortRepoName(row.repo))).map(
        (repo) => ({ id: repo, label: repo, count: repoCounts.get(repo) ?? 0 })
      ),
      selectedValues: filters.repos,
      onToggle: (value) =>
        onChange({ ...filters, repos: toggleValue(filters.repos, value) }),
    },
    {
      id: "tags",
      label: "Tags",
      icon: <TagsIcon className="size-4" />,
      options: unique(rows.flatMap((row) => row.tags)).map((tag) => ({
        id: tag,
        label: tag,
        count: tagCounts.get(tag) ?? 0,
      })),
      selectedValues: filters.tags,
      onToggle: (value) =>
        onChange({ ...filters, tags: toggleValue(filters.tags, value) }),
    },
  ];
}

function countBy<T extends string>(
  rows: readonly BranchRow[],
  select: (row: BranchRow) => T | null
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const row of rows) {
    const key = select(row);
    if (key === null) {
      continue;
    }
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

function collaboratorValues(row: BranchRow): readonly string[] {
  return row.collaborators.length > 0 ? row.collaborators : [NO_COLLABORATORS];
}

function pullRequestValue(row: BranchRow): PullRequestPresence {
  return pullRequestPresence(row);
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
