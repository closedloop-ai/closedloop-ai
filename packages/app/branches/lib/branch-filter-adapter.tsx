import { BranchSessionPresence } from "@repo/api/src/types/branch";
import type { FilterMenuGroup } from "@repo/design-system/components/ui/table-filters";
import {
  CircleDotIcon,
  ClockIcon,
  CodeXmlIcon,
  FolderGitIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  TagsIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { toggleFacetValue } from "../../shared/lib/facet-filter";
import {
  BRANCH_STATUS_CONFIG,
  BranchFilterFacet,
  type BranchFilters,
  BranchLastActiveRange,
  BranchPullRequestPresence,
  type BranchRow,
  BranchRowStatus,
  clampBranchLocRange,
  filterBranchRows,
  lastActiveRange,
  shortRepoName,
} from "./branch-row";

/** Prior filter menu retained behind the default-off rollout. */
export function legacyBranchFilterFacetGroups(
  rows: BranchRow[],
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void
): FilterMenuGroup[] {
  const statuses = countOne(rows, (row) => row.status);
  const owners = countOne(rows, (row) => row.owner);
  const repositories = countOne(rows, (row) => shortRepoName(row.repo));
  const sessions = countOne(rows, (row) =>
    row.sessionCount > 0
      ? BranchSessionPresence.Has
      : BranchSessionPresence.None
  );
  return [
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: Object.values(BranchRowStatus).map((status) => ({
        id: status,
        label: BRANCH_STATUS_CONFIG[status].label,
        count: statuses.get(status) ?? 0,
      })),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(filters.statuses, value),
        }),
    },
    {
      id: "owner",
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: sortedOptions(owners),
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
      options: sortedOptions(repositories),
      selectedValues: filters.repos,
      onToggle: (value) =>
        onChange({ ...filters, repos: toggleFacetValue(filters.repos, value) }),
    },
    {
      id: "session",
      label: "Linked Sessions",
      icon: <MessageSquareIcon className="size-4" />,
      options: [
        { id: BranchSessionPresence.Has, label: "Has session" },
        { id: BranchSessionPresence.None, label: "No session" },
      ].map((option) => ({ ...option, count: sessions.get(option.id) ?? 0 })),
      selectedValues: filters.sessionPresence,
      onToggle: (value) =>
        onChange({
          ...filters,
          sessionPresence: toggleFacetValue(filters.sessionPresence, value),
        }),
    },
    {
      kind: "range",
      id: "loc",
      label: "Changes",
      icon: <CodeXmlIcon className="size-4" />,
      min: filters.locMin,
      max: filters.locMax,
      minPlaceholder: "Min",
      maxPlaceholder: "Any",
      onChange: (next) => {
        const { min, max } = clampBranchLocRange(next);
        onChange({ ...filters, locMin: min, locMax: max });
      },
    },
  ];
}

const LAST_ACTIVE_OPTIONS = [
  { id: BranchLastActiveRange.WithinLastHour, label: "Within last hour" },
  { id: BranchLastActiveRange.OneToSixHours, label: "1–6 hours ago" },
  {
    id: BranchLastActiveRange.SevenToTwentyFourHours,
    label: "7–24 hours ago",
  },
  { id: BranchLastActiveRange.OneDayOrMore, label: "1 day or more" },
] as const;

/**
 * Build the approved Branches facets. Each option count applies the current
 * date cohort and every other facet while excluding its own selections.
 */
