"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";

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
 *
 * Usage:
 * ```tsx
 * <PRDMetadataPanel
 *   prd={prd}
 *   status={status}
 *   approver={approver}
 *   targetRepo={targetRepo}
 *   targetBranch={targetBranch}
 *   onStatusChange={handleStatusChange}
 *   onApproverChange={handleApproverChange}
 *   onApproverBlur={handleApproverBlur}
 *   onTargetRepoChange={handleTargetRepoChange}
 *   onTargetRepoBlur={handleTargetRepoBlur}
 *   onTargetBranchChange={handleTargetBranchChange}
 *   onTargetBranchBlur={handleTargetBranchBlur}
 * />
 * ```
 */
export function PRDMetadataPanel({
  prd,
  status,
  approver,
  targetRepo,
  targetBranch,
  onStatusChange,
  onApproverChange,
  onApproverBlur,
  onTargetRepoChange,
  onTargetRepoBlur,
  onTargetBranchChange,
  onTargetBranchBlur,
}: PRDMetadataPanelProps) {
  return (
    <MetadataPanel title="PRD Details">
      <StatusMetadataSection
        approver={approver}
        onApproverBlur={onApproverBlur}
        onApproverChange={onApproverChange}
        onStatusChange={onStatusChange}
        status={status}
      />

      <MetadataSection separator>
        <h4 className="font-medium text-sm">Plan Generation</h4>

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
          <p>Version: v{prd.version}</p>
          <p>
            Created:{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
            }).format(new Date(prd.createdAt))}
          </p>
          <p>
            Updated:{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
            }).format(new Date(prd.updatedAt))}
          </p>
        </div>
      </MetadataSection>
    </MetadataPanel>
  );
}
