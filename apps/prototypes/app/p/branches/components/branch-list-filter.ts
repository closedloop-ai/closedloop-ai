import {
  type BranchRow,
  type BranchStatus,
  type DateRange,
  DateRange as DateRangeValue,
  shortRepoName,
} from "../mock";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const OWNER_UNATTRIBUTED = "unattributed";
export const NO_COLLABORATORS = "none";
export const PullRequestPresence = {
  Linked: "linked",
  None: "none",
} as const;
export type PullRequestPresence =
  (typeof PullRequestPresence)[keyof typeof PullRequestPresence];

export const BranchFilterFacet = {
  Name: "name",
  Status: "status",
  Owner: "owner",
  Collaborators: "collaborators",
  Changes: "changes",
  PullRequests: "pullRequests",
  Activity: "activity",
  Repos: "repos",
  Tags: "tags",
} as const;
export type BranchFilterFacet =
  (typeof BranchFilterFacet)[keyof typeof BranchFilterFacet];

export const ChangesRange = {
  Under100: "under-100",
  Between100And499: "100-499",
  FiveHundredPlus: "500-plus",
} as const;
export type ChangesRange = (typeof ChangesRange)[keyof typeof ChangesRange];

export const ActivityRange = {
  LastHour: "last-hour",
  OneToSixHours: "1-6-hours",
  SevenToTwentyFourHours: "7-24-hours",
  OneDayPlus: "1d-plus",
} as const;
export type ActivityRange = (typeof ActivityRange)[keyof typeof ActivityRange];

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

/** Creates an independent empty filter set for a controlled Branches list. */
export function createDefaultBranchFilters(): BranchFilters {
  return {
    names: [],
    statuses: [],
    owners: [],
    collaborators: [],
    changes: [],
    pullRequests: [],
    activity: [],
    repos: [],
    tags: [],
  };
}

/**
 * Applies the selected row date scope and facets through one shared predicate.
 * Unknown activity timestamps stay visible because excluding them would present
 * missing producer evidence as a known out-of-range result.
 */
export function filterBranchRows(
  rows: readonly BranchRow[],
  dateRange: DateRange,
  filters: BranchFilters,
  now: Date,
  excludedFacet?: BranchFilterFacet
): BranchRow[] {
  return rows.filter(
    (row) =>
      isBranchRowInDateRange(row, dateRange, now) &&
      matchesBranchFilters(row, filters, now, excludedFacet)
  );
}

/** Inclusive row-cohort membership. Metric events use separate half-open windows. */
export function isBranchRowInDateRange(
  row: BranchRow,
  dateRange: DateRange,
  now: Date
): boolean {
  if (dateRange === DateRangeValue.All) {
    return true;
  }
  const timestamp = Date.parse(row.lastActivityAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }
  const end = now.getTime();
  const start = end - daysForRange(dateRange) * DAY_MS;
  return timestamp >= start && timestamp <= end;
}

/** Returns the self-excluding population for one facet. */
export function selfExcludingFacetRows(
  rows: readonly BranchRow[],
  dateRange: DateRange,
  filters: BranchFilters,
  facet: BranchFilterFacet,
  now: Date
): BranchRow[] {
  return filterBranchRows(rows, dateRange, filters, now, facet);
}

export function changesRange(row: BranchRow): ChangesRange | null {
  if (row.additions === null || row.deletions === null) {
    return null;
  }
  const total = row.additions + row.deletions;
  if (total < 100) {
    return ChangesRange.Under100;
  }
  if (total < 500) {
    return ChangesRange.Between100And499;
  }
  return ChangesRange.FiveHundredPlus;
}

export function activityRange(row: BranchRow, now: Date): ActivityRange | null {
  const occurredAt = Date.parse(row.lastActivityAt);
  const age = now.getTime() - occurredAt;
  if (!Number.isFinite(occurredAt) || age < 0) {
    return null;
  }
  if (age < HOUR_MS) {
    return ActivityRange.LastHour;
  }
  if (age < 7 * HOUR_MS) {
    return ActivityRange.OneToSixHours;
  }
  if (age < 24 * HOUR_MS) {
    return ActivityRange.SevenToTwentyFourHours;
  }
  return ActivityRange.OneDayPlus;
}

function matchesBranchFilters(
  row: BranchRow,
  filters: BranchFilters,
  now: Date,
  excludedFacet?: BranchFilterFacet
): boolean {
  return (
    matchesOne(
      filters.names,
      row.branchName,
      excludedFacet,
      BranchFilterFacet.Name
    ) &&
    matchesOne(
      filters.statuses,
      row.status,
      excludedFacet,
      BranchFilterFacet.Status
    ) &&
    matchesOne(
      filters.owners,
      row.owner ?? OWNER_UNATTRIBUTED,
      excludedFacet,
      BranchFilterFacet.Owner
    ) &&
    matchesMany(
      filters.collaborators,
      row.collaborators.length === 0 ? [NO_COLLABORATORS] : row.collaborators,
      excludedFacet,
      BranchFilterFacet.Collaborators
    ) &&
    matchesOne(
      filters.changes,
      changesRange(row),
      excludedFacet,
      BranchFilterFacet.Changes
    ) &&
    matchesOne(
      filters.pullRequests,
      pullRequestPresence(row),
      excludedFacet,
      BranchFilterFacet.PullRequests
    ) &&
    matchesActivityRange(row, filters.activity, now, excludedFacet) &&
    matchesOne(
      filters.repos,
      shortRepoName(row.repo),
      excludedFacet,
      BranchFilterFacet.Repos
    ) &&
    matchesMany(filters.tags, row.tags, excludedFacet, BranchFilterFacet.Tags)
  );
}

function matchesOne<T extends string>(
  selected: readonly T[],
  value: T | null,
  excludedFacet: BranchFilterFacet | undefined,
  facet: BranchFilterFacet
): boolean {
  return (
    excludedFacet === facet ||
    selected.length === 0 ||
    (value !== null && selected.includes(value))
  );
}

/** Uses the canonical PR identity field shared by filtering and sorting. */
export function pullRequestPresence(row: BranchRow): PullRequestPresence {
  return row.prNumber === null
    ? PullRequestPresence.None
    : PullRequestPresence.Linked;
}

function matchesMany(
  selected: readonly string[],
  values: readonly string[],
  excludedFacet: BranchFilterFacet | undefined,
  facet: BranchFilterFacet
): boolean {
  return (
    excludedFacet === facet ||
    selected.length === 0 ||
    values.some((value) => selected.includes(value))
  );
}

function matchesActivityRange(
  row: BranchRow,
  selected: readonly ActivityRange[],
  now: Date,
  excludedFacet: BranchFilterFacet | undefined
): boolean {
  if (excludedFacet === BranchFilterFacet.Activity || selected.length === 0) {
    return true;
  }
  const range = activityRange(row, now);
  return range !== null && selected.includes(range);
}

function daysForRange(
  dateRange: Exclude<DateRange, typeof DateRangeValue.All>
): number {
  if (dateRange === DateRangeValue.SevenDays) {
    return 7;
  }
  if (dateRange === DateRangeValue.ThirtyDays) {
    return 30;
  }
  return 90;
}
