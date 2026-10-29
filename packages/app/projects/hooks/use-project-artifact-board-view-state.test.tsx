import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectArtifactBoardViewState } from "./use-project-artifact-board-view-state";

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

describe("CT-09/CT-17 AC-009 Project Artifact Board preference adapter", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("wires the Project Artifact selector and isolates two project keys", () => {
    const { rerender, result } = renderHook(
      ({ projectId, storageKey }: { projectId: string; storageKey: string }) =>
        useProjectArtifactBoardViewState({
          defaults: DEFAULT_VIEW,
          projectId,
          storageKey,
        }),
      {
        initialProps: {
          projectId: "project-one",
          storageKey: "project-board:one",
        },
      }
    );

    act(() => {
      result.current.setArrangement((current) => ({
        ...current,
        layout: ProjectArtifactBoardLayout.Board,
      }));
    });
    const firstRaw = localStorage.getItem("project-board:one");
    expect(firstRaw).not.toBeNull();
    expect(JSON.parse(firstRaw ?? "{}")).toMatchObject({
      arrangement: { layout: ProjectArtifactBoardLayout.Board },
    });

    rerender({ projectId: "project-two", storageKey: "project-board:two" });
    expect(result.current.view.arrangement.layout).toBe(
      ProjectArtifactBoardLayout.List
    );
    act(() => {
      result.current.setArrangement((current) => ({
        ...current,
        laneField: ProjectArtifactBoardGroup.Priority,
      }));
    });

    expect(
      JSON.parse(localStorage.getItem("project-board:one") ?? "{}")
    ).toMatchObject({
      arrangement: { layout: ProjectArtifactBoardLayout.Board },
    });
    expect(
      JSON.parse(localStorage.getItem("project-board:two") ?? "{}")
    ).toMatchObject({
      arrangement: { laneField: ProjectArtifactBoardGroup.Priority },
    });
  });

  it("does not apply one project's persisted arrangement to another project", () => {
    localStorage.setItem(
      "project-board:one",
      JSON.stringify({
        ...DEFAULT_VIEW,
        arrangement: {
          ...DEFAULT_VIEW.arrangement,
          layout: ProjectArtifactBoardLayout.Board,
        },
      })
    );
    const { rerender, result } = renderHook(
      ({ projectId, storageKey }: { projectId: string; storageKey: string }) =>
        useProjectArtifactBoardViewState({
          defaults: DEFAULT_VIEW,
          projectId,
          storageKey,
        }),
      {
        initialProps: {
          projectId: "project-one",
          storageKey: "project-board:one",
        },
      }
    );

    expect(result.current.view.arrangement.layout).toBe(
      ProjectArtifactBoardLayout.Board
    );
    rerender({ projectId: "project-two", storageKey: "project-board:two" });
    expect(result.current.view.arrangement.layout).toBe(
      ProjectArtifactBoardLayout.List
    );
  });

  it("publishes only a complete compatible edit", () => {
    const { result } = renderHook(() =>
      useProjectArtifactBoardViewState({
        defaults: DEFAULT_VIEW,
        projectId: "project-one",
        storageKey: "project-board:one",
      })
    );

    act(() => {
      result.current.setArrangement((current) => ({
        ...current,
        collapsedLaneIds: Array.from({ length: 101 }, (_, index) =>
          String(index)
        ),
      }));
    });

    expect(localStorage.getItem("project-board:one")).toBeNull();
  });
});
