"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useState } from "react";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { TargetRepositoryFields } from "@/components/artifact-editor/target-repository-fields";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";

type PRDMetadataPanelProps = {
  /**
   * PRD artifact with workstream data
   */
  prd: ArtifactWithWorkstream;
  /**
   * Current artifact status
   */
  status: ArtifactStatus;
  /**
   * Current approver value
   */
  approver: string;
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
   * Handler called when approver input value changes
   */
  onApproverChange: (approver: string) => void;
  /**
   * Handler called when approver input loses focus
   */
  onApproverBlur: () => void;
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
  onTargetRepoBlur: () => void;
  /**
   * Handler called when target branch input value changes
   */
  onTargetBranchChange: (targetBranch: string) => void;
  /**
   * Handler called when target branch input loses focus
   */
  onTargetBranchBlur: () => void;
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
  onApproverChange,
  onApproverBlur,
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
              onApproverBlur={onApproverBlur}
              onApproverChange={onApproverChange}
              onOwnerChange={onOwnerChange}
              onStatusChange={onStatusChange}
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
              createdAt={prd.createdAt}
              updatedAt={prd.updatedAt}
              version={prd.version}
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
