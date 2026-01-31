"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";
import { Label } from "@repo/design-system/components/ui/label";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";

const PR_STATE_STYLES: Record<string, string> = {
  OPEN: "bg-green-100 text-green-700",
  MERGED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-red-100 text-red-700",
};

type PlanMetadataPanelProps = {
  /**
   * Plan artifact with workstream data
   */
  plan: ArtifactWithWorkstream;
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
   * Generation status information (GitHub Actions workflow)
   */
  generationStatus: GenerationStatus | null;
  /**
   * Pull request information if plan has been executed
   */
  pullRequest: PullRequestInfo | null;
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
};

/**
 * Metadata panel for Plan editor.
 * Displays status, approver, generation workflow link, pull request info, and artifact metadata.
 *
 * Usage:
 * ```tsx
 * <PlanMetadataPanel
 *   plan={plan}
 *   status={status}
 *   approver={approver}
 *   owner={owner}
 *   teamMembers={teamMembers}
 *   generationStatus={generationStatus}
 *   pullRequest={pullRequest}
 *   onStatusChange={handleStatusChange}
 *   onApproverChange={handleApproverChange}
 *   onApproverBlur={handleApproverBlur}
 *   onOwnerChange={handleOwnerChange}
 * />
 * ```
 */
export function PlanMetadataPanel({
  plan,
  status,
  approver,
  owner,
  teamMembers,
  generationStatus,
  pullRequest,
  onStatusChange,
  onApproverChange,
  onApproverBlur,
  onOwnerChange,
}: PlanMetadataPanelProps) {
  return (
    <MetadataPanel title="Plan Details">
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
        <div className="space-y-1 text-muted-foreground text-sm">
          <p>Version: v{plan.version}</p>
          <p>
            Created:{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
            }).format(new Date(plan.createdAt))}
          </p>
          <p>
            Updated:{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
            }).format(new Date(plan.updatedAt))}
          </p>
        </div>
      </MetadataSection>

      {/* GitHub Action Run Link */}
      {generationStatus?.htmlUrl ? (
        <MetadataSection separator>
          <Label className="text-muted-foreground text-xs">Generation</Label>
          <a
            className="flex items-center gap-1 text-primary text-sm hover:underline"
            href={generationStatus.htmlUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            View GitHub Workflow
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        </MetadataSection>
      ) : null}

      {/* Pull Request Link */}
      {pullRequest ? (
        <MetadataSection separator>
          <Label className="text-muted-foreground text-xs">Pull Request</Label>
          <a
            className="flex items-center gap-1 text-primary text-sm hover:underline"
            href={pullRequest.htmlUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitPullRequestIcon className="h-3 w-3" />#{pullRequest.number}:{" "}
            {pullRequest.title}
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-xs ${PR_STATE_STYLES[pullRequest.state]}`}
            >
              {pullRequest.state}
            </span>
            <span>
              {pullRequest.headBranch} → {pullRequest.baseBranch}
            </span>
          </div>
        </MetadataSection>
      ) : null}
    </MetadataPanel>
  );
}
