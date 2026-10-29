"use client";

import {
  type ProjectArtifactLanePolicyReason,
  projectArtifactLanePolicyReasonLabel,
} from "@repo/api/src/types/project-artifact-lane-policy";
import { RELATED_SESSIONS_SECTION_TITLE } from "@repo/app/documents/lib/related-sessions-labels";
import {
  ArtifactBoard,
  type ArtifactBoardFeedback,
  type ArtifactBoardProps,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board";
import {
  type ArtifactBoardFieldDefinition,
  ArtifactBoardMutationState,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { genericArtifactColumns } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";

export const ProjectArtifactBoardField = {
  Collaborators: "collaborators",
  Comments: "comments",
  CurrentVersion: "currentVersion",
  Owner: "owner",
  Priority: "priority",
  RelatedSessions: "relatedSessions",
  Status: "status",
  Tags: "tags",
  Type: "type",
  Updated: "updated",
} as const;
export type ProjectArtifactBoardField =
  (typeof ProjectArtifactBoardField)[keyof typeof ProjectArtifactBoardField];

export const PROJECT_ARTIFACT_BOARD_FIELDS = [
  {
    id: ProjectArtifactBoardField.Status,
    label: "Status",
    tier: "primary",
  },
  {
    id: ProjectArtifactBoardField.Priority,
    label: "Priority",
    tier: "primary",
  },
  {
    id: ProjectArtifactBoardField.Owner,
    label: "Owner",
    tier: "primary",
  },
  {
    id: ProjectArtifactBoardField.Collaborators,
    label: "Collaborators",
    tier: "secondary",
  },
  {
    id: ProjectArtifactBoardField.Tags,
    label: "Tags",
    tier: "secondary",
  },
  {
    id: ProjectArtifactBoardField.RelatedSessions,
    label: RELATED_SESSIONS_SECTION_TITLE,
    tier: "secondary",
  },
  {
    id: ProjectArtifactBoardField.Comments,
    label: "Comments",
    tier: "secondary",
  },
  {
    id: ProjectArtifactBoardField.Updated,
    label: "Updated",
    tier: "secondary",
  },
  {
    id: ProjectArtifactBoardField.CurrentVersion,
    label: projectListColumnLabel(ProjectArtifactBoardField.CurrentVersion),
    tier: "secondary",
  },
] as const satisfies readonly ArtifactBoardFieldDefinition[];

export type ProjectArtifactBoardProps = Omit<
  ArtifactBoardProps,
  "fields" | "primaryGroupFieldId" | "secondaryGroupFieldId"
> & {
  /** Project view's primary grouping field. */
  groupBy: ProjectArtifactBoardField | null;
  /** Optional second grouping field. */
  secondaryGroupBy?: ProjectArtifactBoardField | null;
};

/**
 * Project-domain composition of the shared Artifact Board. Real row mapping,
 * navigation, editor authority and mutations are injected by the project host.
 */
export function ProjectArtifactBoard({
  groupBy,
  secondaryGroupBy = null,
  ...boardProps
}: Readonly<ProjectArtifactBoardProps>) {
  return (
    <ArtifactBoard
      {...boardProps}
      fields={PROJECT_ARTIFACT_BOARD_FIELDS}
      primaryGroupFieldId={groupBy ?? ""}
      secondaryGroupFieldId={secondaryGroupBy}
    />
  );
}

/** Canonical accessible feedback for a Project adapter policy refusal. */
export function projectArtifactBoardPolicyFeedback(
  reason: ProjectArtifactLanePolicyReason
): ArtifactBoardFeedback {
  return {
    content: projectArtifactLanePolicyReasonLabel(reason),
    state: ArtifactBoardMutationState.Error,
  };
}

/**
 * The project list's own column label for a field the board shares with it
 * (ISS-12929, 724-F4), so a card and its column never name one field twice.
 * A missing column is a programming error, thrown at import like the column
 * registry's own refusals.
 */
function projectListColumnLabel(id: string): string {
  const column = genericArtifactColumns.find(
    (definition) => definition.id === id
  );
  if (!column) {
    throw new Error(`Project list column ${id} is not declared`);
  }
  return column.label;
}
