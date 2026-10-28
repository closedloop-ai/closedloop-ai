import type { Priority } from "@repo/api/src/types/common";
import type {
  ProjectStatus,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import { comparePriorityValuesForSort } from "@repo/app/shared/lib/priority-sort";
import type { SortConfig } from "@repo/app/shared/lib/table-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFiltersState,
} from "@repo/design-system/components/ui/table-filters";

/**
 * The team Projects list's filtering and sorting model (ISS-9346, PRD-706
 * R10-06) — the production half of what ISS-9345 recomposed the prototype onto.
 *
 * The filter state is the CHAMPION's `TableFiltersState`, not a shape invented
 * here, so the popover this surface renders is the same one Branches, the
 * Agents workspace and Documents render and the categories cannot drift.
 *
 * Filtering is client-side and that is not a shortcut: `useProjectsByTeam`
 * returns the team's whole project list in one response with no cursor or page
 * size, so the rows on screen ARE the population. A "no matching projects"
 * readout here is therefore true of the team, not of a page.
 */

/** The sort columns the header offers. */
export const PROJECT_SORT_COLUMNS = [
  "title",
  "priority",
  "assignee",
  "dueDate",
  "updated",
] as const;

export type ProjectSortColumn = (typeof PROJECT_SORT_COLUMNS)[number];

/**
 * Name then id. Name alone leaves two same-named projects to arrive in
 * whatever order the server returned, which is the thing a tie-break exists to
 * stop.
 */
function byNameThenId(a: ProjectWithDetails, b: ProjectWithDetails): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function byId(a: ProjectWithDetails, b: ProjectWithDetails): number {
  return a.id.localeCompare(b.id);
}

function compareAssigneeNames(
  a: ProjectWithDetails,
  b: ProjectWithDetails
): number {
  const aName = a.assignee ? getUserDisplayName(a.assignee) : "";
  const bName = b.assignee ? getUserDisplayName(b.assignee) : "";
  return aName.localeCompare(bName);
}

/** The shape the list sorts by today: no tie-break, so equal rows are unordered. */
export const PROJECT_SORT_CONFIGS: Record<
  ProjectSortColumn,
  SortConfig<ProjectWithDetails>
> = {
  title: { key: "name", columnType: "string" },
  priority: {
    key: "priority",
    // Directed, because a plain `comparator` is negated wholesale on a
    // descending sort and would float an unset priority to the top.
    directedComparator: (a, b, direction) =>
      comparePriorityValuesForSort(a.priority, b.priority, direction),
  },
  assignee: { key: "assignee", comparator: compareAssigneeNames },
  dueDate: { key: "targetDate", columnType: "date" },
  updated: { key: "updatedAt", columnType: "date" },
};

/**
 * The gated shape: the same primary comparisons, every one of them followed by
 * a deterministic tie-break.
 *
 * Declared as a whole second table rather than by mutating the first, so the
 * flag picks between two complete orderings and neither can half-apply. The
 * tie-break is never negated, so the two directions agree on the order inside a
 * tie.
 */
export const PROJECT_SORT_CONFIGS_DETERMINISTIC: Record<
  ProjectSortColumn,
  SortConfig<ProjectWithDetails>
