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

type IssueMetadataPanelProps = {
  issue: ArtifactWithWorkstream;
  status: ArtifactStatus;
  approver: string;
  owner: User | null;
  teamMembers: User[];
  targetRepo: string;
  targetBranch: string;
  onStatusChange: (status: ArtifactStatus) => void;
  onApproverChange: (approver: string) => void;
  onApproverBlur: () => void;
  onOwnerChange: (user: User | null) => void;
  onTargetRepoChange: (targetRepo: string) => void;
  onTargetRepoBlur: () => void;
  onTargetBranchChange: (targetBranch: string) => void;
  onTargetBranchBlur: () => void;
};

export function IssueMetadataPanel({
  issue,
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
}: IssueMetadataPanelProps) {
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
      <MetadataPanel title="Issue Details">
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
              title="Repository Settings"
            />

            <ArtifactVersionInfo
              createdAt={issue.createdAt}
              updatedAt={issue.updatedAt}
              version={issue.version}
            />
          </CollapsibleSection>

          <CollapsibleSection
            onOpenChange={setIsExecutionLogOpen}
            open={isExecutionLogOpen}
            title="Execution Log"
          >
            <ExecutionLogSummary
              artifactId={issue.id}
              onViewFullTrace={handleViewFullTrace}
            />
          </CollapsibleSection>

          <CommentsSection artifactId={issue.id} />
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
