import type { ProjectArtifactBoardGroup } from "./project-artifact-board-page.ts";

export const PROJECT_ARTIFACT_BOARD_VIEW_VERSION = 1 as const;

export const ProjectArtifactBoardLayout = {
  Board: "board",
  List: "list",
} as const;
export type ProjectArtifactBoardLayout =
  (typeof ProjectArtifactBoardLayout)[keyof typeof ProjectArtifactBoardLayout];

export type ProjectArtifactBoardArrangement = {
  cardFieldIds: string[];
  collapsedLaneIds: string[];
  laneField: ProjectArtifactBoardGroup;
  laneOrder: string[];
  layout: ProjectArtifactBoardLayout;
  manualOrder: boolean;
  /** Omitted means no secondary lane field; omission survives the wire. */
  secondaryLaneField?: ProjectArtifactBoardGroup;
};

export type ProjectArtifactBoardView = {
  arrangement: ProjectArtifactBoardArrangement;
  version: typeof PROJECT_ARTIFACT_BOARD_VIEW_VERSION;
};

export type ProjectArtifactBoardUrlAxes = Partial<
  Pick<
    ProjectArtifactBoardArrangement,
    | "cardFieldIds"
    | "collapsedLaneIds"
    | "laneField"
    | "layout"
    | "secondaryLaneField"
  >
>;
