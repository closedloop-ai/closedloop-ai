/**
 * Pure view model behind the portable Projects surface: filtering, sorting and
 * the two grouping dimensions. Kept out of the components so both the mock
 * prototype host and the production host order the same rows the same way, and
 * so the date-window filter takes its clock as an argument instead of reading
 * one — a shared module that reads `Date.now()` cannot be pinned by a test and
 * cannot be replayed by a prototype against a fixed fixture date.
 */

import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { comparePriorityValuesForSort } from "@repo/app/shared/lib/priority-sort";
import {
  type SortConfig,
  sortTableData,
} from "@repo/app/shared/lib/table-utils";
import type {
  TableFilterCategory,
  TableFiltersState,
} from "@repo/design-system/components/ui/filter-popover";
import { TableDatePreset } from "@repo/design-system/components/ui/filter-popover";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import {
  PRIORITY_LABEL_NONE,
  PRIORITY_VALUES_HIGHEST_FIRST,
  type PriorityValue,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import { type ProjectSummaryRow, projectOwnerKey } from "./project-summary-row";

export const ProjectProgressFilter = {
  Complete: "COMPLETE",
  InProgress: "IN_PROGRESS",
  NoTasks: "NO_TASKS",
  NotStarted: "NOT_STARTED",
} as const;

export type ProjectProgressFilter =
  (typeof ProjectProgressFilter)[keyof typeof ProjectProgressFilter];

export type ProjectSummaryFilters = TableFiltersState<
  ProjectProgressFilter,
  ProjectPriorityFilterValue
>;

export type ProjectLayout = "board" | "list";
export type ProjectGroupOrder = "asc" | "custom" | "desc";

export const UNOWNED_GROUP_KEY = "Unowned";
/**
 * The unset-priority key, for BOTH the grouping band and the filter option.
 * Re-exported from the canonical filter sentinel rather than re-declared: the
 * two literals were already identical, and a second copy is how they drift.
 */
export const NO_PRIORITY_GROUP_KEY = PRIORITY_UNSET_VALUE;

/**
 * What the Priority filter may hold. Grouping has always given null-priority
 * rows their own band, so a filter that could only name the four real values
 * let the user SEE that band and never narrow to it.
 */
export type ProjectPriorityFilterValue =
  | PriorityValue
  | typeof PRIORITY_UNSET_VALUE;

/**
 * A Projects band. Nested bands — the secondary grouping dimension — ride on the
 * champion grid's own `subgroups`, which it renders as nested list sections
 * (ISS-10478). The alias adds nothing, so the two cannot drift.
 */
export type ProjectSummaryGroup = GridTableV2Group<ProjectSummaryRow>;

export const INITIAL_PROJECT_FILTERS: ProjectSummaryFilters = {
  assigneeIds: [],
  assignToMe: false,
  date: null,
  favoritesOnly: false,
  hideCompletedItems: false,
  priorities: [],
  statuses: [],
  tagIds: [],
};

/**
 * Which progress bucket a row falls in, or `null` when nothing says: a row with
 * no completion percentage is UNKNOWN, not "not started", so a progress filter
 * excludes it rather than claiming it is at zero.
 */
export function projectProgressBucket(
  row: ProjectSummaryRow
): ProjectProgressFilter | null {
  if (row.childTaskCount === 0) {
    return ProjectProgressFilter.NoTasks;
  }
  if (row.completionPercentage === null) {
    return null;
  }
  if (row.completionPercentage === 0) {
    return ProjectProgressFilter.NotStarted;
  }
  if (row.completionPercentage >= 100) {
    return ProjectProgressFilter.Complete;
  }
  return ProjectProgressFilter.InProgress;
}

/**
 * `population` is what the completion percentage counts, in the host's own words
 * ({@link projectCompletionPopulation}). Without it the progress filter said
 * "child tasks" while the completion ring one column over said "documents" —
 * the same fact under two names, both on screen at once.
 */
export function projectProgressLabel(
  progress: ProjectProgressFilter,
  population: string = DEFAULT_PROGRESS_POPULATION
): string {
  if (progress === ProjectProgressFilter.NoTasks) {
    return `No ${population}`;
  }
  if (progress === ProjectProgressFilter.NotStarted) {
    return "Not started";
  }
  if (progress === ProjectProgressFilter.Complete) {
    return "100% Done";
  }
  return "In progress";
}

/** PRD-721: the toolbar's free-text term over the project name. */
export function matchesProjectSearch(
  row: ProjectSummaryRow,
  search: string
): boolean {
  const term = search.trim().toLocaleLowerCase();
  return term === "" || row.name.toLocaleLowerCase().includes(term);
}

export function matchesProjectFilters(
  row: ProjectSummaryRow,
  filters: ProjectSummaryFilters,
  nowMs: number
): boolean {
  if (
    filters.assigneeIds.length > 0 &&
    !filters.assigneeIds.includes(row.owner ? projectOwnerKey(row.owner) : "")
  ) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(row.priority ?? PRIORITY_UNSET_VALUE)
  ) {
    return false;
  }
  if (filters.statuses.length > 0) {
    const bucket = projectProgressBucket(row);
    if (bucket === null || !filters.statuses.includes(bucket)) {
      return false;
    }
  }
  if (filters.date) {
    const cutoff = datePresetCutoff(filters.date.preset, nowMs);
    if (cutoff !== null && (row.updatedAtMs ?? 0) < cutoff) {
      return false;
    }
  }
  return true;
}

