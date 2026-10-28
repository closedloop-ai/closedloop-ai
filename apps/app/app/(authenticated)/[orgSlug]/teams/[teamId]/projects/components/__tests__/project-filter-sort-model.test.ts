import { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { BasicUser } from "@repo/api/src/types/user";
import { sortTableData } from "@repo/app/shared/lib/table-utils";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFiltersState,
} from "@repo/design-system/components/ui/table-filters";
import { describe, expect, it } from "vitest";
import {
  filterProjects,
  PROJECT_SORT_CONFIGS,
  PROJECT_SORT_CONFIGS_DETERMINISTIC,
} from "../project-filter-sort-model";

/**
 * ISS-9346. Every fixture below carries more than one row per key on the axis
 * under test, and arrives in a different order than the assertion, so a
 * predicate that admitted everything or a comparator that did nothing produces
 * a different answer than the one asserted.
 */

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_FILTERS: TableFiltersState<ProjectStatus, Priority> = {
  assigneeIds: [],
  assignToMe: false,
  date: null,
  favoritesOnly: false,
  hideCompletedItems: false,
  priorities: [],
  statuses: [],
  tagIds: [],
};

function project(
  id: string,
  overrides: Partial<ProjectWithDetails> = {}
): ProjectWithDetails {
  return {
    id,
    name: id,
    status: ProjectStatus.InProgress,
    priority: Priority.Medium,
    updatedAt: new Date(NOW - DAY_MS),
    ...overrides,
  } as ProjectWithDetails;
}

const user = (id: string): BasicUser => ({
  id,
  email: `${id}@example.test`,
  firstName: id,
  lastName: null,
  avatarUrl: null,
});

const ids = (rows: readonly ProjectWithDetails[]): string[] =>
  rows.map((row) => row.id);

const CONTEXT = { currentUserId: "me", now: NOW };

