"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ArtifactStatusIconFor } from "@repo/app/documents/components/artifact-field-menus";
import {
  type ArtifactRowEditController,
  useArtifactRowEdit,
} from "@repo/app/documents/hooks/use-artifact-row-edit";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import type { ArtifactRowDocument } from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { getDocumentRoute } from "@repo/app/documents/lib/document-navigation";
import { priorityDisplayFallback } from "@repo/app/documents/lib/priority-display-fallback";
import {
  ARTIFACT_STATUS_LABELS,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@repo/app/projects/lib/project-constants";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { documentStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ArtifactRowView } from "./artifact-row-view";

type ArtifactRowProps = {
  artifact: ArtifactRowDocument;
  /** 1-based nesting depth; rows at depth 1 render flush-left. */
  depth?: number;
  /** When provided, enables the "Detach Association" menu item. */
  linkId?: string | null;
  onDetach?: (linkId: string) => void;
  /**
   * When provided, the status glyph, assignee avatar and priority mark this row
   * already renders become the controls that set them (ISS-8543). Omit it and
   * the row is exactly the read-only row it has always been.
   */
  editing?: ArtifactRowEditController;
};

/**
 * Standard single-line artifact row used across document detail pages —
 * Feature Context/Plan sections, Plan Context section, and PRD Associated
 * Artifacts. Entire row is clickable for navigation; interactive children
 * stop propagation so the menu doesn't re-trigger nav. Child rows (depth > 1)
 * are marked with a leading corner-down-right icon rather than left-indent.
 */
export function ArtifactRow({
  artifact: incomingArtifact,
  depth = 1,
  linkId = null,
  onDetach,
  editing,
}: Readonly<ArtifactRowProps>) {
  const buildOrgPath = useOrgPath();
  // ISS-9665: the flag branch lives HERE, not at the call sites. Five surfaces
  // render this row (PRD Associated Artifacts, Plan Context, and three on the
  // Issue page), and gating them individually is a rule that has to be
  // re-applied to every future one — the first review of this change caught two
  // that had already been missed. Flag off, an artifact with no priority still
  // shows the `Medium` the serializer used to fold it to.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const artifact = unsetPriorityEnabled
    ? incomingArtifact
    : priorityDisplayFallback(incomingArtifact);
  const edit = useArtifactRowEdit(artifact, editing);
  // Non-document artifact types (e.g. SESSION) have no DocumentType entry; fall
  // back to a generic icon/label so the row renders instead of crashing.
  const Icon = DOCUMENT_TYPE_ICONS[artifact.type] ?? TerminalIcon;
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[artifact.type] ?? artifact.type;
  const isFeature = artifact.type === DocumentType.Feature;
  const documentRoute = getDocumentRoute(artifact);
  const route = documentRoute ? buildOrgPath(documentRoute) : null;
  const assigneeLabel = edit.assignee
    ? getUserDisplayName(edit.assignee)
    : UNASSIGNED_ASSIGNEE_LABEL;
  const rawStatus = currentArtifactRowStatusEvidence(incomingArtifact, edit);
  const statusView = documentStatusView(artifact.id, artifact.type, rawStatus);
  const statusLabel = champion
    ? artifactStatusLabel(statusView)
    : ARTIFACT_STATUS_LABELS[edit.status];
  let statusControl: ReactNode;
  if (champion) {
    statusControl = edit.onStatusChange ? (
      <UniversalArtifactStatus
        capability={documentArtifactStatusCapability({
          documentType: artifact.type,
          operation: DocumentStatusMutationOperation.Single,
          rawStatus,
          statusMutation: artifact.statusMutation,
        })}
        onCommit={(commit) =>
          edit.onStatusChange?.(commit.to as ArtifactStatus)
        }
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={statusView}
      />
    ) : (
      <UniversalArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={statusView}
      />
    );
  }

  return (
    <ArtifactRowView
      assignee={
        <AssigneeAvatar
          assignee={edit.assignee}
          // Editable, the avatar sits inside a 24px button, and at its default
          // 24px it would cover that button's hover state completely — leaving
          // the one control of the three with no affordance at all. The grid's
          // own picker trigger sizes it down for the same reason.
          className={edit.onAssigneeChange ? "size-5" : undefined}
          // Editable, the avatar sits inside a button that already states the
          // assignee, so leaving the name on both announces it twice. The
          // read-only row has no such ancestor and keeps its own name.
          decorative={Boolean(edit.onAssigneeChange)}
          disableLink={Boolean(edit.onAssigneeChange)}
        />
      }
      assigneeLabel={assigneeLabel}
      assigneeOptions={edit.users}
      assigneeValue={
        edit.users?.find((user) => user.id === edit.assignee?.id) ?? null
      }
      depth={depth}
      href={route}
      isFeature={isFeature}
      onAssigneeChange={edit.onAssigneeChange}
      onDetach={
        linkId && onDetach
          ? () => {
              onDetach(linkId);
            }
          : undefined
      }
      onPriorityChange={edit.onPriorityChange}
      onStatusChange={edit.onStatusChange}
      priority={edit.priority}
      priorityPending={edit.priorityPending}
      slug={isDisplayableSlug(artifact.slug) ? artifact.slug : badgeLabel}
      statusControl={statusControl}
      // Documents and Features carry disjoint status vocabularies (PRD-495), so
      // render the icon for this artifact's exact type.
      statusIcon={
        <ArtifactStatusIconFor isFeature={isFeature} status={edit.status} />
      }
      statusLabel={statusLabel}
      title={artifact.title}
      typeIcon={<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      typeLabel={badgeLabel}
    />
  );
}

/** Keeps unknown wire evidence until a real optimistic transition supersedes it. */
function currentArtifactRowStatusEvidence(
  artifact: ArtifactRowDocument,
  edit: ReturnType<typeof useArtifactRowEdit>
): string | null {
  if (edit.status !== artifact.status) {
    return edit.status;
  }
  if (artifact.rawStatus !== undefined) {
    return artifact.rawStatus;
  }
  return edit.status;
}
