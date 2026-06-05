"use client";

import {
  ARTIFACT_STATUS_OPTIONS,
  type ArtifactStatus,
} from "@repo/api/src/types/artifact";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { useId } from "react";
import { artifactStatusLabels } from "@/components/status-badge";
import { ARTIFACT_STATUS_TO_ICON } from "@/lib/project-constants";
import { MetadataSection } from "./metadata-panel";

export type StatusMetadataSectionProps = {
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
   * List of organization users to choose from for approver selection
   */
  orgUsers: User[];
  /**
   * Handler called when status is changed
   */
  onStatusChange: (status: ArtifactStatus) => void;
  /**
   * Handler called when approver is selected (saves immediately)
   */
  onApproverSelect: (user: User | null) => void;
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
 * Provides status select, owner selection, and approver selection fields with consistent styling.
 *
 * The approver field saves immediately on selection (no blur handler needed).
 *
 * Usage:
 * ```tsx
 * <StatusMetadataSection
 *   status={status}
 *   approver={approver}
 *   assignee={assignee}
 *   teamMembers={teamMembers}
 *   orgUsers={orgUsers}
 *   onStatusChange={handleStatusChange}
 *   onApproverSelect={handleApproverSelect}
 *   onAssigneeChange={handleAssigneeChange}
 * />
 * ```
 */
export function StatusMetadataSection({
  status,
  approver,
  assignee,
  teamMembers,
  orgUsers,
  onStatusChange,
  onApproverSelect,
  onAssigneeChange,
  className,
  layout = "vertical",
}: Readonly<StatusMetadataSectionProps>) {
  const statusId = useId();

  const statusOptions = ARTIFACT_STATUS_OPTIONS.map((statusOption) => (
    <SelectItem key={statusOption} value={statusOption}>
      <span className="inline-flex items-center gap-1.5">
        <StatusIcon size={16} status={ARTIFACT_STATUS_TO_ICON[statusOption]} />
        {artifactStatusLabels[statusOption] ?? statusOption}
      </span>
    </SelectItem>
  ));

  const content =
    layout === "horizontal" ? (
      <>
        <Select
          onValueChange={(v) => onStatusChange(v as ArtifactStatus)}
          value={status}
        >
          <SelectTrigger
            className="min-w-0 justify-start gap-1 bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent [&>:last-child]:hidden"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>{statusOptions}</SelectContent>
        </Select>
        <UserSelectPopover
          className="w-auto min-w-[7rem] bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
          disabled={teamMembers.length === 0}
          onSelect={onAssigneeChange}
          placeholder="Select assignee..."
          users={teamMembers}
          value={assignee}
        />
        <UserSelectPopover
          className="w-auto min-w-[7rem] bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
          disabled={orgUsers.length === 0}
          onSelect={onApproverSelect}
          placeholder="Select approver..."
          users={orgUsers}
          value={approver}
        />
      </>
    ) : (
      <>
        <div className="space-y-2">
          <Label htmlFor={statusId}>Status</Label>
          <Select
            onValueChange={(v) => onStatusChange(v as ArtifactStatus)}
            value={status}
          >
            <SelectTrigger
              className="min-w-0 justify-start bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent [&>:last-child]:hidden"
              id={statusId}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{statusOptions}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Assignee</Label>
          <UserSelectPopover
            className="bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
            disabled={teamMembers.length === 0}
            onSelect={onAssigneeChange}
            placeholder="Select assignee..."
            users={teamMembers}
            value={assignee}
          />
        </div>
        <div className="space-y-2">
          <Label>Approver</Label>
          <UserSelectPopover
            className="w-full bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
            disabled={orgUsers.length === 0}
            onSelect={onApproverSelect}
            placeholder="Select approver..."
            users={orgUsers}
            value={approver}
          />
        </div>
      </>
    );

  return (
    <MetadataSection className={className} layout={layout}>
      {content}
    </MetadataSection>
  );
}