/**
 * Sorting runs through the same `sortTableData` the production projects list
 * already uses (ISS-9345, PRD-706 R10-05), not a local comparator. The local
 * one negated its whole result for a descending sort, which negated its
 * SENTINELS too: an unset priority ranked last ascending and first descending,
 * and `dueDateMs ?? Number.MAX_SAFE_INTEGER` floated every undated project
 * above the latest dated one. The directed comparators below return before any
 * negation, so unknown stays at the bottom in both directions, and each config
 * carries a deterministic tie-break so a coarse column does not leave the order
 * inside a tie to whatever the caller filtered last.
 */
export function sortProjects(
  rows: readonly ProjectSummaryRow[],
  sortBy: string,
  sortDir: SortDirection
): ProjectSummaryRow[] {
  if (!isProjectSummarySortColumn(sortBy)) {
    return [...rows];
  }
  return sortTableData(
    [...rows],
    sortBy,
    PROJECT_SUMMARY_SORT_CONFIGS,
    sortDir
  );
}

export function buildProjectGroups(options: {
  rows: readonly ProjectSummaryRow[];
  groupBy: string;
  secondaryGroupBy: string;
  groupOrder: ProjectGroupOrder;
  secondaryGroupOrder: ProjectGroupOrder;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
}): ProjectSummaryGroup[] | undefined {
  const {
    groupBy,
    groupOrder,
    rows,
    secondaryGroupBy,
    secondaryGroupOrder,
    showEmptyGroups,
    showEmptySubgroups,
  } = options;
  if (groupBy === "none") {
    return undefined;
  }
  const primaryGroups = projectGroupDefinitions(groupBy, rows).map(
    (definition) => ({
      ...definition,
      items: rows.filter(
        (row) => projectGroupValue(row, groupBy) === definition.key
      ),
    })
  );
  const visiblePrimary = primaryGroups.filter(
    (group) => showEmptyGroups || group.items.length > 0
  );
  // Subgroup DEFINITIONS come from the whole population, not from the band
  // they sit under: an owner with no project at this priority has to exist as a
  // definition before `showEmptySubgroups` can show it as empty. The ITEMS are
  // still the band's own.
  return orderProjectGroups(visiblePrimary, groupOrder).map((group) => ({
    ...group,
    subgroups:
      secondaryGroupBy === "none"
        ? undefined
        : orderProjectGroups(
            projectGroupDefinitions(secondaryGroupBy, rows)
              .map((definition) => ({
                ...definition,
                items: group.items.filter(
                  (row) =>
                    projectGroupValue(row, secondaryGroupBy) === definition.key
                ),
              }))
              .filter(
                (subgroup) => showEmptySubgroups || subgroup.items.length > 0
              ),
            secondaryGroupOrder
          ),
  }));
}

export function projectGroupValue(
  row: ProjectSummaryRow,
  column: string
): string {
  if (column === "priority") {
    return row.priority ?? NO_PRIORITY_GROUP_KEY;
  }
  return row.owner ? projectOwnerKey(row.owner) : UNOWNED_GROUP_KEY;
}

/**
 * Board drop: rewrite the grouped field so the card stays where it landed. Only
 * the grouping dimensions the surface offers can be reassigned; anything else
 * returns the row untouched rather than inventing a value for it.
 */
export function applyProjectGroupValue(
  row: ProjectSummaryRow,
  column: string,
  value: string | undefined,
  rows: readonly ProjectSummaryRow[]
): ProjectSummaryRow {
  if (!(value && column !== "none")) {
    return row;
  }
  if (column === "priority") {
    if (value === NO_PRIORITY_GROUP_KEY) {
      return { ...row, priority: null };
    }
    const priority = PRIORITY_VALUES_HIGHEST_FIRST.find(
      (candidate) => candidate === value
    );
    return priority ? { ...row, priority } : row;
  }
  if (column === "owner") {
    if (value === UNOWNED_GROUP_KEY) {
      return { ...row, owner: null };
    }
    const owner = rows.find(
      (candidate) =>
        candidate.owner && projectOwnerKey(candidate.owner) === value
    )?.owner;
    return owner ? { ...row, owner } : row;
  }
  return row;
}

export function clearProjectFilter(
  filters: ProjectSummaryFilters,
  category: TableFilterCategory
): ProjectSummaryFilters {
  if (category === "assignee") {
    return { ...filters, assigneeIds: [] };
  }
  if (category === "status") {
    return { ...filters, statuses: [] };
  }
  if (category === "priority") {
    return { ...filters, priorities: [] };
  }
  if (category === "date") {
    return { ...filters, date: null };
  }
  return filters;
}