> = {
  title: { ...PROJECT_SORT_CONFIGS.title, tieBreak: byId },
  priority: { ...PROJECT_SORT_CONFIGS.priority, tieBreak: byNameThenId },
  assignee: { ...PROJECT_SORT_CONFIGS.assignee, tieBreak: byNameThenId },
  dueDate: { ...PROJECT_SORT_CONFIGS.dueDate, tieBreak: byNameThenId },
  updated: { ...PROJECT_SORT_CONFIGS.updated, tieBreak: byNameThenId },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window each preset names, `null` for one that names no relative window.
 *
 * An EXHAUSTIVE `Record`, not a `Partial` one: a preset added to
 * {@link TableDatePreset} fails `tsc` here until somebody rules what it means.
 * A `Partial` lets a new member resolve to `undefined`, which this surface
 * would read as "narrows nothing" — a date filter the user set and the list
 * silently ignored.
 *
 * `Custom` is `null` because this surface cannot produce it: it passes no
 * `datePresets`, so `FilterPopover` renders `DEFAULT_DATE_PRESETS`, which has
 * no `Custom` entry, and its date submenu only ever sets a `field` and a
 * `preset` — never a `startDate` or `endDate`. If one ever arrives it narrows
 * nothing rather than emptying the list.
 */
const DATE_PRESET_WINDOW_MS: Record<TableDatePreset, number | null> = {
  [TableDatePreset.Last24h]: DAY_MS,
  [TableDatePreset.Last7d]: 7 * DAY_MS,
  [TableDatePreset.Last30d]: 30 * DAY_MS,
  [TableDatePreset.Last3m]: 90 * DAY_MS,
  [TableDatePreset.Custom]: null,
};

/** The cutoff a preset names, or `null` where the preset names no window. */
function presetCutoff(preset: TableDatePreset, now: number): number | null {
  const window = DATE_PRESET_WINDOW_MS[preset];
  return window === null ? null : now - window;
}

/**
 * The instant the FILTERED field names on this project, or `null` when it
 * carries none.
 *
 * Reads `date.field` rather than always reaching for `updatedAt`: the menu
 * offers Date Created and Updated as separate children, so narrowing by the
 * field the user did not pick is the UI lying about what the control does.
 *
 * A project with no timestamp is EXCLUDED by an active date filter rather than
 * admitted: "updated in the last 7 days" is a claim, and a row that cannot
 * support it does not belong under it.
 */
function dateFieldMs(
  project: ProjectWithDetails,
  field: TableDateFilterField
): number | null {
  const raw =
    field === TableDateFilterField.CreatedAt
      ? project.createdAt
      : project.updatedAt;
  if (!raw) {
    return null;
  }
  const parsed = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

function matchesDate(
  project: ProjectWithDetails,
  date: TableFiltersState<ProjectStatus, Priority>["date"],
  now: number
): boolean {
  if (!date) {
    return true;
  }
  const filtered = dateFieldMs(project, date.field);
  if (filtered === null) {
    return false;
  }
  const cutoff = presetCutoff(date.preset, now);
  return cutoff === null || filtered >= cutoff;
}

/**
 * What the predicate needs beyond the filters themselves.
 *
 * `currentUserId` is separate from `assigneeIds` because "Assigned to me" is
 * its own toggle in the champion's menu: folding the signed-in user into the
 * id list at the controller would make the chip and the checkbox disagree the
 * moment the user is also picked by name.
 */
export type ProjectFilterContext = {
  /** The instant the relative date presets are measured back from. */
  now: number;
  /** `undefined` while the signed-in user is still unknown. */
  currentUserId: string | undefined;
};

/**
 * Whether the assignee category — the "Assigned to me" toggle OR a named
 * selection — admits this project. The two are OR-ed: picking yourself and
 * picking a teammate shows both, which is what two active chips claim.
 */
function matchesAssignee(
  project: ProjectWithDetails,
  filters: TableFiltersState<ProjectStatus, Priority>,
  currentUserId: string | undefined
): boolean {
  if (!filters.assignToMe && filters.assigneeIds.length === 0) {
    return true;
  }
  const assigneeId = project.assignee?.id;
  if (!assigneeId) {
    return false;
  }
  if (filters.assigneeIds.includes(assigneeId)) {
    return true;
  }
  // An unknown signed-in user cannot match anybody, so the toggle narrows to
  // nothing rather than quietly admitting every project.
  return filters.assignToMe && assigneeId === currentUserId;
}

/**
 * Whether one project survives the active filters.
 *
 * Every category is AND-ed and an empty category narrows nothing, which is the
 * contract the champion's chips describe: a category with no selection is not
 * shown as active, so it must not be filtering.
 */
export function matchesProjectFilters(
  project: ProjectWithDetails,
  filters: TableFiltersState<ProjectStatus, Priority>,
  context: ProjectFilterContext
): boolean {
  const { now, currentUserId } = context;
  if (!matchesAssignee(project, filters, currentUserId)) {
    return false;
  }
  if (filters.priorities.length > 0) {
    const { priority } = project;
    if (!(priority && filters.priorities.includes(priority))) {
      return false;
    }
  }
  if (
    filters.statuses.length > 0 &&
    !filters.statuses.includes(project.status)
  ) {
    return false;
  }
  return matchesDate(project, filters.date, now);
}

/** The projects the active filters admit, in the order they arrived. */
export function filterProjects(
  projects: readonly ProjectWithDetails[],
  filters: TableFiltersState<ProjectStatus, Priority>,
  context: ProjectFilterContext
): ProjectWithDetails[] {
  return projects.filter((project) =>
    matchesProjectFilters(project, filters, context)
  );
}
