"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { MetadataSection } from "./metadata-panel";

type TargetRepositoryFieldsProps = {
  /**
   * Section title (e.g., "Plan Generation" or "Repository Settings")
   */
  title: string;
  /**
   * Current target repository value
   */
  targetRepo: string;
  /**
   * Current target branch value
   */
  targetBranch: string;
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
 * Shared component for target repository and branch input fields.
 * Used by PRD and Issue metadata panels.
 */
export function TargetRepositoryFields({
  title,
  targetRepo,
  targetBranch,
  onTargetRepoChange,
  onTargetRepoBlur,
  onTargetBranchChange,
  onTargetBranchBlur,
}: Readonly<TargetRepositoryFieldsProps>): React.ReactElement {
  return (
    <MetadataSection separator>
      <h4 className="font-medium text-sm">{title}</h4>

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
  );
}
