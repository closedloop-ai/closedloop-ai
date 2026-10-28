/**
 * Filter controller and view model for the portable Projects surface. Pure, so
 * the toolbar's chips, the popover's options and the row predicate all read one
 * declaration instead of three parallel switches.
 */

import {
  type FilterMenuGroup,
  TableDateFilterField,
  TableDatePreset,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "@repo/design-system/components/ui/filter-popover";
import {
  PRIORITY_LABEL_NONE,
  PRIORITY_VALUES_HIGHEST_FIRST,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import {
  type ProjectSummaryRow,
  projectCompletionPopulation,
  projectOwnerKey,
} from "./project-summary-row";
import {
  clearProjectFilter,
  INITIAL_PROJECT_FILTERS,
  NO_PRIORITY_GROUP_KEY,
  type ProjectPriorityFilterValue,
  ProjectProgressFilter,
  type ProjectSummaryFilters,
  projectProgressLabel,
  toggleArrayValue,
} from "./project-summary-view";

export type ProjectFilterController = TableFiltersController<
  ProjectProgressFilter,
  ProjectPriorityFilterValue
>;

export type ProjectFilterViewModel = TableFiltersViewModel<
  ProjectProgressFilter,
  ProjectPriorityFilterValue
>;

export function buildProjectFilterController(
  filters: ProjectSummaryFilters,
  setFilters: (
    update: (current: ProjectSummaryFilters) => ProjectSummaryFilters
  ) => void,
  rows: readonly ProjectSummaryRow[]
): ProjectFilterController {
  const ownerNames = projectOwnerNamesByKey(rows);
  const population = projectPopulationLabel(rows);
  const activeChips: ProjectFilterController["activeChips"] = [];
  if (filters.assigneeIds.length > 0) {
    // The selected values are owner IDENTITIES (see projectOwnerKey); a chip
    // must still say who, so each is resolved back to the person's name.
    activeChips.push({
      category: "assignee",
      label: `Owner: ${filters.assigneeIds
        .map((key) => ownerNames.get(key) ?? key)
        .join(", ")}`,
    });
  }
  if (filters.statuses.length > 0) {
    activeChips.push({
      category: "status",
      label: `Progress: ${filters.statuses
        .map((status) => projectProgressLabel(status, population))
        .join(", ")}`,
    });
  }
  if (filters.priorities.length > 0) {
    activeChips.push({
      category: "priority",
      label: `Priority: ${filters.priorities
        .map(projectPriorityFilterLabel)
        .join(", ")}`,
    });
  }
  if (filters.date) {
    activeChips.push({ category: "date", label: "Updated date" });
  }
  return {
    activeChips,
    clearAllFilters: () => setFilters(() => INITIAL_PROJECT_FILTERS),
    clearCategoryFilter: (category) =>
      setFilters((current) => clearProjectFilter(current, category)),
    filters,
    setDateFilter: (date) => setFilters((current) => ({ ...current, date })),
    toggleAssignee: (id) =>
      setFilters((current) => ({
        ...current,
        assigneeIds: toggleArrayValue(current.assigneeIds, id),
      })),
    toggleAssignToMe: () => undefined,
    toggleFavoritesOnly: () => undefined,
    toggleHideCompletedItems: () => undefined,
    togglePriority: (priority) =>
      setFilters((current) => ({
        ...current,
        priorities: toggleArrayValue(current.priorities, priority),
      })),
    toggleStatus: (status) =>
      setFilters((current) => ({
        ...current,
        statuses: toggleArrayValue(current.statuses, status),
      })),
    toggleTag: () => undefined,
  };
}

export function buildProjectFilterViewModel(
  rows: readonly ProjectSummaryRow[]
): ProjectFilterViewModel {
  return {
    hideQuickToggles: true,
    labels: {
      assignee: "Owner",
      filterButton: "Filters",
      priority: "Priority",
      status: "Progress",
      updatedDate: "Updated",
    },
    priorityOptions: [
      ...PRIORITY_VALUES_HIGHEST_FIRST.map((priority) => ({
        id: priority,
        label: priorityLabel(priority),
      })),
      // The grouping menu already bands these rows; without this option the
      // user can see the band and cannot narrow to it.
      { id: NO_PRIORITY_GROUP_KEY, label: PRIORITY_LABEL_NONE },
    ],
    showTags: false,
    statusOptions: Object.values(ProjectProgressFilter).map((status) => ({
      id: status,
      label: projectProgressLabel(status, projectPopulationLabel(rows)),
    })),
    teamMembers: [...projectOwnerNamesByKey(rows).entries()]
      .map(([key, name]) => ({ id: key, label: name }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

export function buildProjectColumnFilterGroups(
  controller: ProjectFilterController,
  viewModel: ProjectFilterViewModel
): FilterMenuGroup[] {
  return [
    {
      id: "owner",
      label: "Owner",
      onToggle: controller.toggleAssignee,
      options: viewModel.teamMembers,
      selectedValues: controller.filters.assigneeIds,
    },
    {
      id: "priority",
      label: "Priority",
      onToggle: (value) =>
        controller.togglePriority(value as ProjectPriorityFilterValue),
      options: viewModel.priorityOptions,
      selectedValues: controller.filters.priorities,
    },
    {
      id: "updated",
      label: "Updated",
      onToggle: (value) =>
        controller.setDateFilter(
          controller.filters.date?.preset === value
            ? null
            : {
                field: TableDateFilterField.UpdatedAt,
                preset: value as TableDatePreset,
              }
        ),
      options: [
        { id: TableDatePreset.Last24h, label: "Last 24 hours" },
        { id: TableDatePreset.Last7d, label: "Last 7 days" },
        { id: TableDatePreset.Last30d, label: "Last 30 days" },
        { id: TableDatePreset.Last3m, label: "Last 3 months" },
      ],
      selectedValues: controller.filters.date?.preset
        ? [controller.filters.date.preset]
        : [],
    },
  ];
}

/**
 * Owner identity → display name, for every owner present in these rows. The
 * filter selects identities and renders names, so both halves read this.
 */
function projectOwnerNamesByKey(
  rows: readonly ProjectSummaryRow[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.owner) {
      names.set(projectOwnerKey(row.owner), row.owner.name);
    }
  }
  return names;
}

/**
 * What these rows' completion percentages count, in the host's own words. Read
 * from the rows rather than assumed, so the progress filter names the same
 * population the completion ring beside it does.
 */
function projectPopulationLabel(
  rows: readonly ProjectSummaryRow[]
): string | undefined {
  const withLabel = rows.find((row) => row.completionPopulationLabel);
  return withLabel ? projectCompletionPopulation(withLabel) : undefined;
}

/** Chip text for one selected Priority value, unset included. */
function projectPriorityFilterLabel(value: ProjectPriorityFilterValue): string {
  return value === NO_PRIORITY_GROUP_KEY
    ? PRIORITY_LABEL_NONE
    : priorityLabel(value);
}
