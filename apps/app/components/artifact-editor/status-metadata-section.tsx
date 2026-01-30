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
import { artifactStatusLabels } from "@/components/status-badge";
import { MetadataSection } from "./metadata-panel";

type StatusMetadataSectionProps = {
  /**
   * Current artifact status
   */
  status: ArtifactStatus;
  /**
   * Current approver value
   */
  approver: string;
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
   * Optional className for custom styling
   */
  className?: string;
};

/**
 * Shared metadata section for PRD and Plan editors.
 * Provides status select and approver input fields with consistent styling.
 *
 * Usage:
 * ```tsx
 * <StatusMetadataSection
 *   status={status}
 *   approver={approver}
 *   onStatusChange={handleStatusChange}
 *   onApproverChange={handleApproverChange}
 *   onApproverBlur={handleApproverBlur}
 * />
 * ```
 */
export function StatusMetadataSection({
  status,
  approver,
  onStatusChange,
  onApproverChange,
  onApproverBlur,
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
