import { Priority } from "@repo/api/src/types/common";
import {
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/filter-popover";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { describe, expect, it } from "vitest";
import {
  ADA,
  GRACE,
  makeProjectSummaryRow,
} from "../../__tests__/project-summary-row-fixtures";
import { buildProjectFilterViewModel } from "../project-summary-filter-model";
import type { ProjectSummaryRow } from "../project-summary-row";
import {
  applyProjectGroupValue,
  buildProjectGroups,
  clearProjectFilter,
  INITIAL_PROJECT_FILTERS,
  matchesProjectFilters,
  NO_PRIORITY_GROUP_KEY,
  ProjectProgressFilter,
  type ProjectSummaryFilters,
  projectGroupValue,
  projectProgressBucket,
  projectProgressLabel,
  sortProjects,
  toggleArrayValue,
  UNOWNED_GROUP_KEY,
} from "../project-summary-view";

/**
 * ISS-10476 promoted this model out of `apps/prototypes`, where the deleted
 * `project-sort.test.ts` was its only coverage. The contract did not retire with
 * the prototype, so it is pinned here against the promoted module.
 */

const DAY = 24 * 60 * 60 * 1000;

describe("sortProjects keeps unknowns last in BOTH directions", () => {
  const PRIORITY_ROWS: ProjectSummaryRow[] = [
    makeProjectSummaryRow({ id: "unset", name: "Unset" }),
    makeProjectSummaryRow({ id: "low", name: "Low", priority: Priority.Low }),
    makeProjectSummaryRow({
      id: "urgent",
      name: "Urgent",
      priority: Priority.Urgent,
    }),
  ];

  it("does not float an unset priority to the top when sorting descending", () => {
    const ids = sortProjects(PRIORITY_ROWS, "priority", "desc").map(
      (item) => item.id
    );
    expect(ids.at(-1)).toBe("unset");
  });

  it("keeps an unset priority last ascending too", () => {
    const ids = sortProjects(PRIORITY_ROWS, "priority", "asc").map(
      (item) => item.id
    );
    expect(ids.at(-1)).toBe("unset");
  });

  const DUE_ROWS: ProjectSummaryRow[] = [
    makeProjectSummaryRow({ id: "undated", name: "Undated" }),
    makeProjectSummaryRow({ id: "early", name: "Early", dueDateMs: 1000 }),
    makeProjectSummaryRow({ id: "late", name: "Late", dueDateMs: 9000 }),
  ];

  it("does not float an undated project above the latest dated one descending", () => {
    const ids = sortProjects(DUE_ROWS, "dueDate", "desc").map(
      (item) => item.id
    );
    expect(ids).toEqual(["late", "early", "undated"]);
  });

  it("keeps an unowned project after every named owner descending", () => {
    const ownerRows: ProjectSummaryRow[] = [
      makeProjectSummaryRow({ id: "none", name: "None" }),
      makeProjectSummaryRow({ id: "ada", name: "A", owner: ADA }),
      makeProjectSummaryRow({ id: "grace", name: "G", owner: GRACE }),
    ];
    const ids = sortProjects(ownerRows, "owner", "desc").map((item) => item.id);
    expect(ids.at(-1)).toBe("none");
  });
});

describe("buildProjectGroups secondary bands", () => {
  // Ada has an Urgent project and Grace does not. With "show empty subgroups"
  // on, the Urgent band must still offer Grace as an empty band -- her
  // definition cannot come from the band's own rows, because she has none there.
  const ROWS: ProjectSummaryRow[] = [
    makeProjectSummaryRow({
      id: "1",
      name: "Apollo",
      owner: ADA,
      priority: Priority.Urgent,
    }),
    makeProjectSummaryRow({
      id: "2",
      name: "Borealis",
      owner: GRACE,
      priority: Priority.Low,
    }),
  ];

  function urgentSubgroups(showEmptySubgroups: boolean) {
    const groups = buildProjectGroups({
      groupBy: "priority",
      groupOrder: "custom",
      rows: ROWS,
      secondaryGroupBy: "owner",
      secondaryGroupOrder: "asc",
      showEmptyGroups: false,
      showEmptySubgroups,
    });
    const urgent = groups?.find((group) => group.key === Priority.Urgent);
    return urgent?.subgroups ?? [];
  }

  it("offers an owner with no project in this band as an empty subgroup", () => {
    expect(urgentSubgroups(true).map((sub) => sub.label)).toEqual([
      ADA.name,
      GRACE.name,
    ]);
  });

  it("still populates each subgroup from its own band, not the population", () => {
    const ada = urgentSubgroups(true).find((sub) => sub.label === ADA.name);
    const grace = urgentSubgroups(true).find((sub) => sub.label === GRACE.name);
    expect(ada?.items.map((item) => item.id)).toEqual(["1"]);
    expect(grace?.items).toEqual([]);
  });

  it("hides the empty owner band when empty subgroups are off", () => {
    expect(urgentSubgroups(false).map((sub) => sub.label)).toEqual([ADA.name]);
  });
});

describe("the Priority filter can reach the band grouping already shows", () => {
  const ROWS: ProjectSummaryRow[] = [
    makeProjectSummaryRow({ id: "unset", name: "Unset" }),
    makeProjectSummaryRow({
      id: "high",
      name: "High",
      priority: Priority.High,
    }),
  ];

  function matching(priorities: ProjectSummaryFilters["priorities"]) {
    return ROWS.filter((candidate) =>
      matchesProjectFilters(
        candidate,
        { ...INITIAL_PROJECT_FILTERS, priorities },
        0
      )
    ).map((candidate) => candidate.id);
  }

  it("offers No priority as a selectable option", () => {
    const options = buildProjectFilterViewModel(ROWS).priorityOptions;
    expect(options.map((option) => option.id)).toContain(NO_PRIORITY_GROUP_KEY);
  });

  it("narrows to the unset rows when No priority is selected", () => {
    expect(matching([NO_PRIORITY_GROUP_KEY])).toEqual(["unset"]);
  });

  it("still excludes the unset rows when only a real value is selected", () => {
    expect(matching([Priority.High])).toEqual(["high"]);
  });
});

describe("projectProgressBucket", () => {
  it.each([
    [
      { childTaskCount: 0, completionPercentage: 50 },
      ProjectProgressFilter.NoTasks,
    ],
    [{ childTaskCount: 3, completionPercentage: null }, null],
    [
      { childTaskCount: 3, completionPercentage: 0 },
      ProjectProgressFilter.NotStarted,
    ],
    [
      { childTaskCount: 3, completionPercentage: 100 },
      ProjectProgressFilter.Complete,
    ],
    [
      { childTaskCount: 3, completionPercentage: 99.9 },
      ProjectProgressFilter.InProgress,
    ],
  ])("buckets %o as %s", (fields, expected) => {
    expect(
      projectProgressBucket(
        makeProjectSummaryRow({ id: "p", name: "P", ...fields })
      )
    ).toBe(expected);
  });
});

describe("projectProgressLabel", () => {
  it("names the population for the no-tasks bucket", () => {
    expect(projectProgressLabel(ProjectProgressFilter.NoTasks)).toBe(
      "No child tasks"
    );
    expect(
      projectProgressLabel(ProjectProgressFilter.NoTasks, "documents")
    ).toBe("No documents");
  });

  it("labels the other buckets", () => {
    expect(projectProgressLabel(ProjectProgressFilter.NotStarted)).toBe(
      "Not started"
    );
    expect(projectProgressLabel(ProjectProgressFilter.Complete)).toBe(
      "100% Done"
    );
    expect(projectProgressLabel(ProjectProgressFilter.InProgress)).toBe(
      "In progress"
    );
  });
});

describe("matchesProjectFilters", () => {
  const NOW = 1000 * DAY;
  const OWNED = makeProjectSummaryRow({
    childTaskCount: 2,
    completionPercentage: 50,
    id: "owned",
    name: "Owned",
    owner: ADA,
    updatedAtMs: NOW - 2 * DAY,
  });
  const UNOWNED = makeProjectSummaryRow({
    id: "unowned",
    name: "Unowned",
    updatedAtMs: null,
  });

  function matches(
    candidate: ProjectSummaryRow,
    overrides: Partial<ProjectSummaryFilters>
  ) {
    return matchesProjectFilters(
      candidate,
      { ...INITIAL_PROJECT_FILTERS, ...overrides },
      NOW
    );
  }

  it("matches owners by identity and never matches an unowned row", () => {
    expect(matches(OWNED, { assigneeIds: [ADA.id] })).toBe(true);
    expect(matches(OWNED, { assigneeIds: [GRACE.id] })).toBe(false);
    expect(matches(UNOWNED, { assigneeIds: [ADA.id] })).toBe(false);
  });

  it("excludes an unknown-progress row from any progress filter", () => {
    expect(
      matches(OWNED, { statuses: [ProjectProgressFilter.InProgress] })
    ).toBe(true);
    expect(matches(OWNED, { statuses: [ProjectProgressFilter.Complete] })).toBe(
      false
    );
    expect(
      matches(UNOWNED, { statuses: [ProjectProgressFilter.InProgress] })
    ).toBe(false);
  });

  it.each([
    [TableDatePreset.Last24h, false],
    [TableDatePreset.Last7d, true],
    [TableDatePreset.Last30d, true],
    [TableDatePreset.Last3m, true],
  ])("applies the %s window to a row updated two days ago", (preset, kept) => {
    expect(
      matches(OWNED, {
        date: { field: TableDateFilterField.UpdatedAt, preset },
      })
    ).toBe(kept);
  });

  it("uses the exact cutoff for each window", () => {
    const at = (updatedAtMs: number, preset: TableDatePreset) =>
      matches(makeProjectSummaryRow({ id: "x", name: "X", updatedAtMs }), {
        date: { field: TableDateFilterField.UpdatedAt, preset },
      });
    expect(at(NOW - DAY, TableDatePreset.Last24h)).toBe(true);
    expect(at(NOW - DAY - 1, TableDatePreset.Last24h)).toBe(false);
    expect(at(NOW - 7 * DAY, TableDatePreset.Last7d)).toBe(true);
    expect(at(NOW - 7 * DAY - 1, TableDatePreset.Last7d)).toBe(false);
    expect(at(NOW - 30 * DAY, TableDatePreset.Last30d)).toBe(true);
    expect(at(NOW - 30 * DAY - 1, TableDatePreset.Last30d)).toBe(false);
    expect(at(NOW - 90 * DAY, TableDatePreset.Last3m)).toBe(true);
    expect(at(NOW - 90 * DAY - 1, TableDatePreset.Last3m)).toBe(false);
  });

  it("treats a null updated instant as epoch zero inside a window", () => {
    expect(
      matches(UNOWNED, {
        date: {
          field: TableDateFilterField.UpdatedAt,
          preset: TableDatePreset.Last3m,
        },
      })
    ).toBe(false);
  });

  it("keeps every row for the custom preset, which has no cutoff", () => {
    // pins current behavior; looks odd because a Custom date filter is ignored entirely
    expect(
      matches(UNOWNED, {
        date: {
          field: TableDateFilterField.UpdatedAt,
          preset: TableDatePreset.Custom,
        },
      })
    ).toBe(true);
  });
});

describe("sortProjects fallbacks and ties", () => {
  it("returns the rows untouched, as a new array, for an unknown column", () => {
    const rows = [
      makeProjectSummaryRow({ id: "b", name: "B" }),
      makeProjectSummaryRow({ id: "a", name: "A" }),
    ];
    const sorted = sortProjects(rows, "bogus", "asc");
    expect(sorted.map((item) => item.id)).toEqual(["b", "a"]);
    expect(sorted).not.toBe(rows);
  });

  it("sorts by updated with null instants last both ways and name ties", () => {
    const rows = [
      makeProjectSummaryRow({ id: "n1", name: "Zed", updatedAtMs: null }),
      makeProjectSummaryRow({ id: "n2", name: "Amy", updatedAtMs: null }),
      makeProjectSummaryRow({ id: "t2", name: "Beta", updatedAtMs: 5 }),
      makeProjectSummaryRow({ id: "t1", name: "Alpha", updatedAtMs: 5 }),
      makeProjectSummaryRow({ id: "early", name: "Early", updatedAtMs: 1 }),
    ];
    expect(sortProjects(rows, "updated", "asc").map((item) => item.id)).toEqual(
      ["early", "t1", "t2", "n2", "n1"]
    );
    expect(
      sortProjects(rows, "updated", "desc").map((item) => item.id)
    ).toEqual(["t1", "t2", "early", "n2", "n1"]);
  });

  it("puts the dated row first even when it arrives after an undated one", () => {
    const rows = [
      makeProjectSummaryRow({ id: "dated", name: "Dated", dueDateMs: 10 }),
      makeProjectSummaryRow({ id: "undated", name: "Undated" }),
    ];
    expect(sortProjects(rows, "dueDate", "asc").map((item) => item.id)).toEqual(
      ["dated", "undated"]
    );
    expect(
      sortProjects([...rows].reverse(), "dueDate", "asc").map((item) => item.id)
    ).toEqual(["dated", "undated"]);
  });

  it("orders owners ascending with unowned last and same-owner ties by name then id", () => {
    const rows = [
      makeProjectSummaryRow({ id: "none2", name: "Same" }),
      makeProjectSummaryRow({ id: "none1", name: "Same" }),
      makeProjectSummaryRow({ id: "g", name: "G", owner: GRACE }),
      makeProjectSummaryRow({ id: "a2", name: "B", owner: ADA }),
      makeProjectSummaryRow({ id: "a1", name: "A", owner: ADA }),
    ];
    expect(sortProjects(rows, "owner", "asc").map((item) => item.id)).toEqual([
      "a1",
      "a2",
      "g",
      "none1",
      "none2",
    ]);
    expect(sortProjects(rows, "owner", "desc").map((item) => item.id)).toEqual([
      "g",
      "a1",
      "a2",
      "none1",
      "none2",
    ]);
  });

  it("keeps an owned row ahead of an unowned one whichever side it is compared from", () => {
    const owned = makeProjectSummaryRow({ id: "o", name: "O", owner: ADA });
    const unowned = makeProjectSummaryRow({ id: "u", name: "U" });
    expect(
      sortProjects([owned, unowned], "owner", "asc").map((item) => item.id)
    ).toEqual(["o", "u"]);
    expect(
      sortProjects([unowned, owned], "owner", "asc").map((item) => item.id)
    ).toEqual(["o", "u"]);
  });

  it("sorts by name with the id as tie-break", () => {
    const rows = [
      makeProjectSummaryRow({ id: "2", name: "Same" }),
      makeProjectSummaryRow({ id: "1", name: "Same" }),
      makeProjectSummaryRow({ id: "0", name: "Alpha" }),
    ];
    expect(sortProjects(rows, "name", "asc").map((item) => item.id)).toEqual([
      "0",
      "1",
      "2",
    ]);
  });
});

describe("buildProjectGroups", () => {
  const ROWS: ProjectSummaryRow[] = [
    makeProjectSummaryRow({
      id: "1",
      name: "One",
      owner: GRACE,
      priority: Priority.High,
    }),
    makeProjectSummaryRow({ id: "2", name: "Two", owner: ADA }),
    makeProjectSummaryRow({ id: "3", name: "Three" }),
  ];

  function groups(
    overrides: Partial<Parameters<typeof buildProjectGroups>[0]>
  ) {
    return buildProjectGroups({
      groupBy: "owner",
      groupOrder: "custom",
      rows: ROWS,
      secondaryGroupBy: "none",
      secondaryGroupOrder: "custom",
      showEmptyGroups: false,
      showEmptySubgroups: false,
      ...overrides,
    });
  }

  it("returns undefined when grouping is off", () => {
    expect(groups({ groupBy: "none" })).toBeUndefined();
  });

  it("bands owners by label with an Unowned band and no subgroups", () => {
    const result = groups({});
    expect(result?.map((group) => [group.key, group.label])).toEqual([
      [ADA.id, ADA.name],
      [GRACE.id, GRACE.name],
      [UNOWNED_GROUP_KEY, UNOWNED_GROUP_KEY],
    ]);
    expect(result?.[2]?.items.map((item) => item.id)).toEqual(["3"]);
    expect(result?.[0]?.subgroups).toBeUndefined();
  });

  it("orders bands descending by label", () => {
    expect(groups({ groupOrder: "desc" })?.map((group) => group.label)).toEqual(
      [UNOWNED_GROUP_KEY, GRACE.name, ADA.name]
    );
  });

  it("shows empty priority bands only when asked", () => {
    const hidden = groups({ groupBy: "priority" });
    expect(hidden?.map((group) => group.key)).toEqual([
      Priority.High,
      NO_PRIORITY_GROUP_KEY,
    ]);
    const shown = groups({ groupBy: "priority", showEmptyGroups: true });
    expect(shown?.map((group) => group.key)).toEqual([
      Priority.Urgent,
      Priority.High,
      Priority.Medium,
      Priority.Low,
      NO_PRIORITY_GROUP_KEY,
    ]);
    expect(shown?.at(-1)?.label).toBe(PRIORITY_LABEL_NONE);
    expect(shown?.at(-1)?.items.map((item) => item.id)).toEqual(["2", "3"]);
  });

  it("keys an owner without an id by name", () => {
    const named = { initials: "LN", name: "Lin" };
    const result = groups({
      rows: [makeProjectSummaryRow({ id: "9", name: "N", owner: named })],
    });
    expect(result?.map((group) => group.key)).toEqual(["Lin"]);
  });
});

describe("projectGroupValue", () => {
  it("reads priority, falling back to the unset key", () => {
    expect(
      projectGroupValue(
        makeProjectSummaryRow({ id: "a", name: "A", priority: Priority.Low }),
        "priority"
      )
    ).toBe(Priority.Low);
    expect(
      projectGroupValue(
        makeProjectSummaryRow({ id: "a", name: "A" }),
        "priority"
      )
    ).toBe(NO_PRIORITY_GROUP_KEY);
  });

  it("reads the owner key for any other column", () => {
    expect(
      projectGroupValue(
        makeProjectSummaryRow({ id: "a", name: "A", owner: ADA }),
        "owner"
      )
    ).toBe(ADA.id);
    expect(
      projectGroupValue(makeProjectSummaryRow({ id: "a", name: "A" }), "owner")
    ).toBe(UNOWNED_GROUP_KEY);
  });
});

describe("applyProjectGroupValue", () => {
  const TARGET = makeProjectSummaryRow({
    id: "t",
    name: "T",
    owner: ADA,
    priority: Priority.High,
  });
  const POPULATION = [
    TARGET,
    makeProjectSummaryRow({ id: "g", name: "G", owner: GRACE }),
  ];

  it("returns the row itself for a missing value or no grouping", () => {
    expect(
      applyProjectGroupValue(TARGET, "priority", undefined, POPULATION)
    ).toBe(TARGET);
    expect(applyProjectGroupValue(TARGET, "none", "x", POPULATION)).toBe(
      TARGET
    );
    expect(applyProjectGroupValue(TARGET, "updated", "x", POPULATION)).toBe(
      TARGET
    );
  });

  it("rewrites priority, clears it for the unset band, and ignores unknowns", () => {
    expect(
      applyProjectGroupValue(TARGET, "priority", Priority.Low, POPULATION)
        .priority
    ).toBe(Priority.Low);
    expect(
      applyProjectGroupValue(
        TARGET,
        "priority",
        NO_PRIORITY_GROUP_KEY,
        POPULATION
      ).priority
    ).toBeNull();
    expect(
      applyProjectGroupValue(TARGET, "priority", "bogus", POPULATION)
    ).toBe(TARGET);
  });

  it("rewrites owner from the population, clears it for Unowned, and ignores unknowns", () => {
    expect(
      applyProjectGroupValue(TARGET, "owner", GRACE.id, POPULATION).owner
    ).toEqual(GRACE);
    expect(
      applyProjectGroupValue(TARGET, "owner", UNOWNED_GROUP_KEY, POPULATION)
        .owner
    ).toBeNull();
    expect(applyProjectGroupValue(TARGET, "owner", "nobody", POPULATION)).toBe(
      TARGET
    );
  });
});

describe("clearProjectFilter", () => {
  const FULL: ProjectSummaryFilters = {
    ...INITIAL_PROJECT_FILTERS,
    assigneeIds: [ADA.id],
    date: {
      field: TableDateFilterField.UpdatedAt,
      preset: TableDatePreset.Last7d,
    },
    priorities: [Priority.Low],
    statuses: [ProjectProgressFilter.Complete],
  };

  it("clears only the named category", () => {
    expect(clearProjectFilter(FULL, "assignee")).toEqual({
      ...FULL,
      assigneeIds: [],
    });
    expect(clearProjectFilter(FULL, "status")).toEqual({
      ...FULL,
      statuses: [],
    });
    expect(clearProjectFilter(FULL, "priority")).toEqual({
      ...FULL,
      priorities: [],
    });
    expect(clearProjectFilter(FULL, "date")).toEqual({ ...FULL, date: null });
  });

  it("returns the same filters for a category the surface does not own", () => {
    expect(clearProjectFilter(FULL, "tags")).toBe(FULL);
  });
});

describe("toggleArrayValue", () => {
  it("adds a missing value and removes a present one", () => {
    expect(toggleArrayValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleArrayValue(["a", "b"], "a")).toEqual(["b"]);
  });
});
