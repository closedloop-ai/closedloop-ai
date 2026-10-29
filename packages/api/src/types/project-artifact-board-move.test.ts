import { describe, expect, it } from "vitest";
import {
  PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
  ProjectArtifactBoardDropPosition,
  type ProjectArtifactBoardMoveInput,
  projectArtifactBoardMoveIntent,
} from "./project-artifact-board-move.ts";
import {
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
  projectArtifactPlacementValidator,
} from "./project-artifact-placement.ts";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const MOVING_ID = "00000000-0000-4000-8000-000000000002";
const LANE_FIRST_ID = "00000000-0000-4000-8000-000000000003";
const LANE_LAST_ID = "00000000-0000-4000-8000-000000000004";
const DONE_LANE = "DONE";

function move(
  overrides: Partial<ProjectArtifactBoardMoveInput> = {}
): ProjectArtifactBoardMoveInput {
  return {
    destinationProjectId: PROJECT_ID,
    laneField: ProjectArtifactPlacementGroupField.Status,
    laneId: DONE_LANE,
    position: ProjectArtifactBoardDropPosition.End,
    rootIds: [MOVING_ID],
    source: ProjectArtifactPlacementSource.Pointer,
    targetLaneRootIds: [LANE_FIRST_ID, LANE_LAST_ID],
    ...overrides,
  };
}

describe("projectArtifactBoardMoveIntent", () => {
  it("places a lane-end drop after the lane's last other root", () => {
    expect(
      projectArtifactBoardMoveIntent(
        move({ targetLaneRootIds: [LANE_FIRST_ID, LANE_LAST_ID, MOVING_ID] })
      )
    ).toMatchObject({
      position: ProjectArtifactPlacementPosition.After,
      targetArtifactId: LANE_LAST_ID,
    });
  });

  it("places a drop into an empty lane at the root position", () => {
    expect(
      projectArtifactBoardMoveIntent(move({ targetLaneRootIds: [MOVING_ID] }))
    ).toMatchObject({ position: ProjectArtifactPlacementPosition.Root });
  });

  it.each([
    [
      ProjectArtifactBoardDropPosition.Before,
      ProjectArtifactPlacementPosition.Before,
    ],
    [
      ProjectArtifactBoardDropPosition.After,
      ProjectArtifactPlacementPosition.After,
    ],
  ])("keeps a %s drop relative to its reference root", (position, expected) => {
    expect(
      projectArtifactBoardMoveIntent(
        move({ position, referenceRootId: LANE_FIRST_ID })
      )
    ).toMatchObject({ position: expected, targetArtifactId: LANE_FIRST_ID });
  });

  it("resolves a before-drop on a moving root to the next stationary root", () => {
    expect(
      projectArtifactBoardMoveIntent(
        move({
          position: ProjectArtifactBoardDropPosition.Before,
          referenceRootId: MOVING_ID,
          rootIds: [LANE_FIRST_ID, MOVING_ID],
          targetLaneRootIds: [LANE_FIRST_ID, MOVING_ID, LANE_LAST_ID],
        })
      )
    ).toMatchObject({
      position: ProjectArtifactPlacementPosition.Before,
      targetArtifactId: LANE_LAST_ID,
    });
  });

  it("resolves an after-drop on a moving root to the previous stationary root", () => {
    expect(
      projectArtifactBoardMoveIntent(
        move({
          position: ProjectArtifactBoardDropPosition.After,
          referenceRootId: MOVING_ID,
          rootIds: [MOVING_ID, LANE_LAST_ID],
          targetLaneRootIds: [LANE_FIRST_ID, MOVING_ID, LANE_LAST_ID],
        })
      )
    ).toMatchObject({
      position: ProjectArtifactPlacementPosition.After,
      targetArtifactId: LANE_FIRST_ID,
    });
  });

  it("uses root placement when every lane root is moving", () => {
    expect(
      projectArtifactBoardMoveIntent(
        move({
          position: ProjectArtifactBoardDropPosition.Before,
          referenceRootId: MOVING_ID,
          rootIds: [MOVING_ID, LANE_FIRST_ID],
          targetLaneRootIds: [MOVING_ID, LANE_FIRST_ID],
        })
      )
    ).toMatchObject({ position: ProjectArtifactPlacementPosition.Root });
  });

  it.each([
    [
      ProjectArtifactPlacementGroupField.Priority,
      PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
    ],
    [
      ProjectArtifactPlacementGroupField.AssigneeId,
      PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
    ],
  ])("clears %s for its empty lane", (laneField, laneId) => {
    expect(
      projectArtifactBoardMoveIntent(move({ laneField, laneId })).lanePatch
    ).toEqual({ field: laneField, value: null });
  });

  it("sends no lane patch when lanes are not a field", () => {
    expect(
      projectArtifactBoardMoveIntent(move({ laneField: null })).lanePatch
    ).toBeUndefined();
  });

  it("builds a request the placement route accepts", () => {
    const intent = projectArtifactBoardMoveIntent(
      move({ expectedPolicyRevision: "policy-v1" })
    );

    expect(
      projectArtifactPlacementValidator.safeParse({
        ...intent,
        expectedProjectVersions: { [PROJECT_ID]: "board-version" },
        idempotencyKey: "board-drop-1",
        kind: ProjectArtifactPlacementKind.Place,
      }).success
    ).toBe(true);
  });
});