export function toggleArrayValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

/** Name then id: two projects may share a name, and a tie-break must settle. */
function byNameThenId(a: ProjectSummaryRow, b: ProjectSummaryRow): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** Id alone, for the column whose primary key IS the name. */
function byId(a: ProjectSummaryRow, b: ProjectSummaryRow): number {
  return a.id.localeCompare(b.id);
}

/**
 * Unknown — a null instant — stays at the bottom in both directions, because
 * the return happens before the negation.
 */
function compareInstants(
  left: number | null,
  right: number | null,
  direction: SortDirection
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  const result = left - right;
  return direction === "asc" ? result : -result;
}

const PROJECT_SUMMARY_SORT_CONFIGS = {
  dueDate: {
    key: "dueDateMs",
    directedComparator: (a, b, direction) =>
      compareInstants(a.dueDateMs, b.dueDateMs, direction),
    tieBreak: byNameThenId,
  },
  name: { key: "name", columnType: "string", tieBreak: byId },
  owner: {
    key: "owner",
    // Directed for the reason priority is: an unowned project is an unknown,
    // not an empty string that sorts before "Ada" one way and after "Zoe" the
    // other.
    directedComparator: (a, b, direction) => {
      const left = a.owner?.name;
      const right = b.owner?.name;
      if (!(left || right)) {
        return 0;
      }
      if (!left) {
        return 1;
      }
      if (!right) {
        return -1;
      }
      const result = left.localeCompare(right);
      return direction === "asc" ? result : -result;
    },
    tieBreak: byNameThenId,
  },
  priority: {
    key: "priority",
    directedComparator: (a, b, direction) =>
      comparePriorityValuesForSort(a.priority, b.priority, direction),
    tieBreak: byNameThenId,
  },
  updated: {
    key: "updatedAtMs",
    directedComparator: (a, b, direction) =>
      compareInstants(a.updatedAtMs, b.updatedAtMs, direction),
    tieBreak: byNameThenId,
  },
} as const satisfies Record<string, SortConfig<ProjectSummaryRow>>;

/**
 * The columns this surface sorts. A side inventory of these members is what
 * ISS-9345 removed from the prototype: the sort MENU is built from the column
 * registry, so flipping `sortable` on a column adds an id the model may not
 * know, and {@link sortProjects} hands the rows back untouched for one — never
 * silently ordered by a different column.
 */
export const PROJECT_SUMMARY_SORT_COLUMNS = Object.keys(
  PROJECT_SUMMARY_SORT_CONFIGS
) as (keyof typeof PROJECT_SUMMARY_SORT_CONFIGS)[];

export type ProjectSummarySortColumn =
  (typeof PROJECT_SUMMARY_SORT_COLUMNS)[number];

export function isProjectSummarySortColumn(
  column: string
): column is ProjectSummarySortColumn {
  return Object.hasOwn(PROJECT_SUMMARY_SORT_CONFIGS, column);
}

function projectGroupDefinitions(
  column: string,
  rows: readonly ProjectSummaryRow[]
): { key: string; label: string }[] {
  if (column === "priority") {
    return [
      ...PRIORITY_VALUES_HIGHEST_FIRST.map((priority) => ({
        key: priority as string,
        label: priorityLabel(priority),
      })),
      { key: NO_PRIORITY_GROUP_KEY, label: PRIORITY_LABEL_NONE },
    ];
  }
  // Keyed by identity, LABELLED by name: two people who share a name must stay
  // two bands, and each band still reads as the person rather than as an id.
  const ownerLabels = new Map<string, string>();
  for (const row of rows) {
    ownerLabels.set(
      row.owner ? projectOwnerKey(row.owner) : UNOWNED_GROUP_KEY,
      row.owner?.name ?? UNOWNED_GROUP_KEY
    );
  }
  return [...ownerLabels.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function orderProjectGroups<T extends { label: string }>(
  groups: T[],
  order: ProjectGroupOrder
): T[] {
  if (order === "custom") {
    return groups;
  }
  const direction = order === "asc" ? 1 : -1;
  return [...groups].sort(
    (left, right) => left.label.localeCompare(right.label) * direction
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function datePresetCutoff(
  preset: TableDatePreset,
  nowMs: number
): number | null {
  if (preset === TableDatePreset.Last24h) {
    return nowMs - DAY_MS;
  }
  if (preset === TableDatePreset.Last7d) {
    return nowMs - 7 * DAY_MS;
  }
  if (preset === TableDatePreset.Last30d) {
    return nowMs - 30 * DAY_MS;
  }
  if (preset === TableDatePreset.Last3m) {
    return nowMs - 90 * DAY_MS;
  }
  return null;
}

/**
 * Fallback population for a caller with no row in hand (the filter option list
 * before any project is loaded). Mirrors the row module's own default so the two
 * cannot disagree.
 */
const DEFAULT_PROGRESS_POPULATION = "child tasks";