export function branchFilterFacetGroups(
  rows: BranchRow[],
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void,
  now: number = Date.now()
): FilterMenuGroup[] {
  const names = includeZeroCounts(
    countOne(rows, (row) => row.branchName),
    countOne(
      facetRows(rows, filters, BranchFilterFacet.Name, now),
      (row) => row.branchName
    )
  );
  const owners = includeZeroCounts(
    countOne(rows, (row) => row.ownerKey ?? row.owner),
    countOne(
      facetRows(rows, filters, BranchFilterFacet.Owner, now),
      (row) => row.ownerKey ?? row.owner
    )
  );
  const collaborators = includeZeroCounts(
    countMany(rows, (row) =>
      (row.collaborators ?? []).map((person) => person.key)
    ),
    countMany(
      facetRows(rows, filters, BranchFilterFacet.Collaborators, now),
      (row) => (row.collaborators ?? []).map((person) => person.key)
    )
  );
  const statuses = countOne(
    facetRows(rows, filters, BranchFilterFacet.Status, now),
    (row) => row.status
  );
  const pullRequests = countOne(
    facetRows(rows, filters, BranchFilterFacet.PullRequest, now),
    (row) =>
      row.hasPullRequest || row.prNumber !== null
        ? BranchPullRequestPresence.Linked
        : BranchPullRequestPresence.None
  );
  const activityRows = facetRows(
    rows,
    filters,
    BranchFilterFacet.LastActive,
    now
  );
  const activity = countOptional(activityRows, (row) =>
    lastActiveRange(row.lastActivityAt, now)
  );
  const repositoryRows = facetRows(
    rows,
    filters,
    BranchFilterFacet.Repository,
    now
  );
  const repositories = includeZeroCounts(
    countOne(rows, (row) => row.repo),
    countOne(repositoryRows, (row) => row.repo)
  );
  const repositoryLabels = repositoryDisplayLabels(rows);
  const tagRows = facetRows(rows, filters, BranchFilterFacet.Tags, now);
  const tags = includeZeroCounts(
    countMany(rows, (row) => (row.tags ?? []).map((tag) => tag.id)),
    countMany(tagRows, (row) => (row.tags ?? []).map((tag) => tag.id))
  );

  return [
    {
      id: BranchFilterFacet.Name,
      label: "Name",
      icon: <GitBranchIcon className="size-4" />,
      options: sortedOptions(names),
      selectedValues: filters.names,
      onToggle: (value) =>
        onChange({ ...filters, names: toggleFacetValue(filters.names, value) }),
    },
    {
      id: BranchFilterFacet.Owner,
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: sortedOptions(owners, (key) => ownerLabel(rows, key)),
      selectedValues: filters.owners,
      onToggle: (value) =>
        onChange({
          ...filters,
          owners: toggleFacetValue(filters.owners, value),
        }),
    },
    {
      id: BranchFilterFacet.Collaborators,
      label: "Collaborators",
      icon: <UsersIcon className="size-4" />,
      options: sortedOptions(collaborators, (key) =>
        collaboratorLabel(rows, key)
      ),
      selectedValues: filters.collaborators,
      onToggle: (value) =>
        onChange({
          ...filters,
          collaborators: toggleFacetValue(filters.collaborators, value),
        }),
    },
    {
      kind: "range",
      id: BranchFilterFacet.Changes,
      label: "Changes",
      icon: <CodeXmlIcon className="size-4" />,
      min: filters.locMin,
      max: filters.locMax,
      minPlaceholder: "Min",
      maxPlaceholder: "Any",
      onChange: (next) => {
        const { min, max } = clampBranchLocRange(next);
        onChange({ ...filters, locMin: min, locMax: max });
      },
    },
    {
      id: BranchFilterFacet.Status,
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: Object.values(BranchRowStatus).map((status) => ({
        id: status,
        label: BRANCH_STATUS_CONFIG[status].label,
        count: statuses.get(status) ?? 0,
      })),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(filters.statuses, value),
        }),
    },
    {
      id: BranchFilterFacet.PullRequest,
      label: "Pull request",
      icon: <GitPullRequestIcon className="size-4" />,
      options: [
        {
          id: BranchPullRequestPresence.Linked,
          label: "Linked pull request",
        },
        { id: BranchPullRequestPresence.None, label: "No pull request" },
      ].map((option) => ({
        ...option,
        count: pullRequests.get(option.id) ?? 0,
      })),
      selectedValues: filters.pullRequests,
      onToggle: (value) =>
        onChange({
          ...filters,
          pullRequests: toggleFacetValue(filters.pullRequests, value),
        }),
    },
    {
      id: BranchFilterFacet.LastActive,
      label: "Last active",
      icon: <ClockIcon className="size-4" />,
      options: LAST_ACTIVE_OPTIONS.map((option) => ({
        ...option,
        count: activity.get(option.id) ?? 0,
      })),
      selectedValues: filters.lastActiveRanges,
      onToggle: (value) =>
        onChange({
          ...filters,
          lastActiveRanges: toggleFacetValue(filters.lastActiveRanges, value),
        }),
    },
    {
      id: BranchFilterFacet.Repository,
      label: "Repository",
      icon: <FolderGitIcon className="size-4" />,
      options: sortedOptions(
        repositories,
        (repo) => repositoryLabels.get(repo) ?? repo
      ),
      selectedValues: filters.repos,
      onToggle: (value) =>
        onChange({ ...filters, repos: toggleFacetValue(filters.repos, value) }),
    },
    {
      id: BranchFilterFacet.Tags,
      label: "Tags",
      icon: <TagsIcon className="size-4" />,
      options: sortedOptions(tags, (id) => tagLabel(rows, id)),
      selectedValues: filters.tags,
      onToggle: (value) =>
        onChange({ ...filters, tags: toggleFacetValue(filters.tags, value) }),
    },
  ];
}

