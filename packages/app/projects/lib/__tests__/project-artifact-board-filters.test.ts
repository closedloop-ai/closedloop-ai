import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import {
  DatePreset,
  type TableFilters,
} from "@repo/app/documents/hooks/use-table-filters";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectBoardFilters,
  projectBoardSort,
  useProjectBoardFilters,
} from "../project-artifact-board-filters";

const NONE: TableFilters = {
  assigneeIds: [],
  assignToMe: false,
  date: null,
  favoritesOnly: false,
  hideCompletedItems: false,
  priorities: [],
  statuses: [],
  tagIds: [],
};

const NOW = new Date("2026-10-21T12:00:00.000Z");

describe("ISS-12929 724-F5 project board filters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("narrows nothing when no filter or search is set", () => {
    expect(projectBoardFilters(undefined, "  ", NOW)).toBeUndefined();
    expect(projectBoardFilters(NONE, "", NOW)).toBeUndefined();
  });

  it("resolves a date preset to absolute bounds and drops a half-entered range", () => {
    expect(
      projectBoardFilters(
        {
          ...NONE,
          date: {
            field: ArtifactDateField.UpdatedAt,
            preset: DatePreset.Last7d,
          },
          statuses: [IssueStatus.Todo],
        },
        "",
        NOW
      )
    ).toEqual({
      dateWindow: {
        field: ArtifactDateField.UpdatedAt,
        from: new Date("2026-10-14T12:00:00.000Z"),
        to: NOW,
      },
      statuses: [IssueStatus.Todo],
    });
    expect(
      projectBoardFilters(
        {
          ...NONE,
          date: {
            field: ArtifactDateField.CreatedAt,
            preset: DatePreset.Custom,
            startDate: NOW,
          },
        },
        "",
        NOW
      )
    ).toBeUndefined();
  });

  it("holds one resolved window until the selection changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const filters: TableFilters = {
      ...NONE,
      date: { field: ArtifactDateField.UpdatedAt, preset: DatePreset.Last24h },
    };
    const rendered = renderHook(
      ({ text }) => useProjectBoardFilters(filters, text),
      { initialProps: { text: "" } }
    );
    const first = rendered.result.current;
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    rendered.rerender({ text: "" });
    expect(rendered.result.current).toBe(first);
    rendered.rerender({ text: "apollo" });
    expect(rendered.result.current?.dateWindow?.to).toEqual(
      new Date(NOW.getTime() + 60_000)
    );
  });
});

describe("ISS-12929 724-F5 project board sort", () => {
  it("passes a column sort through and reads stack rank as the manual order", () => {
    expect(projectBoardSort(SortKey.Updated, "desc")).toEqual({
      by: ProjectArtifactBoardSort.Updated,
      direction: ProjectArtifactBoardSortDirection.Desc,
    });
    expect(projectBoardSort(SortKey.StackRank, "desc")).toBeUndefined();
    expect(projectBoardSort(null, "asc")).toBeUndefined();
  });
});
