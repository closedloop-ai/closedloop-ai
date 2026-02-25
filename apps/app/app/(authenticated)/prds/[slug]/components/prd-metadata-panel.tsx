"use client";

import type {
  ArtifactDetail,
  ArtifactStatus,
} from "@repo/api/src/types/artifact";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useMemo, useState } from "react";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { AttachmentsSection } from "@/components/artifact-editor/attachments-section";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { TargetRepositoryFields } from "@/components/artifact-editor/target-repository-fields";
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
   * Current owner (User or null if not selected)
   */
  owner: User | null;
  /**
   * List of team members to choose from for owner selection
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
   * Handler called when owner is changed
   */
  onOwnerChange: (user: User | null) => void;
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
};

/**
 * Metadata panel for PRD editor.
 * Displays status, approver, target repository/branch, and artifact metadata.
 */
export function PRDMetadataPanel({
  prd,
  status,
  approver,
  owner,
  teamMembers,
  targetRepo,
  targetBranch,
  onStatusChange,
  onApproverSelect,
  onOwnerChange,
  onTargetRepoChange,
  onTargetRepoBlur,
  onTargetBranchChange,
  onTargetBranchBlur,
}: PRDMetadataPanelProps) {
  const {
    dialogOpen,
    dialogTrace,
    selectedSessionId,
    handleViewFullTrace,
    setDialogOpen,
  } = useExecutionLogDialog();

  // Fetch org users for approver dropdown
  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

  const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);
  const [isExecutionLogOpen, setIsExecutionLogOpen] = useState(false);

  return (
    <>
      <MetadataPanel title="PRD Details">
        <div className="space-y-6">
          <CollapsibleSection
            onOpenChange={setIsPropertiesOpen}
            open={isPropertiesOpen}
            title="Properties"
          >
            <StatusMetadataSection
              approver={approver}
              onApproverSelect={onApproverSelect}
              onOwnerChange={onOwnerChange}
              onStatusChange={onStatusChange}
              orgUsers={transformedOrgUsers}
              owner={owner}
              status={status}
              teamMembers={teamMembers}
            />

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

          <CommentsSection artifactId={prd.id} />

          <AttachmentsSection artifactId={prd.id} />
        </div>
      </MetadataPanel>
      <ExecutionLogDialog
        initialSessionId={selectedSessionId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        trace={dialogTrace}
      />
    </>
  );
}
