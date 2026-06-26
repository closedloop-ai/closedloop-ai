"use client";

import {
  DOCUMENT_STATUS_OPTIONS,
  type DocumentStatus,
} from "@repo/api/src/types/document";
import { DOCUMENT_STATUS_TO_ICON } from "@repo/app/projects/lib/project-constants";
import { artifactStatusLabels } from "@repo/app/shared/components/status-badge";
import { StatusMetadataSection as SharedStatusMetadataSection } from "@repo/design-system/components/ui/status-metadata-section";
import type { User } from "@repo/design-system/components/ui/user-select-popover";

export type StatusMetadataSectionProps = {
  /**
   * Current artifact status
   */
  status: DocumentStatus;
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
  onStatusChange: (status: DocumentStatus) => void;
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
      onStatusChange={(next) => onStatusChange(next as DocumentStatus)}
      options={DOCUMENT_STATUS_OPTIONS.map((statusOption) => ({
        value: statusOption,
        label: artifactStatusLabels[statusOption] ?? statusOption,
        iconStatus: DOCUMENT_STATUS_TO_ICON[statusOption],
      }))}
      status={status}
      teamMembers={teamMembers}
    />
  );
}
