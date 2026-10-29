"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BranchIdentityAvailability,
  branchPersonKey,
  type SourceCollaborators,
} from "@repo/api/src/types/branch-identity";
import type {
  ArtifactStatus,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { PROVENANCE_RELATIONSHIP_KIND_LABELS } from "@repo/api/src/types/provenance-relationship";
import type { RelatedSessionsResult } from "@repo/api/src/types/related-session";
import {
  isRecognizedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { UNKNOWN_OWNER_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { relatedSessionNoun } from "@repo/app/documents/components/related-sessions-cell";
import {
  DocumentCellFrame,
  DocumentCellFrameContext,
} from "@repo/app/documents/components/table/cells/cell-frame";
import { TagsCell } from "@repo/app/documents/components/table/cells/tags-cell";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { getDocumentTypeLabel } from "@repo/app/documents/lib/document-navigation";
import { ArtifactStatus as StatusControl } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusReadOnlyReasonCopy } from "@repo/app/shared/components/artifact-status/artifact-status-editor";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { Collaborators } from "@repo/app/shared/components/collaborators";
import { RelatedSessionsTableCell } from "@repo/app/shared/components/generic-artifact-surface/related-sessions-table-cell";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import {
  documentStatusFacet,
  documentStatusView,
} from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import {
  CHIP_FOCUS_RING_CLASS,
  Chip,
} from "@repo/design-system/components/ui/chip";
import { CountCell } from "@repo/design-system/components/ui/count-cell";
import { DropdownMenuItem } from "@repo/design-system/components/ui/dropdown-menu";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { MonoIdCell } from "@repo/design-system/components/ui/mono-id-cell";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { MessageSquareIcon, UsersIcon } from "lucide-react";

export function ArtifactListCell({
  columnId,
  document,
  editHandlers,
  commentCount,
  collaborators,
  collaboratorsLoading,
  relatedSessions,
  relatedLoading,
  statusTriggerVariant,
}: {
  columnId: string;
  document: DocumentRowData &
    Partial<Pick<DocumentWithProject, "latestVersion">>;
  editHandlers: RowEditHandlers;
  commentCount?: number;
  collaborators?: SourceCollaborators<string>;
  collaboratorsLoading?: boolean;
  relatedSessions?: RelatedSessionsResult;
  relatedLoading?: boolean;
  statusTriggerVariant?: typeof ArtifactStatusVariant.Icon;
}) {
  if (columnId === "collaborators") {
    if (collaboratorsLoading) {
      return (
        <Skeleton aria-label="Loading collaborators…" className="h-5 w-full" />
      );
    }
    if (
      !collaborators ||
      collaborators.availability === BranchIdentityAvailability.Unavailable
    ) {
      return <GridEmptyValue title="Unavailable" />;
    }
    return (
      <Collaborators
        people={collaborators.people.map((person) => ({
          key: branchPersonKey(person),
          name: person.displayName ?? person.login ?? person.id,
          ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
        }))}
      />
    );
  }
  if (columnId === "project") {
    return (
      <span className="truncate text-sm">
        {document.project?.name ?? <GridEmptyValue />}
      </span>
    );
  }
  if (columnId === "priority") {
    return (
      <ArtifactPriorityEditor
        onSelect={(priority) =>
          editHandlers.onUpdatePriority?.(document.id, priority)
        }
        priority={document.priority}
        support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact]}
      />
    );
  }
  if (columnId === "owner") {
    return (
      <ArtifactListOwner document={document} editHandlers={editHandlers} />
    );
  }
  if (columnId === "status") {
    return (
      <StatusControl
        capability={documentArtifactStatusCapability({
          documentType: document.type,
          operation: DocumentStatusMutationOperation.Single,
          rawStatus: document.status,
          statusMutation: document.statusMutation,
        })}
        onCommit={(commit) =>
          editHandlers.onUpdateStatus?.(
            document.id,
            commit.to as ArtifactStatus,
            ArtifactStatusEditSurface.InlineCell
          )
        }
        surface={ArtifactStatusEditSurface.InlineCell}
        triggerVariant={statusTriggerVariant}
        variant={ArtifactStatusVariant.Editor}
        view={documentStatusView(document.id, document.type, document.status)}
      />
    );
  }
  if (columnId === "tags") {
    // Every host renders this cell inside a grid cell, which draws the column
    // divider; the Documents cell would otherwise draw a second one beside it.
    return (
      <DocumentCellFrameContext.Provider value={DocumentCellFrame.Host}>
        <TagsCell item={{ kind: "document", data: document }} />
      </DocumentCellFrameContext.Provider>
    );
  }
  if (columnId === "currentVersion") {
    return document.latestVersion === undefined ? (
      <GridEmptyValue title="Unavailable" />
    ) : (
      <MonoIdCell label="Version" value={String(document.latestVersion)} />
    );
  }
  if (columnId === "comments") {
    return (
      <CountCell
        count={commentCount}
        icon={<MessageSquareIcon aria-hidden className="size-3.5" />}
        loading={collaboratorsLoading}
        noun={{ one: "comment", other: "comments" }}
      />
    );
  }
  if (columnId === "relatedSessions") {
    return (
      <ArtifactListRelatedSessions
        data={relatedSessions}
        isLoading={Boolean(relatedLoading)}
      />
    );
  }
  if (columnId === "document-type") {
    return (
      <span className="truncate text-sm">
        {getDocumentTypeLabel(document.type)}
      </span>
    );
  }
  return <GridEmptyValue title="Unavailable" />;
}

