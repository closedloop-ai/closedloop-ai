import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import { documentCustomFieldCreationValues } from "../../documents/components/documents-prototype-custom-fields";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactStatusFromRaw,
} from "../../shared/components/generic-artifact-surface/generic-artifact-status";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { formatRelativeTimeOrFallback } from "../../shared/lib/date-utils";
import {
  getUserDisplayName,
  getUserInitials,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "../../shared/lib/user-utils";

export function projectArtifactListRow(
  artifact: DetailedArtifact,
  parentArtifactId: string | null,
  projectName: string,
  now: number
): GenericArtifact {
  const kind = projectArtifactKind(artifact);
  return {
    id: artifact.id,
    slug: artifact.slug ?? "",
    title: artifact.name,
    summary: "",
    kind,
    status:
      genericArtifactStatusFromRaw(kind, artifact.status) ??
      GenericArtifactStatus.Todo,
    statusRaw: artifact.status,
    ownerId: artifact.assigneeId,
    owner: artifact.assignee
      ? getUserDisplayName(artifact.assignee)
      : UNASSIGNED_ASSIGNEE_LABEL,
    ownerInitials: artifact.assignee
      ? getUserInitials(artifact.assignee.firstName, artifact.assignee.lastName)
      : "",
    collaborators: [],
    repository: null,
    project: projectName,
    parentArtifactId,
    tags: artifact.tags?.map((tag) => tag.name) ?? [],
    tagIds: artifact.tags?.map((tag) => tag.id) ?? [],
    currentVersion:
      artifact.currentVersion === undefined
        ? ""
        : String(artifact.currentVersion),
    updated: formatRelativeTimeOrFallback(artifact.updatedAt),
    updatedAgoMinutes: (now - new Date(artifact.updatedAt).getTime()) / 60_000,
    createdAgoDays: (now - new Date(artifact.createdAt).getTime()) / 86_400_000,
    creationValues: {
      ...documentCustomFieldCreationValues({
        customFields: artifact.customFieldValues,
      }),
      priority: artifact.priority,
      projectId: artifact.projectId,
    },
    // Preview-only arithmetic never reaches host cells or project metric reads.
    aiSpend: 0,
    timeToReadyMinutes: 0,
    outcomeScore: 0,
    activityCount: 0,
    relationshipCount: 0,
  };
}

export function projectArtifactKind(
  artifact: DetailedArtifact
): GenericArtifactKind {
  switch (artifact.type) {
    case ArtifactType.Document:
      return artifact.subtype === ArtifactSubtype.Feature
        ? GenericArtifactKind.Issue
        : GenericArtifactKind.Document;
    case ArtifactType.Branch:
      return GenericArtifactKind.Branch;
    case ArtifactType.Session:
      return GenericArtifactKind.Session;
    case ArtifactType.Deployment:
      return GenericArtifactKind.Deployment;
    default: {
      const exhaustive: never = artifact.type;
      throw new Error(`Unsupported artifact type: ${exhaustive}`);
    }
  }
}
