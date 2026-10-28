"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { DocumentType } from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import {
  ArtifactStatusMenu,
  ArtifactStatusTooltip,
} from "@repo/app/documents/components/artifact-field-menus";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import {
  type DocumentRowData,
  documentTypeFromSubtype,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import {
  GroupByMode,
  type GroupByMode as GroupByModeValue,
} from "@repo/app/documents/lib/group-by";
import type { useProjectArtifactMetadata } from "@repo/app/projects/hooks/use-project-artifact-list-metadata";
import { projectGroupAuthority } from "@repo/app/projects/lib/project-artifact-group-updates";
import { projectPeopleLoading } from "@repo/app/projects/lib/project-artifact-list-helpers";
import { projectArtifactRoute } from "@repo/app/projects/lib/project-artifact-navigation";
import {
  ARTIFACT_STATUS_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@repo/app/projects/lib/project-constants";
import type {
  ArtifactBoardFieldDefinition,
  ArtifactBoardItem,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { GenericArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { ArtifactTypeIcons } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-icons";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import {
  TableChoiceCell,
  TableDateCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import { GitBranchIcon, TerminalIcon } from "lucide-react";
import { ProjectArtifactBoardField } from "./project-artifact-board";
import { projectBoardGroupField } from "./project-artifact-board-model";
import { ProjectArtifactBoardTags } from "./project-artifact-board-tags";
import { ProjectArtifactCell } from "./project-artifact-cells";

export type ProjectBoardFieldContext = {
  documentById: ReadonlyMap<string, DocumentRowData>;
  editHandlers: RowEditHandlers;
  metadata: ReturnType<typeof useProjectArtifactMetadata>;
  treeData: ProjectTreeDetailsResponse;
};

/**
 * Fields whose values come from the project list's own metadata reads and cell
 * renderer (ISS-12929, 724-F4), so a card and the list column show the same
 * value, loading state and unavailable state.
 */
export const PROJECT_BOARD_METADATA_FIELDS: ReadonlySet<string> = new Set([
  ProjectArtifactBoardField.Collaborators,
  ProjectArtifactBoardField.Comments,
  ProjectArtifactBoardField.CurrentVersion,
  ProjectArtifactBoardField.RelatedSessions,
]);

export function renderProjectBoardField(
  item: ArtifactBoardItem,
  field: ArtifactBoardFieldDefinition,
  context: ProjectBoardFieldContext
) {
  if (PROJECT_BOARD_METADATA_FIELDS.has(field.id)) {
    const artifact = findProjectBoardArtifact(item.id, context.treeData);
    // Only documents are versioned. The card omits a field its kind does not
    // have, as it already does for Tags on a branch or session.
    if (
      field.id === ProjectArtifactBoardField.CurrentVersion &&
      artifact?.type !== ArtifactType.Document
    ) {
      return null;
    }
    return artifact ? (
      <ProjectArtifactCell
        artifact={artifact}
        columnId={field.id}
        editHandlers={context.editHandlers}
        people={context.metadata.peopleByArtifactId.get(artifact.id)}
        peopleLoading={projectPeopleLoading(context.metadata, artifact.type)}
        related={context.metadata.relatedSessions.data?.results[artifact.id]}
        relatedLoading={context.metadata.relatedSessions.isLoading}
      />
    ) : null;
  }
  const document = context.documentById.get(item.id);
  if (document) {
    return renderDocumentBoardField(document, field, context.editHandlers);
  }
  const value = item.fieldValues[field.id];
  switch (field.id) {
    case ProjectArtifactBoardField.Status:
      return <TableChoiceCell label={String(value)} />;
    case ProjectArtifactBoardField.Priority:
      return <TableChoiceCell label={priorityLabel(String(value ?? ""))} />;
    case ProjectArtifactBoardField.Owner:
      return <TablePersonCell person={{ name: String(value) }} />;
    case ProjectArtifactBoardField.Updated:
      return <TableDateCell value={String(value)} />;
    default:
      return null;
  }
}

function renderDocumentBoardField(
  document: DocumentRowData,
  field: ArtifactBoardFieldDefinition,
  editHandlers: RowEditHandlers
) {
  switch (field.id) {
    case ProjectArtifactBoardField.Status: {
      const label = ARTIFACT_STATUS_LABELS[document.status];
      const status = <TableChoiceCell label={label} />;
      const capability = documentArtifactStatusCapability({
        documentType: document.type,
        operation: DocumentStatusMutationOperation.Single,
        rawStatus: document.rawStatus ?? document.status,
        statusMutation: document.statusMutation,
      });
      if (!(editHandlers.onUpdateStatus && capability.editable)) {
        return (
          <ArtifactStatusTooltip label={label}>{status}</ArtifactStatusTooltip>
        );
      }
      return (
        <ArtifactStatusMenu
          isFeature={document.type === DocumentType.Feature}
          onSelect={(nextStatus) =>
            editHandlers.onUpdateStatus?.(
              document.id,
              nextStatus,
              ArtifactStatusEditSurface.Board
            )
          }
          tooltipLabel={label}
          trigger={
            <button onClick={(event) => event.stopPropagation()} type="button">
              {status}
            </button>
          }
        />
      );
    }
    case ProjectArtifactBoardField.Priority:
      return (
        <ArtifactPriorityEditor
          onSelect={
            editHandlers.onUpdatePriority
              ? (nextPriority) =>
                  editHandlers.onUpdatePriority?.(document.id, nextPriority)
              : undefined
          }
          priority={document.priority}
          support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact]}
          variant={ArtifactPriorityVariant.Label}
        />
      );
    case ProjectArtifactBoardField.Owner: {
      const selectedUser = document.assignee
        ? {
            avatarUrl: document.assignee.avatarUrl ?? undefined,
            id: document.assignee.id,
            name: getUserDisplayName(document.assignee),
          }
        : null;
      const person = (
        <TablePersonCell
          person={selectedUser ?? { name: UNASSIGNED_ASSIGNEE_LABEL }}
        />
      );
      if (!(editHandlers.onUpdateAssignee && editHandlers.teamMembers)) {
        return person;
      }
      return (
        <UserSelectPopover
          onSelect={(user) =>
            editHandlers.onUpdateAssignee?.(document.id, user?.id ?? null)
          }
          trigger={
            <button onClick={(event) => event.stopPropagation()} type="button">
              {person}
            </button>
          }
          users={editHandlers.teamMembers}
          value={selectedUser}
        />
      );
    }
    case ProjectArtifactBoardField.Tags:
      return <ProjectArtifactBoardTags document={document} />;
    case ProjectArtifactBoardField.Updated:
      return (
        <TableDateCell
          value={formatRelativeTimeOrFallback(document.updatedAt)}
        />
      );
    default:
      return null;
  }
}

export function projectBoardCanMove(
  artifactId: string,
  groupBy: GroupByModeValue,
  treeData: ProjectTreeDetailsResponse
) {
  const artifact = findProjectBoardArtifact(artifactId, treeData);
  if (groupBy !== GroupByMode.Status) {
    // A lane move writes the lane's field, so a kind that does not own that
    // field (a Deployment's priority, a Branch's owner) cannot move here
    // (ISS-12929, 724-F8); the server refuses the same write.
    const field = projectBoardGroupField(groupBy);
    return field === null || projectGroupAuthority(artifact?.type, field);
  }
  if (!(artifact?.type === ArtifactType.Document && artifact.subtype)) {
    return false;
  }
  return documentArtifactStatusCapability({
    documentType: documentTypeFromSubtype(artifact.subtype),
    operation: DocumentStatusMutationOperation.Single,
    rawStatus: artifact.status,
    statusMutation: artifact.statusMutation,
  }).editable;
}

export function projectBoardCanMoveToLane(
  artifactId: string,
  laneId: string,
  groupBy: GroupByModeValue,
  treeData: ProjectTreeDetailsResponse
) {
  if (groupBy !== GroupByMode.Status) {
    return projectBoardCanMove(artifactId, groupBy, treeData);
  }
  const artifact = findProjectBoardArtifact(artifactId, treeData);
  if (!(artifact?.type === ArtifactType.Document && artifact.subtype)) {
    return false;
  }
  const capability = documentArtifactStatusCapability({
    documentType: documentTypeFromSubtype(artifact.subtype),
    operation: DocumentStatusMutationOperation.Single,
    rawStatus: artifact.status,
    statusMutation: artifact.statusMutation,
  });
  return Boolean(
    capability.editable &&
      capability.allowedTargets.some((status) => status === laneId)
  );
}

export function projectBoardTypeIcon(
  item: ArtifactBoardItem,
  treeData: ProjectTreeDetailsResponse
) {
  const artifact = findProjectBoardArtifact(item.id, treeData);
  if (artifact?.type === ArtifactType.Document && artifact.subtype) {
    const Icon = DOCUMENT_TYPE_ICONS[documentTypeFromSubtype(artifact.subtype)];
    return <Icon className="size-4" />;
  }
  let Icon = GitBranchIcon;
  if (artifact?.type === ArtifactType.Session) {
    Icon = TerminalIcon;
  } else if (artifact?.type === ArtifactType.Deployment) {
    // ISS-12929 (724-F9): the generic board's deployment icon, not a branch.
    Icon = ArtifactTypeIcons[GenericArtifactKind.Deployment];
  }
  return <Icon className="size-4" />;
}

export function findProjectBoardArtifact(
  id: string,
  treeData: ProjectTreeDetailsResponse
): DetailedArtifact | null {
  for (const node of treeData.nodes) {
    if (node.root.id === id) {
      return node.root;
    }
    const child = node.children.find((candidate) => candidate.id === id);
    if (child) {
      return child;
    }
  }
  return null;
}

/**
 * A card's destination. Branches keep the board's build route, which the
 * branch details navigation also uses; every other kind goes through the
 * project list's own navigation helper, so a Deployment opens its external
 * URL (ISS-12929, 724-F9).
 */
export function projectBoardRoute(artifact: DetailedArtifact): string | null {
  if (artifact.type === ArtifactType.Branch) {
    return `/build/${artifact.id}`;
  }
  return projectArtifactRoute(artifact);
}