function ArtifactListOwner({
  document,
  editHandlers,
}: {
  document: DocumentRowData &
    Partial<Pick<DocumentWithProject, "latestVersion">>;
  editHandlers: RowEditHandlers;
}) {
  const owner = document.assignee;
  const label = owner ? getUserDisplayName(owner) : UNASSIGNED_ASSIGNEE_LABEL;
  const content = (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <AssigneeAvatar
        assignee={owner}
        className="size-5"
        decorative
        disableLink
        disableTooltip
      />
      <span className="truncate">{label}</span>
    </span>
  );
  if (!(editHandlers.onUpdateAssignee && editHandlers.teamMembers)) {
    return content;
  }
  return (
    <UserSelectPopover
      onSelect={(user) =>
        editHandlers.onUpdateAssignee?.(document.id, user?.id ?? null)
      }
      trigger={
        <button
          aria-label={`Owner: ${label}`}
          className={cn(
            "flex min-w-0 items-center rounded-sm text-left hover:bg-muted",
            CHIP_FOCUS_RING_CLASS
          )}
          type="button"
        >
          {content}
        </button>
      }
      users={editHandlers.teamMembers}
      value={
        owner
          ? {
              id: owner.id,
              name: label,
              avatarUrl: owner.avatarUrl ?? undefined,
            }
          : null
      }
    />
  );
}

export function ArtifactListRelatedSessions({
  data,
  isLoading,
}: {
  data?: RelatedSessionsResult;
  isLoading: boolean;
}) {
  const orgPath = useOrgPath();
  if (isLoading) {
    return (
      <Skeleton aria-label="Loading related sessions…" className="h-5 w-full" />
    );
  }
  if (!data) {
    return <GridEmptyValue title="Unavailable" />;
  }
  if (data.items.length === 0 && data.total > 0) {
    return (
      <Chip className="gap-1" size="sm" variant="muted">
        <UsersIcon aria-hidden className="size-3 shrink-0" />
        <span aria-hidden>{data.total}</span>
        <span className="sr-only">{`${data.total} ${relatedSessionNoun(data.total)}`}</span>
      </Chip>
    );
  }
  const items = data.items.map((session) => ({
    href: orgPath(`/sessions/${session.sessionArtifactId}`),
    id: session.sessionArtifactId,
    sessionSlug: session.slug ?? session.name ?? session.sessionArtifactId,
    occurredAt: session.contributedAt,
    ownerName: session.owner
      ? getUserDisplayName(session.owner)
      : UNKNOWN_OWNER_LABEL,
    ...(session.owner?.avatarUrl
      ? { ownerAvatarUrl: session.owner.avatarUrl }
      : {}),
    // ISS-10364: an unrecognized wire value fails open to ACTIVE, the same way
    // `toBranchRowSession` folds the chip this cell reuses — there is no
    // display-only "we don't know" word left. `rawStatus` below still carries
    // the producer's spelling for the version-skew explanation.
    status: isRecognizedSessionStatus(session.status)
      ? session.status
      : SESSION_STATUS.ACTIVE,
    rawStatus: session.status,
    relationshipLabel: PROVENANCE_RELATIONSHIP_KIND_LABELS[session.kind],
  }));
  return <RelatedSessionsTableCell items={items} total={data.total} />;
}

export function ArtifactListStatusMenu({
  document,
  editHandlers,
  surface,
}: {
  document: Pick<
    DocumentWithProject,
    "id" | "type" | "status" | "statusMutation"
  >;
  editHandlers: RowEditHandlers;
  surface: ArtifactStatusEditSurface;
}) {
  const capability = documentArtifactStatusCapability({
    documentType: document.type,
    operation: DocumentStatusMutationOperation.Single,
    rawStatus: document.status,
    statusMutation: document.statusMutation,
  });
  if (!capability.editable) {
    return (
      <DropdownMenuItem disabled>
        {artifactStatusReadOnlyReasonCopy(capability.reason)}
      </DropdownMenuItem>
    );
  }
  return capability.allowedTargets.map((raw) => (
    <DropdownMenuItem
      disabled={document.status === raw || !editHandlers.onUpdateStatus}
      key={raw}
      onSelect={() =>
        editHandlers.onUpdateStatus?.(
          document.id,
          raw as ArtifactStatus,
          surface
        )
      }
    >
      <StatusControl
        facet={documentStatusFacet(document.type, raw)}
        variant={ArtifactStatusVariant.BulkOption}
      />
    </DropdownMenuItem>
  ));
}
