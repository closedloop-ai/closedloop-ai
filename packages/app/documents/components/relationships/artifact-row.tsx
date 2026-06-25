"use client";

import type { Document } from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { getDocumentRoute } from "@repo/app/documents/lib/document-navigation";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@repo/app/projects/lib/project-constants";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { TerminalIcon } from "lucide-react";
import { ArtifactRowView } from "./artifact-row-view";

type ArtifactRowProps = {
  artifact: Document;
  /** 1-based nesting depth; rows at depth 1 render flush-left. */
  depth?: number;
  /** When provided, enables the "Detach Association" menu item. */
  linkId?: string | null;
  onDetach?: (linkId: string) => void;
};

/**
 * Standard single-line artifact row used across document detail pages —
 * Feature Context/Plan sections, Plan Context section, and PRD Associated
 * Artifacts. Entire row is clickable for navigation; interactive children
 * stop propagation so the menu doesn't re-trigger nav. Child rows (depth > 1)
 * are marked with a leading corner-down-right icon rather than left-indent.
 */
export function ArtifactRow({
  artifact,
  depth = 1,
  linkId = null,
  onDetach,
}: Readonly<ArtifactRowProps>) {
  const buildOrgPath = useOrgPath();
  // Non-document artifact types (e.g. SESSION) have no DocumentType entry; fall
  // back to a generic icon/label so the row renders instead of crashing.
  const Icon = DOCUMENT_TYPE_ICONS[artifact.type] ?? TerminalIcon;
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[artifact.type] ?? artifact.type;
  const statusIconStatus = DOCUMENT_STATUS_TO_ICON[artifact.status];
  const statusLabel = DOCUMENT_STATUS_LABELS[artifact.status];
  const documentRoute = getDocumentRoute(artifact);
  const route = documentRoute ? buildOrgPath(documentRoute) : null;

  return (
    <ArtifactRowView
      assignee={<AssigneeAvatar assignee={artifact.assignee} />}
      depth={depth}
      href={route}
      onDetach={
        linkId && onDetach
          ? () => {
              onDetach(linkId);
            }
          : undefined
      }
      priority={artifact.priority}
      slug={isDisplayableSlug(artifact.slug) ? artifact.slug : badgeLabel}
      status={statusIconStatus}
      statusLabel={statusLabel}
      title={artifact.title}
      typeIcon={<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      typeLabel={badgeLabel}
    />
  );
}
