/**
 * Board page fixtures shared by the Project Artifact Board surface suites.
 */
import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardPageResponse,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
} from "@repo/api/src/types/project-artifact-board-view";

export const ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
export const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";

export const boardView = {
  arrangement: {
    cardFieldIds: [],
    collapsedLaneIds: [],
    laneField: ProjectArtifactBoardGroup.Status,
    laneOrder: [],
    layout: ProjectArtifactBoardLayout.Board,
    manualOrder: true,
  },
  version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
};

export function boardData(
  status: string = IssueStatus.InProgress,
  subtype: ArtifactSubtype = ArtifactSubtype.Feature
): ProjectArtifactBoardPageResponse {
  const timestamp = new Date("2026-10-19T00:00:00.000Z");
  return {
    lanes: [
      {
        cards: [
          {
            artifact: {
              assignee: null,
              assigneeId: null,
              createdAt: timestamp,
              createdById: null,
              dueDate: null,
              externalUrl: null,
              id: ARTIFACT_ID,
              name: "Ship Artifact Board",
              organizationId: ORGANIZATION_ID,
              priority: Priority.High,
              projectId: PROJECT_ID,
              slug: "ISS-724",
              sortOrder: 1024,
              status,
              subtype,
              type: ArtifactType.Document,
              updatedAt: timestamp,
            },
            descendantCount: 0,
          },
        ],
        complete: true,
        count: 1,
        id: status,
        label: "In Progress",
      },
    ],
    populationRevision: "a".repeat(64),
    projectVersion: "board-version",
    rootIds: [ARTIFACT_ID],
  };
}
