import {
  ProjectArtifactPlacementGroupField,
  type ProjectArtifactPlacementIntent,
  type ProjectArtifactPlacementLanePatch,
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementSource,
} from "./project-artifact-placement.ts";

/** Where a board drop lands relative to the lane's visible roots. */
export const ProjectArtifactBoardDropPosition = {
  After: "after",
  Before: "before",
  End: "end",
} as const;
export type ProjectArtifactBoardDropPosition =
  (typeof ProjectArtifactBoardDropPosition)[keyof typeof ProjectArtifactBoardDropPosition];

/** Lane ids the board uses for an absent priority or assignee. */
export const PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID = "none";
export const PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID = "unassigned";

export type ProjectArtifactBoardMoveInput = {
  destinationProjectId: string;
  expectedPolicyRevision?: string;
  /** The field the board's lanes group by; null when lanes are not a field. */
  laneField: ProjectArtifactPlacementGroupField | null;
  laneId: string;
  position: ProjectArtifactBoardDropPosition;
  referenceRootId?: string;
  rootIds: readonly string[];
  source: Exclude<
    ProjectArtifactPlacementSource,
    typeof ProjectArtifactPlacementSource.Undo
  >;
  /** The destination lane's rendered roots, in order. */
  targetLaneRootIds: readonly string[];
};

/**
 * The PRD-725 placement intent for one board drop. The position is relative to
 * a single target root, so the server never compares a lane's population; the
 * lane field change rides along as the PRD-724 lane patch.
 */
export function projectArtifactBoardMoveIntent(
  input: ProjectArtifactBoardMoveInput
): ProjectArtifactPlacementIntent {
  const otherLaneRootIds = input.targetLaneRootIds.filter(
    (rootId) => !input.rootIds.includes(rootId)
  );
  return {
    destinationProjectId: input.destinationProjectId,
    lanePatch: boardLanePatch(input),
    ...boardPlacementTarget(input, otherLaneRootIds),
    source: input.source,
    sourceArtifactIds: [...input.rootIds],
  };
}

function boardPlacementTarget(
  input: Pick<
    ProjectArtifactBoardMoveInput,
    "position" | "referenceRootId" | "targetLaneRootIds"
  >,
  otherLaneRootIds: readonly string[]
) {
  const referenceIndex = input.targetLaneRootIds.indexOf(
    input.referenceRootId ?? ""
  );
  const referenceIsMoving =
    referenceIndex >= 0 &&
    input.referenceRootId !== undefined &&
    !otherLaneRootIds.includes(input.referenceRootId);
  switch (input.position) {
    case ProjectArtifactBoardDropPosition.Before: {
      if (referenceIsMoving) {
        const nextRoot = input.targetLaneRootIds
          .slice(referenceIndex + 1)
          .find((rootId) => otherLaneRootIds.includes(rootId));
        if (nextRoot) {
          return {
            position: ProjectArtifactPlacementPosition.Before,
            targetArtifactId: nextRoot,
          } as const;
        }
        return placementAfterLastOtherRoot(otherLaneRootIds);
      }
      return {
        position: ProjectArtifactPlacementPosition.Before,
        targetArtifactId: input.referenceRootId,
      } as const;
    }
    case ProjectArtifactBoardDropPosition.After: {
      if (referenceIsMoving) {
        const previousRoot = input.targetLaneRootIds
          .slice(0, referenceIndex)
          .reverse()
          .find((rootId) => otherLaneRootIds.includes(rootId));
        if (previousRoot) {
          return {
            position: ProjectArtifactPlacementPosition.After,
            targetArtifactId: previousRoot,
          } as const;
        }
        const nextRoot = otherLaneRootIds[0];
        return nextRoot
          ? {
              position: ProjectArtifactPlacementPosition.Before,
              targetArtifactId: nextRoot,
            }
          : { position: ProjectArtifactPlacementPosition.Root };
      }
      return {
        position: ProjectArtifactPlacementPosition.After,
        targetArtifactId: input.referenceRootId,
      } as const;
    }
    case ProjectArtifactBoardDropPosition.End:
      return placementAfterLastOtherRoot(otherLaneRootIds);
    default: {
      const exhaustive: never = input.position;
      return exhaustive;
    }
  }
}

function placementAfterLastOtherRoot(otherLaneRootIds: readonly string[]) {
  const targetArtifactId = otherLaneRootIds.at(-1);
  return targetArtifactId
    ? {
        position: ProjectArtifactPlacementPosition.After,
        targetArtifactId,
      }
    : { position: ProjectArtifactPlacementPosition.Root };
}

function boardLanePatch(
  input: Pick<
    ProjectArtifactBoardMoveInput,
    "expectedPolicyRevision" | "laneField" | "laneId"
  >
): ProjectArtifactPlacementLanePatch | undefined {
  const revision = input.expectedPolicyRevision
    ? { expectedPolicyRevision: input.expectedPolicyRevision }
    : {};
  switch (input.laneField) {
    case ProjectArtifactPlacementGroupField.Status:
      return { ...revision, field: input.laneField, value: input.laneId };
    case ProjectArtifactPlacementGroupField.Priority:
      return {
        ...revision,
        field: input.laneField,
        value:
          input.laneId === PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID
            ? null
            : input.laneId,
      };
    case ProjectArtifactPlacementGroupField.AssigneeId:
      return {
        ...revision,
        field: input.laneField,
        value:
          input.laneId === PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID
            ? null
            : input.laneId,
      };
    case null:
      return;
    default: {
      const exhaustive: never = input.laneField;
      return exhaustive;
    }
  }
}
