import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import { describe, expect, it } from "vitest";
import {
  decodeProjectArtifactBoardView,
  parseProjectArtifactBoardView,
  resolveProjectArtifactBoardView,
  serializeProjectArtifactBoardView,
} from "./project-artifact-board-view-state";

const DEFAULT_VIEW: ProjectArtifactBoardView = {
  arrangement: {
    cardFieldIds: ["priority", "owner"],
    collapsedLaneIds: [],
    laneField: ProjectArtifactBoardGroup.Status,
    laneOrder: [],
    layout: ProjectArtifactBoardLayout.List,
    manualOrder: true,
  },
  version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
};

function view(
  layout: ProjectArtifactBoardView["arrangement"]["layout"],
  laneField: ProjectArtifactBoardView["arrangement"]["laneField"]
): ProjectArtifactBoardView {
  return {
    arrangement: {
      ...DEFAULT_VIEW.arrangement,
      laneField,
      layout,
    },
    version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  };
}

describe("CT-09/CT-17 AC-004/AC-009 Project Artifact Board view codec", () => {
  it("migrates the list-only predecessor without inventing optional wire fields", () => {
    const migrated = parseProjectArtifactBoardView(
      {
        columnIds: ["priority"],
        groupBy: ProjectArtifactBoardGroup.Priority,
        layout: ProjectArtifactBoardLayout.Board,
        manualOrdering: false,
      },
      DEFAULT_VIEW
    );

    expect(migrated).toMatchObject({
      arrangement: {
        cardFieldIds: ["priority"],
        laneField: ProjectArtifactBoardGroup.Priority,
        layout: ProjectArtifactBoardLayout.Board,
        manualOrder: false,
      },
      version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
    });
    expect(migrated.arrangement).not.toHaveProperty("secondaryLaneField");
  });

  it.each([
    ["a malformed shape", { arrangement: "board", version: 1 }],
    ["a newer version", { arrangement: DEFAULT_VIEW.arrangement, version: 2 }],
    [
      "an oversized lane collection",
      {
        arrangement: {
          ...DEFAULT_VIEW.arrangement,
          collapsedLaneIds: Array.from({ length: 101 }, (_, index) =>
            String(index)
          ),
        },
        version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
      },
    ],
  ])("refuses %s whole", (_case, candidate) => {
    expect(decodeProjectArtifactBoardView(candidate, DEFAULT_VIEW)).toBeNull();
    expect(parseProjectArtifactBoardView(candidate, DEFAULT_VIEW)).toBe(
      DEFAULT_VIEW
    );
  });

  it("applies URL then saved then persisted then default precedence", () => {
    const persisted = view(
      ProjectArtifactBoardLayout.Board,
      ProjectArtifactBoardGroup.Priority
    );
    const saved = view(
      ProjectArtifactBoardLayout.List,
      ProjectArtifactBoardGroup.Assignee
    );

    expect(
      resolveProjectArtifactBoardView({
        defaults: DEFAULT_VIEW,
        persisted,
        saved,
        url: {
          collapsedLaneIds: ["done"],
          laneField: ProjectArtifactBoardGroup.Status,
          layout: ProjectArtifactBoardLayout.Board,
        },
      }).arrangement
    ).toMatchObject({
      collapsedLaneIds: ["done"],
      laneField: ProjectArtifactBoardGroup.Status,
      layout: ProjectArtifactBoardLayout.Board,
    });
    expect(
      resolveProjectArtifactBoardView({
        defaults: DEFAULT_VIEW,
        persisted,
        saved,
      }).arrangement.laneField
    ).toBe(ProjectArtifactBoardGroup.Assignee);
    expect(
      resolveProjectArtifactBoardView({ defaults: DEFAULT_VIEW, persisted })
        .arrangement.laneField
    ).toBe(ProjectArtifactBoardGroup.Priority);
    expect(resolveProjectArtifactBoardView({ defaults: DEFAULT_VIEW })).toEqual(
      DEFAULT_VIEW
    );
  });

  it("omits an absent secondary lane field instead of serializing null", () => {
    const serialized = serializeProjectArtifactBoardView(DEFAULT_VIEW);
    const parsed: unknown = JSON.parse(serialized);

    expect(parsed).toEqual(DEFAULT_VIEW);
    expect(serialized).not.toContain("secondaryLaneField");
  });

  it("restores share, Back, and reload state without persisting URL axes", () => {
    const persisted = view(
      ProjectArtifactBoardLayout.Board,
      ProjectArtifactBoardGroup.Priority
    );
    const shared = resolveProjectArtifactBoardView({
      defaults: DEFAULT_VIEW,
      persisted,
      url: {
        laneField: ProjectArtifactBoardGroup.Assignee,
        layout: ProjectArtifactBoardLayout.List,
      },
    });
    const afterBack = resolveProjectArtifactBoardView({
      defaults: DEFAULT_VIEW,
      persisted,
    });

    expect(shared.arrangement).toMatchObject({
      laneField: ProjectArtifactBoardGroup.Assignee,
      layout: ProjectArtifactBoardLayout.List,
    });
    expect(afterBack).toEqual(persisted);
    expect(persisted.arrangement).toMatchObject({
      laneField: ProjectArtifactBoardGroup.Priority,
      layout: ProjectArtifactBoardLayout.Board,
    });
  });
});
