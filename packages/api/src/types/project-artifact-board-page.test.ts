import { describe, expect, it } from "vitest";
import { ArtifactDateField } from "./artifact-date-filter";
import {
  PROJECT_ARTIFACT_BOARD_PAGE_DEFAULT_SIZE,
  PROJECT_ARTIFACT_BOARD_PAGE_MAX_SIZE,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  ProjectArtifactBoardFilterParam,
  ProjectArtifactBoardGroup,
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
  projectArtifactBoardPagePath,
  projectArtifactBoardPageQueryValidator,
  projectArtifactBoardPageResponseValidator,
} from "./project-artifact-board-page";
import { ProjectArtifactPlacementGroupField } from "./project-artifact-placement";

describe("CT-08 board page query contract", () => {
  it("defaults a bounded page size and accepts every canonical grouping", () => {
    for (const groupBy of Object.values(ProjectArtifactBoardGroup)) {
      expect(projectArtifactBoardPageQueryValidator.parse({ groupBy })).toEqual(
        { groupBy, pageSize: PROJECT_ARTIFACT_BOARD_PAGE_DEFAULT_SIZE }
      );
    }
  });

  it("ISS-12929 724-F5 serializes filters as repeated parameters and omits what narrows nothing", () => {
    const path = projectArtifactBoardPagePath("project-1", {
      filters: {
        assigneeIds: ["user-1", PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER],
        dateWindow: {
          field: ArtifactDateField.CreatedAt,
          from: new Date("2026-10-01T00:00:00.000Z"),
          to: new Date("2026-10-02T00:00:00.000Z"),
        },
        favoritesOnly: false,
        search: "  ",
        statuses: ["TODO", "DONE"],
      },
      groupBy: ProjectArtifactBoardGroup.Status,
      pageSize: 10,
    });
    const params = new URL(`http://x${path}`).searchParams;
    expect(params.getAll(ProjectArtifactBoardFilterParam.AssigneeId)).toEqual([
      "user-1",
      PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
    ]);
    expect(params.getAll(ProjectArtifactBoardFilterParam.Status)).toEqual([
      "TODO",
      "DONE",
    ]);
    expect(params.get(ProjectArtifactBoardFilterParam.DateFrom)).toBe(
      "2026-10-01T00:00:00.000Z"
    );
    expect(params.has(ProjectArtifactBoardFilterParam.FavoritesOnly)).toBe(
      false
    );
    expect(params.has(ProjectArtifactBoardFilterParam.Search)).toBe(false);
  });

  it("ISS-12929 724-F5 sends a column sort and leaves stack rank implicit", () => {
    const sorted = new URL(
      `http://x${projectArtifactBoardPagePath("project-1", {
        groupBy: ProjectArtifactBoardGroup.Status,
        pageSize: 10,
        sortBy: ProjectArtifactBoardSort.Title,
        sortDir: ProjectArtifactBoardSortDirection.Desc,
      })}`
    ).searchParams;
    expect(sorted.get("sortBy")).toBe(ProjectArtifactBoardSort.Title);
    expect(sorted.get("sortDir")).toBe(ProjectArtifactBoardSortDirection.Desc);
    const stackRank = new URL(
      `http://x${projectArtifactBoardPagePath("project-1", {
        groupBy: ProjectArtifactBoardGroup.Status,
        pageSize: 10,
        sortBy: ProjectArtifactBoardSort.StackRank,
      })}`
    ).searchParams;
    expect(stackRank.has("sortBy")).toBe(false);
    expect(
      projectArtifactBoardPageQueryValidator.safeParse({
        groupBy: ProjectArtifactBoardGroup.Status,
        sortBy: "colour",
      }).success
    ).toBe(false);
  });

  it("rejects unbounded, malformed, unknown, and fixture-specific inputs", () => {
    expect(
      projectArtifactBoardPageQueryValidator.safeParse({
        groupBy: ProjectArtifactBoardGroup.Status,
        pageSize: PROJECT_ARTIFACT_BOARD_PAGE_MAX_SIZE + 1,
      }).success
    ).toBe(false);
    expect(
      projectArtifactBoardPageQueryValidator.safeParse({
        groupBy: "unknown",
      }).success
    ).toBe(false);
    expect(
      projectArtifactBoardPageQueryValidator.safeParse({
        groupBy: ProjectArtifactBoardGroup.Status,
        fixtureOnly: true,
      }).success
    ).toBe(false);
  });

  it("builds the client request path with an opaque continuation only when present", () => {
    expect(
      projectArtifactBoardPagePath("project-1", {
        groupBy: ProjectArtifactBoardGroup.Status,
        pageSize: 20,
      })
    ).toBe("/projects/project-1/artifacts/board?groupBy=status&pageSize=20");
    expect(
      projectArtifactBoardPagePath("project-1", {
        cursor: "page+two/=",
        groupBy: ProjectArtifactBoardGroup.Status,
        pageSize: 20,
      })
    ).toBe(
      "/projects/project-1/artifacts/board?groupBy=status&pageSize=20&cursor=page%2Btwo%2F%3D"
    );
  });

  it("accepts unknown additive response fields while retaining known data", () => {
    const parsed = projectArtifactBoardPageResponseValidator.parse({
      futureEnvelopeField: true,
      lanes: [],
      populationRevision: "a".repeat(64),
      rootIds: [],
    });
    expect(parsed.rootIds).toEqual([]);
  });

  it("fails closed on an unknown optional policy version", () => {
    const parsed = projectArtifactBoardPageResponseValidator.safeParse({
      lanePolicy: {
        field: ProjectArtifactPlacementGroupField.Status,
        revision: "future",
        version: 2,
      },
      lanes: [],
      populationRevision: "a".repeat(64),
      rootIds: [],
    });
    expect(parsed.success).toBe(false);
  });
});
