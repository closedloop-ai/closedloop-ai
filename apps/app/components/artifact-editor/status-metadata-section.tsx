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
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { artifactStatusLabels } from "@/components/status-badge";
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
}: Readonly<StatusMetadataSectionProps>) {
  return (
    <MetadataSection className={className}>
      <div className="space-y-2">
        <Label>Status</Label>
        <Select
          onValueChange={(v) => onStatusChange(v as ArtifactStatus)}
          value={status}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ARTIFACT_STATUS_OPTIONS.map((statusOption) => (
              <SelectItem key={statusOption} value={statusOption}>
                {artifactStatusLabels[statusOption] ?? statusOption}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Assignee</Label>
        <UserSelectPopover
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
          className="w-full"
          disabled={orgUsers.length === 0}
          onSelect={onApproverSelect}
          placeholder="Select approver..."
          users={orgUsers}
          value={approver}
        />
      </div>
    </MetadataSection>
  );
}
