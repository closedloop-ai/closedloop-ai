"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";

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
  return (
    <MetadataPanel title="Issue Details">
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

      <MetadataSection separator>
        <h4 className="font-medium text-sm">Repository Settings</h4>

        <div className="space-y-2">
          <Label>
            Target Repository{" "}
            <span className="text-muted-foreground text-xs">(owner/repo)</span>
          </Label>
          <Input
            onBlur={onTargetRepoBlur}
            onChange={(e) => onTargetRepoChange(e.target.value)}
            placeholder="owner/repo"
            value={targetRepo}
          />
        </div>

        <div className="space-y-2">
          <Label>Target Branch</Label>
          <Input
            onBlur={onTargetBranchBlur}
            onChange={(e) => onTargetBranchChange(e.target.value)}
            placeholder="main"
            value={targetBranch}
          />
        </div>
      </MetadataSection>

      <MetadataSection separator>
        <div className="space-y-1 text-muted-foreground text-sm">
          <p>Version: v{issue.version}</p>
          <p>
            Created:{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
            }).format(new Date(issue.createdAt))}
          </p>
          <p>
            Updated:{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
            }).format(new Date(issue.updatedAt))}
          </p>
        </div>
      </MetadataSection>
    </MetadataPanel>
  );
}
