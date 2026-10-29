import { Priority } from "@repo/api/src/types/common";
import {
  type FilterMenuGroup,
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/filter-popover";
import {
  PRIORITY_LABEL_NONE,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import { describe, expect, it, vi } from "vitest";
import {
  ADA,
  makeProjectSummaryRow,
} from "../../__tests__/project-summary-row-fixtures";
import {
  buildProjectColumnFilterGroups,
  buildProjectFilterController,
  buildProjectFilterViewModel,
} from "../project-summary-filter-model";
import type { ProjectSummaryRow } from "../project-summary-row";
import {
  INITIAL_PROJECT_FILTERS,
  NO_PRIORITY_GROUP_KEY,
  ProjectProgressFilter,
  type ProjectSummaryFilters,
} from "../project-summary-view";

const ZOE = { id: "u-zoe", initials: "ZZ", name: "Zoe Zed" };
const ROWS: ProjectSummaryRow[] = [
  makeProjectSummaryRow({ id: "1", name: "One", owner: ZOE }),
  makeProjectSummaryRow({
    completionPopulationLabel: "documents",
    id: "2",
    name: "Two",
    owner: ADA,
  }),
  makeProjectSummaryRow({ id: "3", name: "Three" }),
];
const LAST_7D = {
  field: TableDateFilterField.UpdatedAt,
  preset: TableDatePreset.Last7d,
};

const FACET_IDS = ["owner", "priority", "updated"];

function facet(groups: readonly FilterMenuGroup[], id: string) {
  const group = groups.find((candidate) => candidate.id === id);
  if (!(group && "onToggle" in group)) {
    throw new Error(`no facet group ${id}`);
  }
  return group;
}

function controllerFor(filters: ProjectSummaryFilters, rows = ROWS) {
  let state = filters;
  const setFilters = vi.fn(
    (update: (current: ProjectSummaryFilters) => ProjectSummaryFilters) => {
      state = update(state);
    }
  );
  const controller = buildProjectFilterController(filters, setFilters, rows);
  return { controller, current: () => state, setFilters };
}

describe("buildProjectFilterController chips", () => {
  it("has no chips for the initial filters", () => {
    expect(
      controllerFor(INITIAL_PROJECT_FILTERS).controller.activeChips
    ).toEqual([]);
  });

  it("renders one chip per active category, resolving owner names and the host population", () => {
    const { controller } = controllerFor({
      ...INITIAL_PROJECT_FILTERS,
      assigneeIds: [ADA.id, "u-gone"],
      date: LAST_7D,
      priorities: [Priority.High, NO_PRIORITY_GROUP_KEY],
      statuses: [ProjectProgressFilter.NoTasks, ProjectProgressFilter.Complete],
    });
    expect(controller.activeChips).toEqual([
      { category: "assignee", label: `Owner: ${ADA.name}, u-gone` },
      { category: "status", label: "Progress: No documents, 100% Done" },
      {
        category: "priority",
        label: `Priority: ${priorityLabel(Priority.High)}, ${PRIORITY_LABEL_NONE}`,
      },
      { category: "date", label: "Updated date" },
    ]);
  });

  it("falls back to the default population when no row names one", () => {
    const { controller } = controllerFor(
      { ...INITIAL_PROJECT_FILTERS, statuses: [ProjectProgressFilter.NoTasks] },
      [makeProjectSummaryRow({ id: "x", name: "X" })]
    );
    expect(controller.activeChips).toEqual([
      { category: "status", label: "Progress: No child tasks" },
    ]);
  });
});

describe("buildProjectFilterController actions", () => {
  const ACTIVE: ProjectSummaryFilters = {
    ...INITIAL_PROJECT_FILTERS,
    assigneeIds: [ADA.id],
    date: LAST_7D,
    priorities: [Priority.Low],
    statuses: [ProjectProgressFilter.Complete],
  };

  it("clears everything and single categories", () => {
    const all = controllerFor(ACTIVE);
    all.controller.clearAllFilters();
    expect(all.current()).toBe(INITIAL_PROJECT_FILTERS);

    const one = controllerFor(ACTIVE);
    one.controller.clearCategoryFilter("priority");
    expect(one.current()).toEqual({ ...ACTIVE, priorities: [] });
  });

  it("toggles assignee, priority, status and sets the date", () => {
    const { controller, current } = controllerFor(ACTIVE);
    controller.toggleAssignee(ADA.id);
    controller.togglePriority(Priority.Urgent);
    controller.toggleStatus(ProjectProgressFilter.Complete);
    controller.setDateFilter(null);
    expect(current()).toEqual({
      ...ACTIVE,
      assigneeIds: [],
      date: null,
      priorities: [Priority.Low, Priority.Urgent],
      statuses: [],
    });
  });

  it("makes the unsupported quick toggles no-ops", () => {
    const { controller, setFilters } = controllerFor(ACTIVE);
    controller.toggleAssignToMe();
    controller.toggleFavoritesOnly();
    controller.toggleHideCompletedItems();
    controller.toggleTag("tag-1");
    expect(setFilters).not.toHaveBeenCalled();
  });
});

describe("buildProjectFilterViewModel", () => {
  it("lists owners by name and labels progress with the host population", () => {
    const viewModel = buildProjectFilterViewModel(ROWS);
    expect(viewModel.teamMembers).toEqual([
      { id: ADA.id, label: ADA.name },
      { id: ZOE.id, label: ZOE.name },
    ]);
    expect(viewModel.statusOptions).toContainEqual({
      id: ProjectProgressFilter.NoTasks,
      label: "No documents",
    });
  });
});

describe("buildProjectFilterViewModel date group", () => {
  // The group holds a Created and an Updated item, so naming the group after
  // one of them mislabels it; the popover's own default names the group.
  it("leaves the date group label to the filter popover default", () => {
    const { labels } = buildProjectFilterViewModel(ROWS);

    expect(labels).not.toHaveProperty("dates");
    expect(labels?.updatedDate).toBe("Updated");
  });
});

describe("buildProjectColumnFilterGroups", () => {
  function groupsFor(filters: ProjectSummaryFilters) {
    const harness = controllerFor(filters);
    const groups = buildProjectColumnFilterGroups(
      harness.controller,
      buildProjectFilterViewModel(ROWS)
    );
    return { ...harness, groups };
  }

  it("reflects the selected values of each group", () => {
    const { groups } = groupsFor({
      ...INITIAL_PROJECT_FILTERS,
      assigneeIds: [ADA.id],
      date: LAST_7D,
      priorities: [Priority.Low],
    });
    expect(
      FACET_IDS.map((id) => [id, facet(groups, id).selectedValues])
    ).toEqual([
      ["owner", [ADA.id]],
      ["priority", [Priority.Low]],
      ["updated", [TableDatePreset.Last7d]],
    ]);
  });

  it("selects no date preset when the date filter is off", () => {
    const { groups } = groupsFor(INITIAL_PROJECT_FILTERS);
    expect(facet(groups, "updated").selectedValues).toEqual([]);
  });

  it("sets a new date preset and clears the one already selected", () => {
    const off = groupsFor(INITIAL_PROJECT_FILTERS);
    facet(off.groups, "updated").onToggle(TableDatePreset.Last30d);
    expect(off.current().date).toEqual({
      field: TableDateFilterField.UpdatedAt,
      preset: TableDatePreset.Last30d,
    });

    const on = groupsFor({ ...INITIAL_PROJECT_FILTERS, date: LAST_7D });
    facet(on.groups, "updated").onToggle(TableDatePreset.Last7d);
    expect(on.current().date).toBeNull();
  });

  it("routes a priority toggle to the controller", () => {
    const { current, groups } = groupsFor(INITIAL_PROJECT_FILTERS);
    facet(groups, "priority").onToggle(NO_PRIORITY_GROUP_KEY);
    expect(current().priorities).toEqual([NO_PRIORITY_GROUP_KEY]);
  });
});
