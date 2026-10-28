"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactCollaboratorEntry } from "@repo/api/src/types/artifact-collaborators";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  BranchIdentityAvailability,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import type { RelatedSessionsResult } from "@repo/api/src/types/related-session";
import { TagEntityType } from "@repo/api/src/types/tag";
import { CountCell } from "@repo/design-system/components/ui/count-cell";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { MessageSquareIcon } from "lucide-react";
import {
  ArtifactListCell,
  ArtifactListRelatedSessions,
} from "../../artifacts/components/artifact-list-cells";
import type { useDocumentsPrototypeCustomFields } from "../../documents/components/documents-prototype-custom-fields";
import type { RowEditHandlers } from "../../documents/components/table/row-edit-context";
import { documentRowFromArtifact } from "../../documents/lib/artifact-row-adapter";
import { ArtifactPriority } from "../../shared/components/artifact-priority/artifact-priority";
import { ArtifactStatus } from "../../shared/components/artifact-status/artifact-status";
import { AssigneeAvatar } from "../../shared/components/assignee-avatar";
import { Collaborators } from "../../shared/components/collaborators";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { ArtifactPriorityVariant } from "../../shared/lib/artifact-priority-ownership";
import { artifactStatusView } from "../../shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "../../shared/lib/artifact-status-view-contract";
import { formatRelativeTimeOrFallback } from "../../shared/lib/date-utils";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "../../shared/lib/user-utils";
import { TagPicker } from "../../tags/components/tag-picker";
import type { useProjectArtifactListMetadata } from "../hooks/use-project-artifact-list-metadata";
import {
  projectArtifactParents,
  projectPeopleLoading,
} from "../lib/project-artifact-list-helpers";
import type { ProjectArtifactReadModel } from "../lib/project-artifact-read-model";
import { ProjectArtifactParents } from "./project-artifact-title";

/** Assemble the project-list cell from the existing custom and artifact cells. */
export function ProjectArtifactListCell({
  columnId,
  row,
  model,
  customFields,
  metadata,
  editHandlers,
}: {
  columnId: string;
  row: GenericArtifact;
  model: ProjectArtifactReadModel;
  customFields: ReturnType<typeof useDocumentsPrototypeCustomFields>;
  metadata: ReturnType<typeof useProjectArtifactListMetadata>;
  editHandlers: RowEditHandlers;
}) {
  const artifact = model.artifactsById.get(row.id);
  if (!artifact) {
    return <GridEmptyValue title="Unavailable" />;
  }
  if (columnId === "parent") {
    return (
      <ProjectArtifactParents parents={projectArtifactParents(model, row.id)} />
    );
  }
  const customCell = customFields.renderCell(
    {
      id: artifact.id,
      title: artifact.name,
      customFields: artifact.customFieldValues,
    },
    columnId
  );
  if (customCell !== undefined) {
    return customCell;
  }
  return (
    <ProjectArtifactCell
      artifact={artifact}
      columnId={columnId}
      editHandlers={editHandlers}
      people={metadata.peopleByArtifactId.get(row.id)}
      peopleLoading={projectPeopleLoading(metadata, artifact.type)}
      related={metadata.relatedSessions.data?.results[row.id]}
      relatedLoading={metadata.relatedSessions.isLoading}
    />
  );
}

export function ProjectArtifactCell({
  artifact,
  columnId,
  editHandlers,
  people,
  peopleLoading,
  related,
  relatedLoading,
  statusVariant,
}: {
  artifact: DetailedArtifact;
  columnId: string;
  editHandlers: RowEditHandlers;
  people?: ArtifactCollaboratorEntry;
  peopleLoading: boolean;
  related?: RelatedSessionsResult;
  relatedLoading: boolean;
  statusVariant?: typeof ArtifactStatusVariant.Icon;
}) {
  const document = documentRowFromArtifact(artifact, null);
  if (columnId === "tags" && artifact.tags === undefined) {
    return <GridEmptyValue title="Unavailable" />;
  }
  if (columnId === "updated") {
    return (
      <span className="text-muted-foreground text-xs">
        {formatRelativeTimeOrFallback(artifact.updatedAt)}
      </span>
    );
  }
  if (document) {
    return (
      <ArtifactListCell
        collaborators={people?.collaborators}
        collaboratorsLoading={peopleLoading}
        columnId={columnId}
        commentCount={people?.commentCount}
        document={{ ...document, latestVersion: artifact.currentVersion }}
        editHandlers={editHandlers}
        relatedLoading={relatedLoading}
        relatedSessions={related}
        statusTriggerVariant={statusVariant}
      />
    );
  }
  if (columnId === "owner") {
    return (
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <AssigneeAvatar
          assignee={artifact.assignee}
          className="size-5"
          decorative
          disableLink
          disableTooltip
        />
        <span className="truncate">
          {artifact.assignee
            ? getUserDisplayName(artifact.assignee)
            : UNASSIGNED_ASSIGNEE_LABEL}
        </span>
      </span>
    );
  }
  if (columnId === "collaborators") {
    if (
      !people ||
      people.collaborators.availability ===
        BranchIdentityAvailability.Unavailable
    ) {
      return <GridEmptyValue title="Unavailable" />;
    }
    return (
      <Collaborators
        people={people.collaborators.people.map((person) => ({
          key: branchPersonKey(person),
          name: person.displayName ?? person.login ?? person.id,
          avatarUrl: person.avatarUrl ?? undefined,
        }))}
      />
    );
  }
  if (columnId === "comments") {
    return (
      <CountCell
        count={people?.commentCount}
        icon={<MessageSquareIcon aria-hidden className="size-3.5" />}
        loading={peopleLoading}
        noun={{ one: "comment", other: "comments" }}
      />
    );
  }
  if (columnId === "relatedSessions") {
    return (
      <ArtifactListRelatedSessions data={related} isLoading={relatedLoading} />
    );
  }
  if (columnId === "tags") {
    return (
      <TagPicker
        appliedTags={artifact.tags ?? []}
        entityId={artifact.id}
        entityType={TagEntityType.Artifact}
      />
    );
  }
  if (columnId === "priority") {
    return (
      <ArtifactPriority
        priority={artifact.priority}
        variant={ArtifactPriorityVariant.CompactCell}
      />
    );
  }
  if (columnId === "status") {
    return (
      <ArtifactStatus
        variant={statusVariant ?? ArtifactStatusVariant.CompactCell}
        view={artifactStatusView(
          artifact.id,
          artifact.type === ArtifactType.Session
            ? ArtifactStatusVocabulary.Session
            : ArtifactStatusVocabulary.Branch,
          artifact.status
        )}
      />
    );
  }
  return <GridEmptyValue title="Unavailable" />;
}