/** Full identity is always the key; compact labels are used only if unique. */
export function repositoryDisplayLabels(
  rows: readonly BranchRow[]
): ReadonlyMap<string, string> {
  const fullNamesByShortName = new Map<string, Set<string>>();
  for (const row of rows) {
    const shortName = shortRepoName(row.repo);
    const identities = fullNamesByShortName.get(shortName) ?? new Set<string>();
    identities.add(row.repo);
    fullNamesByShortName.set(shortName, identities);
  }
  return new Map(
    rows.map((row) => {
      const shortName = shortRepoName(row.repo);
      const collides = (fullNamesByShortName.get(shortName)?.size ?? 0) > 1;
      return [row.repo, collides ? row.repo : shortName] as const;
    })
  );
}

function facetRows(
  rows: BranchRow[],
  filters: BranchFilters,
  facet: BranchFilterFacet,
  now: number
): BranchRow[] {
  return filterBranchRows(rows, filters, {
    now,
    omitFacet: facet,
    approved: true,
  });
}

function countOne(
  rows: readonly BranchRow[],
  select: (row: BranchRow) => string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = select(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countOptional(
  rows: readonly BranchRow[],
  select: (row: BranchRow) => string | null
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = select(row);
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
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

function includeZeroCounts(
  universe: ReadonlyMap<string, number>,
  counts: ReadonlyMap<string, number>
): Map<string, number> {
  return new Map(
    [...universe.keys()].map((key) => [key, counts.get(key) ?? 0])
  );
}

function sortedOptions(
  counts: ReadonlyMap<string, number>,
  labelFor: (key: string) => string = (key) => key
) {
  return [...counts.keys()]
    .map((key) => ({
      id: key,
      label: labelFor(key),
      count: counts.get(key) ?? 0,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function ownerLabel(rows: readonly BranchRow[], key: string): string {
  return rows.find((row) => (row.ownerKey ?? row.owner) === key)?.owner ?? key;
}

function collaboratorLabel(rows: readonly BranchRow[], key: string): string {
  for (const row of rows) {
    const person = (row.collaborators ?? []).find(
      (candidate) => candidate.key === key
    );
    if (person) {
      return person.name;
    }
  }
  return key;
}

function tagLabel(rows: readonly BranchRow[], id: string): string {
  for (const row of rows) {
    const tag = (row.tags ?? []).find((candidate) => candidate.id === id);
    if (tag) {
      return tag.name;
    }
  }
  return id;
}
