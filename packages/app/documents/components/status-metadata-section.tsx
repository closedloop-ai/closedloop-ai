"use client";

import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  type DocumentStatus,
  DocumentType,
  FEATURE_STATUS_OPTIONS,
  type FeatureStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { FeatureStatusIcon } from "@repo/app/documents/components/feature-status-icon";
import {
  DOCUMENT_STATUS_LABELS,
  FEATURE_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { StatusMetadataSection as SharedStatusMetadataSection } from "@repo/design-system/components/ui/status-metadata-section";
import type { User } from "@repo/design-system/components/ui/user-select-popover";

export type StatusMetadataSectionProps = {
  /**
   * Artifact type — selects the status vocabulary shown (Features use the
   * delivery lifecycle, Documents the authoring lifecycle). PRD-495.
   */
  documentType: DocumentType;
  /**
   * Current artifact status
   */
  status: ArtifactStatus;
  /**
   * Current assignee (User or null if not selected)
   */
  assignee: User | null;
  /**
   * List of team members to choose from for assignee selection
   */
  teamMembers: User[];
  /**
   * Handler called when status is changed
   */
  onStatusChange: (status: ArtifactStatus) => void;
  /**
   * Handler called when assignee is changed
   */
  onAssigneeChange: (user: User | null) => void;
  /**
   * Optional className for custom styling
   */
  className?: string;
  /**
   * Layout: "vertical" = stacked (sidebar), "horizontal" = single row (metadata bar)
   */
  layout?: "horizontal" | "vertical";
};

function statusOptionsForType(documentType: DocumentType) {
  if (documentType === DocumentType.Feature) {
    // Full Feature vocabulary, including TRIAGE — humans may set any status
    // (TRIAGE is only excluded as the human-create *default*, not as an option).
    return FEATURE_STATUS_OPTIONS.map((statusOption) => ({
      value: statusOption,
      label: FEATURE_STATUS_LABELS[statusOption] ?? statusOption,
      icon: (
        <FeatureStatusIcon size={16} status={statusOption as FeatureStatus} />
      ),
    }));
  }
  return DOCUMENT_STATUS_OPTIONS.map((statusOption) => ({
    value: statusOption,
    label: DOCUMENT_STATUS_LABELS[statusOption] ?? statusOption,
    icon: (
      <DocumentStatusIcon size={16} status={statusOption as DocumentStatus} />
    ),
  }));
}

/**
 * Shared metadata section for PRD and Plan editors.
 * Provides status select and assignee selection fields with consistent styling.
 *
 * Usage:
 * ```tsx
 * <StatusMetadataSection
 *   status={status}
 *   assignee={assignee}
 *   teamMembers={teamMembers}
 *   onStatusChange={handleStatusChange}
 *   onAssigneeChange={handleAssigneeChange}
 * />
 * ```
 */
export function StatusMetadataSection({
  documentType,
  status,
  assignee,
  teamMembers,
  onStatusChange,
  onAssigneeChange,
  className,
  layout = "vertical",
}: Readonly<StatusMetadataSectionProps>) {
  return (
    <SharedStatusMetadataSection
      assignee={assignee}
      className={className}
      layout={layout}
      onAssigneeChange={onAssigneeChange}
      onStatusChange={(next) => onStatusChange(next as ArtifactStatus)}
      options={statusOptionsForType(documentType)}
      status={status}
      teamMembers={teamMembers}
    />
  );
}
