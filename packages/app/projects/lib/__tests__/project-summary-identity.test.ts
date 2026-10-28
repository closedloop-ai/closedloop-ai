import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import { buildProjectFilterViewModel } from "../project-summary-filter-model";
import type { ProjectSummaryRow } from "../project-summary-row";
import {
  applyProjectGroupValue,
  buildProjectGroups,
  INITIAL_PROJECT_FILTERS,
  matchesProjectFilters,
  ProjectProgressFilter,
  projectProgressLabel,
} from "../project-summary-view";

/**
 * Two facts the fixture hosts could never expose, and production does.
 *
 * The prototype's people had no ids and every project's completion counted
 * "child tasks", so grouping by display name and hardcoding that noun both
 * looked correct. On real records an owner has an id (and two people can share
 * a name) and the population is documents (ISS-4636).
 */

const NOW_MS = Date.UTC(2026, 8, 3);

function row(
  overrides: Partial<ProjectSummaryRow> & Pick<ProjectSummaryRow, "id" | "name">
): ProjectSummaryRow {
  return {
    childTaskCount: null,
    code: null,
    completionPercentage: null,
    dueDateLabel: null,
    dueDateMs: null,
    owner: null,
    priority: null,
    updatedAtMs: NOW_MS,
    updatedLabel: "just now",
    ...overrides,
  };
}

/** Two DIFFERENT people who happen to share a display name. */
const ADA_ONE = { id: "user-1", initials: "AL", name: "Ada Lovelace" };
const ADA_TWO = { id: "user-2", initials: "AL", name: "Ada Lovelace" };

const SAME_NAME_ROWS: ProjectSummaryRow[] = [
  row({ id: "1", name: "Apollo", owner: ADA_ONE }),
  row({ id: "2", name: "Borealis", owner: ADA_TWO }),
];

function ownerGroups(rows: readonly ProjectSummaryRow[]) {
  return buildProjectGroups({
    groupBy: "owner",
    groupOrder: "custom",
    rows,
    secondaryGroupBy: "none",
    secondaryGroupOrder: "custom",
    showEmptyGroups: false,
    showEmptySubgroups: false,
  });
}

describe("owner identity", () => {
  it("keeps two same-named owners in two bands", () => {
    const groups = ownerGroups(SAME_NAME_ROWS);

    expect(groups).toHaveLength(2);
    expect(groups?.map((group) => group.key).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(groups?.every((group) => group.items.length === 1)).toBe(true);
  });

  it("still labels each band with the person's name, not their id", () => {
    expect(ownerGroups(SAME_NAME_ROWS)?.map((group) => group.label)).toEqual([
      "Ada Lovelace",
      "Ada Lovelace",
    ]);
  });

  it("offers two filter options for two same-named owners", () => {
    const options = buildProjectFilterViewModel(SAME_NAME_ROWS).teamMembers;

    expect(options.map((option) => option.id).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("narrows to one of two same-named owners", () => {
    const filters = { ...INITIAL_PROJECT_FILTERS, assigneeIds: ["user-2"] };

    expect(
      SAME_NAME_ROWS.filter((candidate) =>
        matchesProjectFilters(candidate, filters, NOW_MS)
      ).map((candidate) => candidate.name)
    ).toEqual(["Borealis"]);
  });

  it("reassigns a board drop to the band's own owner, not a namesake", () => {
    const moved = applyProjectGroupValue(
      SAME_NAME_ROWS[0] as ProjectSummaryRow,
      "owner",
      "user-2",
      SAME_NAME_ROWS
    );

    expect(moved.owner?.id).toBe("user-2");
  });

  it("falls back to the name for a host whose people have no ids", () => {
    const groups = ownerGroups([
      row({
        id: "1",
        name: "Apollo",
        owner: { initials: "GH", name: "Grace" },
      }),
    ]);

    expect(groups?.[0]?.key).toBe("Grace");
  });
});

describe("the progress filter's vocabulary", () => {
  it("names the population the host's rows declare", () => {
    expect(
      projectProgressLabel(ProjectProgressFilter.NoTasks, "documents")
    ).toBe("No documents");
  });

  it("falls back to child tasks for a host that declares none", () => {
    expect(projectProgressLabel(ProjectProgressFilter.NoTasks)).toBe(
      "No child tasks"
    );
  });

  it("speaks the completion ring's population in the filter option list", () => {
    // The ring reads `completionPopulationLabel`; before ISS-10476's review the
    // filter beside it hardcoded "child tasks", so one screen named the same
    // population two ways at once.
    const options = buildProjectFilterViewModel([
      row({
        completionPopulationLabel: "documents",
        id: "1",
        name: "Apollo",
        priority: Priority.High,
      }),
    ]).statusOptions;

    expect(options.map((option) => option.label)).toContain("No documents");
  });
});
