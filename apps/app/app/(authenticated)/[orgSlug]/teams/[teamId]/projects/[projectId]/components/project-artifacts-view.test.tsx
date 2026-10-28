import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
} from "@repo/api/src/types/project-artifact-board-view";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectArtifactsView } from "./project-artifacts-view";

const mocks = vi.hoisted(() => ({
  board: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@repo/app/projects/components/project-artifact-board-surface", () => ({
  ProjectArtifactBoardSurface: (props: unknown) => {
    mocks.board(props);
    return <div data-testid="artifact-board" />;
  },
}));

vi.mock("@repo/app/documents/components/table/documents-view", () => ({
  DocumentsView: (props: unknown) => {
    mocks.list(props);
    return <div data-testid="artifact-list" />;
  },
}));

const boardProps = {
  boardView: {
    arrangement: {
      cardFieldIds: [],
      collapsedLaneIds: [],
      laneField: ProjectArtifactBoardGroup.Status,
      laneOrder: [],
      layout: ProjectArtifactBoardLayout.Board,
      manualOrder: true,
    },
    version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  },
  editHandlers: {},
  filterText: "",
  groupBy: GroupByMode.Status,
  project: { id: "project-1", name: "Apollo" },
  projectId: "project-1",
  teamId: "team-1",
};

const documentsViewProps = {
  documents: [],
  filterCategory: "all" as const,
  filterText: "",
  projectId: "project-1",
  teamId: "team-1",
  visibleColumns: [],
};

describe("CT-06 Project Detail production adoption", () => {
  beforeEach(() => {
    mocks.board.mockClear();
    mocks.list.mockClear();
  });

  it("mounts the champion with the production adapter when rollout selects board", () => {
    render(
      <ProjectArtifactsView
        boardProps={boardProps}
        documentsViewProps={documentsViewProps}
        layout={ProjectArtifactBoardLayout.Board}
      />
    );

    expect(screen.getByTestId("artifact-board")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-list")).toBeNull();
    expect(mocks.board).toHaveBeenCalledWith(boardProps);
  });

  it("keeps the list consumer as the closed-flag rollback path", () => {
    render(
      <ProjectArtifactsView
        boardProps={boardProps}
        documentsViewProps={documentsViewProps}
        layout={ProjectArtifactBoardLayout.List}
      />
    );

    expect(screen.getByTestId("artifact-list")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-board")).toBeNull();
    expect(mocks.list).toHaveBeenCalledWith(documentsViewProps);
  });
});