describe("filterProjects", () => {
  it("admits every project when nothing is selected", () => {
    const rows = [project("a"), project("b"), project("c")];

    expect(ids(filterProjects(rows, EMPTY_FILTERS, CONTEXT))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  describe("assignee", () => {
    const rows = [
      project("ada", { assignee: user("ada") }),
      project("nobody"),
      project("mine", { assignee: user("me") }),
    ];

    it("keeps only the selected assignee", () => {
      expect(
        ids(
          filterProjects(
            rows,
            { ...EMPTY_FILTERS, assigneeIds: ["ada"] },
            CONTEXT
          )
        )
      ).toEqual(["ada"]);
    });

    it("keeps only the signed-in user's projects for assign-to-me", () => {
      expect(
        ids(
          filterProjects(rows, { ...EMPTY_FILTERS, assignToMe: true }, CONTEXT)
        )
      ).toEqual(["mine"]);
    });

    /** Two active chips claim two selections, so the two are OR-ed. */
    it("unions assign-to-me with a named selection", () => {
      expect(
        ids(
          filterProjects(
            rows,
            { ...EMPTY_FILTERS, assigneeIds: ["ada"], assignToMe: true },
            CONTEXT
          )
        )
      ).toEqual(["ada", "mine"]);
    });

    /**
     * The toggle must narrow to nothing rather than quietly admit everything
     * while the signed-in user is still loading.
     */
    it("matches nobody when the signed-in user is unknown", () => {
      expect(
        ids(
          filterProjects(
            rows,
            { ...EMPTY_FILTERS, assignToMe: true },
            { currentUserId: undefined, now: NOW }
          )
        )
      ).toEqual([]);
    });
  });

  it("keeps only the selected priorities", () => {
    const rows = [
      project("u", { priority: Priority.Urgent }),
      project("l", { priority: Priority.Low }),
      project("h", { priority: Priority.High }),
      project("none", { priority: null }),
    ];

    expect(
      ids(
        filterProjects(
          rows,
          { ...EMPTY_FILTERS, priorities: [Priority.Urgent, Priority.High] },
          CONTEXT
        )
      )
    ).toEqual(["u", "h"]);
  });

  it("keeps only the selected statuses", () => {
    const rows = [
      project("active", { status: ProjectStatus.InProgress }),
      project("archived", { status: ProjectStatus.Archived }),
      project("active2", { status: ProjectStatus.InProgress }),
    ];

    expect(
      ids(
        filterProjects(
          rows,
          { ...EMPTY_FILTERS, statuses: [ProjectStatus.Archived] },
          CONTEXT
        )
      )
    ).toEqual(["archived"]);
  });

  describe("the updated date window", () => {
    const rows = [
      // A serialized timestamp, because the wire hands this field back as a
      // string even though the type says `Date` — the parse branch is reachable.
      project("fresh", {
        updatedAt: new Date(NOW - DAY_MS).toISOString() as unknown as Date,
      }),
      project("stale", { updatedAt: new Date(NOW - 40 * DAY_MS) }),
      project("undated", { updatedAt: undefined }),
    ];

    it("keeps only rows inside a preset window", () => {
      expect(
        ids(
          filterProjects(
            rows,
            {
              ...EMPTY_FILTERS,
              date: {
                field: TableDateFilterField.UpdatedAt,
                preset: TableDatePreset.Last7d,
              },
            },
            CONTEXT
          )
        )
      ).toEqual(["fresh"]);
    });

    /**
     * "Updated in the last 7 days" is a claim. A row with no timestamp cannot
     * support it, so it is excluded rather than admitted.
     */
    it("excludes a row with no timestamp", () => {
      const kept = ids(
        filterProjects(
          rows,
          {
            ...EMPTY_FILTERS,
            date: {
              field: TableDateFilterField.UpdatedAt,
              preset: TableDatePreset.Last3m,
            },
          },
          CONTEXT
        )
      );

      expect(kept).toContain("stale");
      expect(kept).not.toContain("undated");
    });

    /**
     * `Custom` is not reachable from this surface — it passes no `datePresets`,
     * so the menu renders `DEFAULT_DATE_PRESETS`, which has no `Custom` entry.
     * The explicit start/end branch that used to answer it is gone with the
     * state it covered (ISS-9346 review, tamsinb).
     *
     * What survives is the RULING the exhaustive `DATE_PRESET_WINDOW_MS` now
     * forces somebody to make about every preset: `Custom` maps to `null`, so a
     * value arriving from anywhere narrows nothing rather than emptying a list
     * that has fifty matching projects in it. That default is one map entry, not
     * a branch, and this pins it.
     */
    it("narrows nothing for a preset that names no window", () => {
      expect(
        ids(
          filterProjects(
            rows,
            {
              ...EMPTY_FILTERS,
              date: {
                field: TableDateFilterField.UpdatedAt,
                preset: TableDatePreset.Custom,
              },
            },
            CONTEXT
          )
        )
      ).toEqual(["fresh", "stale"]);
    });
  });

  it("ANDs categories rather than unioning them", () => {
    const rows = [
      project("both", {
        priority: Priority.Urgent,
        status: ProjectStatus.InProgress,
      }),
      project("priority-only", {
        priority: Priority.Urgent,
        status: ProjectStatus.Archived,
      }),
      project("status-only", {
        priority: Priority.Low,
        status: ProjectStatus.InProgress,
      }),
    ];

    expect(
      ids(
        filterProjects(
          rows,
          {
            ...EMPTY_FILTERS,
            priorities: [Priority.Urgent],
            statuses: [ProjectStatus.InProgress],
          },
          CONTEXT
        )
      )
    ).toEqual(["both"]);
  });
});

describe("PRD-721 AC-5 / DT-FS-08 deterministic sort configs", () => {
  const tied = [
    project("p3", { name: "carol", priority: Priority.High }),
    project("p1", { name: "alice", priority: Priority.High }),
    project("p2", { name: "bob", priority: Priority.High }),
  ];

  const names = (rows: readonly ProjectWithDetails[]): string[] =>
    rows.map((row) => row.name);

  it("orders rows that tie on the sorted column", () => {
    expect(
      names(
        sortTableData(
          tied,
          "priority",
          PROJECT_SORT_CONFIGS_DETERMINISTIC,
          "asc"
        )
      )
    ).toEqual(["alice", "bob", "carol"]);
  });

  it("keeps that same order descending", () => {
    expect(
      names(
        sortTableData(
          tied,
          "priority",
          PROJECT_SORT_CONFIGS_DETERMINISTIC,
          "desc"
        )
      )
    ).toEqual(["alice", "bob", "carol"]);
  });

  /**
   * The flag-off shape, asserted so the swap is a real difference rather than
   * two names for one ordering. Without a tie-break the stable sort hands the
   * caller's order straight back.
   */
  it("differs from the shipped configs, which leave a tie in input order", () => {
    expect(
      names(sortTableData(tied, "priority", PROJECT_SORT_CONFIGS, "asc"))
    ).toEqual(["carol", "alice", "bob"]);
  });

  it("still orders the primary comparison by priority rank", () => {
    const ranked = [
      project("m", { name: "m", priority: Priority.Medium }),
      project("u", { name: "u", priority: Priority.Urgent }),
      project("l", { name: "l", priority: Priority.Low }),
    ];

    expect(
      names(
        sortTableData(
          ranked,
          "priority",
          PROJECT_SORT_CONFIGS_DETERMINISTIC,
          "asc"
        )
      )
    ).toEqual(["u", "m", "l"]);
  });
});
