"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  type DocumentStatus,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
  type IssueStatus,
} from "@repo/api/src/types/document";
import {
  type DocumentStatusMutationCapability,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  documentStatusFacet,
  documentStatusView,
} from "@repo/app/shared/lib/artifact-status-adapter";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/shared/lib/artifact-status-labels";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { StatusMetadataSection as SharedStatusMetadataSection } from "@repo/design-system/components/ui/status-metadata-section";
import type { User } from "@repo/design-system/components/ui/user-select-popover";

export type StatusMetadataSectionProps = {
  /** Real subject identity required by the champion editor contract. */
  artifactId: string;
  /**
   * Artifact type — selects the status vocabulary shown (Features use the
   * delivery lifecycle, Documents the authoring lifecycle). PRD-495.
   */
  documentType: DocumentType;
  /**
   * Current artifact status
   */
  status: ArtifactStatus;
  statusMutation?: DocumentStatusMutationCapability;
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

// No unknown-status arm here, deliberately (ISS-9560 review). The OPTIONS are
// `Object.values(IssueStatus)` / `Object.values(DocumentStatus)` and the maps
// are exhaustive `Record<IssueStatus, string>` / `Record<DocumentStatus,
// string>`, so the iterated set and the lookup are drawn from the same enum and
// a miss is not reachable. The picker's real out-of-vocabulary case is the
// CURRENT status, which the shared component resolves against `options` — it is
// not this function's, and it is not gated.
function statusOptionsForType(documentType: DocumentType) {
  if (documentType === DocumentType.Feature) {
    // Full Feature vocabulary, including TRIAGE — humans may set any status
    // (TRIAGE is only excluded as the human-create *default*, not as an option).
    return ISSUE_STATUS_OPTIONS.map((statusOption) => ({
      value: statusOption,
      label: ISSUE_STATUS_LABELS[statusOption] ?? statusOption,
      icon: <IssueStatusIcon size={16} status={statusOption as IssueStatus} />,
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
  artifactId,
  documentType,
  status,
  statusMutation,
  assignee,
  teamMembers,
  onStatusChange,
  onAssigneeChange,
  className,
  layout = "vertical",
}: Readonly<StatusMetadataSectionProps>) {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const championStatusAriaLabel = `Status: ${artifactStatusLabel(
    documentStatusFacet(documentType, status)
  )}`;
  const statusControl = champion
    ? ({ id }: { ariaLabel: string; id: string }) => (
        <UniversalArtifactStatus
          ariaLabel={championStatusAriaLabel}
          capability={documentArtifactStatusCapability({
            documentType,
            operation: DocumentStatusMutationOperation.Single,
            rawStatus: status,
            statusMutation,
          })}
          onCommit={(commit) => onStatusChange(commit.to as ArtifactStatus)}
          surface={ArtifactStatusEditSurface.Detail}
          triggerId={id}
          variant={ArtifactStatusVariant.Editor}
          view={documentStatusView(artifactId, documentType, status)}
        />
      )
    : undefined;
  return (
    <SharedStatusMetadataSection
      assignee={assignee}
      className={className}
      layout={layout}
      onAssigneeChange={onAssigneeChange}
      onStatusChange={(next) => onStatusChange(next as ArtifactStatus)}
      options={statusOptionsForType(documentType)}
      status={status}
      statusControl={statusControl}
      teamMembers={teamMembers}
    />
  );
}
