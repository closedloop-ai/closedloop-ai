import {
  ArtifactType,
  type ArtifactType as ArtifactTypeValue,
} from "./artifact.ts";
import {
  ProjectArtifactPlacementGroupField,
  type ProjectArtifactPlacementGroupField as ProjectArtifactPlacementGroupFieldValue,
} from "./project-artifact-placement.ts";

/** Whether an artifact kind owns the field written by a board lane move. */
export function projectArtifactTypeSupportsGroupField(
  type: ArtifactTypeValue | undefined,
  field: ProjectArtifactPlacementGroupFieldValue
): boolean {
  return type ? PROJECT_ARTIFACT_GROUP_AUTHORITY[type][field] : false;
}

const PROJECT_ARTIFACT_GROUP_AUTHORITY: Record<
  ArtifactTypeValue,
  Record<ProjectArtifactPlacementGroupFieldValue, boolean>
> = {
  [ArtifactType.Document]: {
    [ProjectArtifactPlacementGroupField.AssigneeId]: true,
    [ProjectArtifactPlacementGroupField.Priority]: true,
    [ProjectArtifactPlacementGroupField.Status]: true,
  },
  [ArtifactType.Branch]: {
    [ProjectArtifactPlacementGroupField.AssigneeId]: false,
    [ProjectArtifactPlacementGroupField.Priority]: true,
    [ProjectArtifactPlacementGroupField.Status]: false,
  },
  [ArtifactType.Deployment]: {
    [ProjectArtifactPlacementGroupField.AssigneeId]: false,
    [ProjectArtifactPlacementGroupField.Priority]: false,
    [ProjectArtifactPlacementGroupField.Status]: false,
  },
  [ArtifactType.Session]: {
    [ProjectArtifactPlacementGroupField.AssigneeId]: true,
    [ProjectArtifactPlacementGroupField.Priority]: true,
    [ProjectArtifactPlacementGroupField.Status]: false,
  },
};
