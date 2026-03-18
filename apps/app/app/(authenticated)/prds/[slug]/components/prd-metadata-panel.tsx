"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type {
  ArtifactDetail,
  ArtifactStatus,
} from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useMemo, useState } from "react";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { AttachmentsSection } from "@/components/artifact-editor/attachments-section";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { TargetRepositoryFields } from "@/components/artifact-editor/target-repository-fields";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type PRDMetadataPanelProps = {
  /**
   * PRD artifact with workstream data
   */
  prd: ArtifactDetail;
  /**
   * Current artifact status
   */
  status: ArtifactStatus;
  /**
   * Current approver (User or null if not selected)
   */
  approver: User | null;
  /**
   * Current assignee (User or null if not selected)
   */
  assignee: User | null;
  /**
   * List of team members to choose from for assignee selection
   */
  teamMembers: User[];
  /**
   * Current target repository value
   */
  targetRepo: string;
  /**
   * Current target branch value
   */
  targetBranch: string;
  /**
   * Handler called when status is changed
   */
  onStatusChange: (status: ArtifactStatus) => void;
  /**
   * Handler called when approver is selected
   */
  onApproverSelect: (user: User | null) => void;
  /**
   * Handler called when assignee is changed
   */
  onAssigneeChange: (user: User | null) => void;
  /**
   * Handler called when target repository input value changes
   */
  onTargetRepoChange: (targetRepo: string) => void;
  /**
   * Handler called when target repository input loses focus
   */
  onTargetRepoBlur: (overrideValue?: string) => void;
  /**
   * Handler called when target branch input value changes
   */
  onTargetBranchChange: (targetBranch: string) => void;
  /**
   * Handler called when target branch input loses focus
   */
  onTargetBranchBlur: (overrideValue?: string) => void;
  /**
   * When "detailsOnly", render only the details content (no sidebar wrapper, no status section).
   * Used when metadata bar is below title and chat is in the right gutter.
   */
  variant?: "detailsOnly" | "sidebar";
};

/**
 * Metadata panel for PRD editor.
 * Displays status, approver, target repository/branch, and artifact metadata.
 */
export function PRDMetadataPanel({
  prd,
  status,
  approver,
  assignee,
  teamMembers,
  targetRepo,
  targetBranch,
  onStatusChange,
  onApproverSelect,
  onAssigneeChange,
  onTargetRepoChange,
  onTargetRepoBlur,
  onTargetBranchChange,
  onTargetBranchBlur,
  variant = "sidebar",
}: PRDMetadataPanelProps) {
  const {
    dialogOpen,
    dialogTrace,
    selectedSessionId,
    handleViewFullTrace,
    setDialogOpen,
  } = useExecutionLogDialog();

  // Fetch org users for approver dropdown (sidebar variant only)
  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isExecutionLogOpen, setIsExecutionLogOpen] = useState(false);

  const detailsContent = (
    <div className="space-y-6">
      <CollapsibleSection
        onOpenChange={setIsPropertiesOpen}
        open={isPropertiesOpen}
        title="Properties"
      >
        {variant === "sidebar" ? (
          <StatusMetadataSection
            approver={approver}
            assignee={assignee}
            onApproverSelect={onApproverSelect}
            onAssigneeChange={onAssigneeChange}
            onStatusChange={onStatusChange}
            orgUsers={transformedOrgUsers}
            status={status}
            teamMembers={teamMembers}
          />
        ) : null}

        <TargetRepositoryFields
          onTargetBranchBlur={onTargetBranchBlur}
          onTargetBranchChange={onTargetBranchChange}
          onTargetRepoBlur={onTargetRepoBlur}
          onTargetRepoChange={onTargetRepoChange}
          targetBranch={targetBranch}
          targetRepo={targetRepo}
          title="Plan Generation"
        />

        <ArtifactVersionInfo
          createdAt={prd.version.createdAt}
          updatedAt={prd.updatedAt}
          version={prd.version.version}
        />
      </CollapsibleSection>

      <CollapsibleSection
        onOpenChange={setIsExecutionLogOpen}
        open={isExecutionLogOpen}
        title="Execution Log"
      >
        <ExecutionLogSummary
          artifactId={prd.id}
          onViewFullTrace={handleViewFullTrace}
        />
      </CollapsibleSection>

      <FeatureFlagged flag="the-one-flag">
        <CommentsSection artifactId={prd.id} />
      </FeatureFlagged>

      <AttachmentsSection artifactId={prd.id} />

      <CustomFieldsSection
        entityId={prd.id}
        entityType={CustomFieldEntityType.Artifact}
        values={prd.customFields}
      />
    </div>
  );

  if (variant === "detailsOnly") {
    return (
      <>
        {detailsContent}
        <ExecutionLogDialog
          initialSessionId={selectedSessionId}
          onOpenChange={setDialogOpen}
          open={dialogOpen}
          trace={dialogTrace}
        />
      </>
    );
  }

  return (
    <>
      <MetadataPanel title="PRD Details">{detailsContent}</MetadataPanel>
      <ExecutionLogDialog
        initialSessionId={selectedSessionId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        trace={dialogTrace}
      />
    </>
  );
}
