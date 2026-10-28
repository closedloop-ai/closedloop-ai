import { BranchSessionPresence } from "@repo/api/src/types/branch";
import type { BranchListFacets } from "@repo/api/src/types/branch-list-contract";
import type { PriorityFilterValue } from "@repo/api/src/types/priority-filter";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import type {
  FilterMenuGroup,
  TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import { compareFacetOptions } from "@repo/lib/branches/branch-list-page";
import { toggleFacetValue } from "../../shared/lib/facet-filter";
import { branchColumnLabel } from "./branch-column-view-model";
import { repositoryDisplayLabels } from "./branch-repository-display-labels";
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
      label: branchColumnLabel("status"),
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
      label: branchColumnLabel("owner"),
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
      label: branchColumnLabel("repo"),
      options: sortedOptions(repositories),
      selectedValues: filters.repos,
      onToggle: (value) =>
        onChange({ ...filters, repos: toggleFacetValue(filters.repos, value) }),
    },
    {
      id: "session",
      label: branchColumnLabel("sessions"),
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
      label: branchColumnLabel("changes"),
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
 * Build approved controls from producer-owned pre-pagination facet counts.
 *
 * `priorityFacetValues` is the priority facet's option list, RESOLVED by the
 * caller (`useBranchToolbarFacetGroups`): the order every priority menu offers
 * (`usePriorityOptions`) and whether "No priority" is offered at all
 * (`ARTIFACT_PRIORITY_UNSET_FLAG_KEY`) are both flag reads, and this module is
 * a plain function that must not read one. An option ARRAY crosses the
 * boundary rather than a boolean, so nothing threads a flag.
 */
export function branchServerFacetGroups(
  facets: BranchListFacets,
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void,
  priorityFacetValues: readonly PriorityFilterValue[]
): FilterMenuGroup[] {
  return [
    serverFacetGroup(
      BranchFilterFacet.Name,
      branchColumnLabel("name"),
      facets.names.options,
      filters.names,
      (values) => onChange({ ...filters, names: values })
    ),
    serverFacetGroup(
      BranchFilterFacet.Owner,
      branchColumnLabel("owner"),
      facets.owners.options,
      filters.owners,
      (values) => onChange({ ...filters, owners: values })
    ),
    serverFacetGroup(
      BranchFilterFacet.Collaborators,
      branchColumnLabel("collaborators"),
      facets.collaborators.options,
      filters.collaborators,
      (values) => onChange({ ...filters, collaborators: values })
    ),
    {
      kind: "range",
      id: BranchFilterFacet.Changes,
      label: branchColumnLabel("changes"),
      min: filters.locMin,
      max: filters.locMax,
      minPlaceholder: "Min",
      maxPlaceholder: "Any",
      onChange: (next) => {
        const { min, max } = clampBranchLocRange(next);
        onChange({ ...filters, locMin: min, locMax: max });
      },
    },
    serverFacetGroup(
      BranchFilterFacet.Status,
      branchColumnLabel("status"),
      facets.statuses.options,
      filters.statuses,
      (values) => onChange({ ...filters, statuses: values })
    ),
    serverFacetGroup(
      BranchFilterFacet.PullRequest,
      branchColumnLabel("pr"),
      facets.pullRequests.options,
      filters.pullRequests,
      (values) => onChange({ ...filters, pullRequests: values })
    ),
    serverFacetGroup(
      BranchFilterFacet.LastActive,
      branchColumnLabel("lastActivity"),
      facets.lastActiveRanges.options,
      filters.lastActiveRanges,
      (values) => onChange({ ...filters, lastActiveRanges: values })
    ),
    serverFacetGroup(
      BranchFilterFacet.Repository,
      branchColumnLabel("repo"),
      facets.repositories.options,
      filters.repos,
      (values) => onChange({ ...filters, repos: values })
    ),
    serverFacetGroup(
      BranchFilterFacet.Tags,
      branchColumnLabel("tags"),
      facets.tags.options,
      filters.tags,
      (values) => onChange({ ...filters, tags: values })
    ),
    // ISS-10332: a fixed-vocabulary facet with NO producer option counts
    // (PLN-2086 Milestone 1 ships none), so its options are the vocabulary the
    // caller resolved rather than a `facets.*` read.
    priorityFacetGroup(filters, onChange, priorityFacetValues),
  ];
}

/**
 * The priority facet, one option per resolved value in the order the caller
 * hands down — the same order the cell's editor offers, unset last when it is
 * offered — each labelled with the word the editor's menu and the group header
 * render for it. Counts are omitted rather than fabricated: this build has no
 * producer-side count for the facet, and a client-side count over one page
 * would answer a question about the whole corpus with a number about this page.
 */
function priorityFacetGroup(
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void,
  priorityFacetValues: readonly PriorityFilterValue[]
): FilterMenuGroup {
  return {
    id: BranchFilterFacet.Priority,
    label: branchColumnLabel("priority"),
    options: priorityFacetValues.map(priorityFilterOption),
    selectedValues: filters.priorities,
    onToggle: (value) =>
      onChange({
        ...filters,
        priorities: toggleFacetValue(filters.priorities, value),
      }),
  };
}

/** One priority facet option, named by its label. */
function priorityFilterOption(value: PriorityFilterValue): TableFilterOption {
  const label = priorityLabel(value === PRIORITY_UNSET_VALUE ? null : value);
  return {
    id: value,
    label,
    searchText: label,
  };
}

function serverFacetGroup(
  id: string,
  label: string,
  options: BranchListFacets["names"]["options"],
  selectedValues: string[],
  onChange: (values: string[]) => void
): FilterMenuGroup {
  return {
    id,
    label,
    options,
    selectedValues,
    onToggle: (value) => onChange(toggleFacetValue(selectedValues, value)),
  };
}

/**
 * Build the approved Branches facets. Each option count applies the current
 * date cohort and every other facet while excluding its own selections.
 */
export function branchFilterFacetGroups(
  rows: BranchRow[],
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void,
  priorityFacetValues: readonly PriorityFilterValue[],
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
      label: branchColumnLabel("name"),
      options: sortedOptions(names),
      selectedValues: filters.names,
      onToggle: (value) =>
        onChange({ ...filters, names: toggleFacetValue(filters.names, value) }),
    },
    {
      id: BranchFilterFacet.Owner,
      label: branchColumnLabel("owner"),
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
      label: branchColumnLabel("collaborators"),
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
      label: branchColumnLabel("changes"),
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
      label: branchColumnLabel("status"),
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
      label: branchColumnLabel("pr"),
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
      label: branchColumnLabel("lastActivity"),
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
      label: branchColumnLabel("repo"),
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
      label: branchColumnLabel("tags"),
      options: sortedOptions(tags, (id) => tagLabel(rows, id)),
      selectedValues: filters.tags,
      onToggle: (value) =>
        onChange({ ...filters, tags: toggleFacetValue(filters.tags, value) }),
    },
    priorityFacetGroup(filters, onChange, priorityFacetValues),
  ];
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

/**
 * ISS-9585: ranked by `compareFacetOptions`, the comparator both Branch list
 * mirrors already share, rather than a third `localeCompare()`. These are the
 * CLIENT-mode owner / repo / tag menus over the same corpus the server-mode
 * menus describe, so a bare locale compare ordered them by the reader's host
 * while the server-mode menus were host-independent.
 */
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
    .sort(compareFacetOptions);
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
