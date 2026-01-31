"use client";

import {
  ARTIFACT_STATUS_OPTIONS,
  type ArtifactStatus,
} from "@repo/api/src/types/artifact";
import { Input } from "@repo/design-system/components/ui/input";
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
   * Optional className for custom styling
   */
  className?: string;
};

/**
 * Shared metadata section for PRD and Plan editors.
 * Provides status select, owner selection, and approver input fields with consistent styling.
 *
 * Usage:
 * ```tsx
 * <StatusMetadataSection
 *   status={status}
 *   approver={approver}
 *   owner={owner}
 *   teamMembers={teamMembers}
 *   onStatusChange={handleStatusChange}
 *   onApproverChange={handleApproverChange}
 *   onApproverBlur={handleApproverBlur}
 *   onOwnerChange={handleOwnerChange}
 * />
 * ```
 */
export function StatusMetadataSection({
  status,
  approver,
  owner,
  teamMembers,
  onStatusChange,
  onApproverChange,
  onApproverBlur,
  onOwnerChange,
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
        <Label>Owner</Label>
        <UserSelectPopover
          disabled={teamMembers.length === 0}
          onSelect={onOwnerChange}
          placeholder="Select owner..."
          users={teamMembers}
          value={owner}
        />
      </div>

      <div className="space-y-2">
        <Label>Approver</Label>
        <Input
          onBlur={onApproverBlur}
          onChange={(e) => onApproverChange(e.target.value)}
          placeholder="Approver name"
          value={approver}
        />
      </div>
    </MetadataSection>
  );
}
