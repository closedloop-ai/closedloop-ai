"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useState } from "react";
import {
  MetadataSection,
  TabbedMetadataPanel,
} from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";

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
 *
 * Usage:
 * ```tsx
 * <PRDMetadataPanel
 *   prd={prd}
 *   status={status}
 *   approver={approver}
 *   owner={owner}
 *   teamMembers={teamMembers}
 *   targetRepo={targetRepo}
 *   targetBranch={targetBranch}
 *   onStatusChange={handleStatusChange}
 *   onApproverChange={handleApproverChange}
 *   onApproverBlur={handleApproverBlur}
 *   onOwnerChange={handleOwnerChange}
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTrace, setDialogTrace] = useState<ExecutionTrace>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();

  const handleViewFullTrace = (trace: ExecutionTrace, sessionId?: string) => {
    setDialogTrace(trace);
    setSelectedSessionId(sessionId);
    setDialogOpen(true);
  };

  return (
    <>
      <TabbedMetadataPanel
        tabs={[
          {
            id: "details",
            label: "Details",
            content: (
              <div className="space-y-4">
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
                  <h4 className="font-medium text-sm">Plan Generation</h4>

                  <div className="space-y-2">
                    <Label>
                      Target Repository{" "}
                      <span className="text-muted-foreground text-xs">
                        (owner/repo)
                      </span>
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
              </div>
            ),
          },
          {
            id: "execution-log",
            label: "Execution Log",
            content: (
              <ExecutionLogSummary
                artifactId={prd.id}
                onViewFullTrace={handleViewFullTrace}
              />
            ),
          },
        ]}
      />
      <ExecutionLogDialog
        initialSessionId={selectedSessionId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        trace={dialogTrace}
      />
    </>
  );
}
