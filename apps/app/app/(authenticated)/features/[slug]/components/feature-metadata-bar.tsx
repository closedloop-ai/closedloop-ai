"use client";

import type { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { AttachFilesButton } from "@/components/document-editor/attach-files-button";
import { DocumentTypeBadge } from "@/components/document-editor/document-type-badge";
import { MetadataPanel } from "@/components/document-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/document-editor/status-metadata-section";
import type { useDocumentMetadata } from "@/hooks/document-editing/use-document-metadata";
import { PRIORITY_LABELS } from "@/lib/project-constants";

export type FeatureMetadataBarProps = {
  documentId: string;
  metadata: ReturnType<typeof useDocumentMetadata>;
};

/**
 * Inline Properties Bar for Feature detail pages. Features don't expose
 * `target repo`/`target branch` in the bar (they inherit from the parent
 * project), so this variant drops `TargetRepositoryFields` but otherwise
 * mirrors the PRD/Plan bars.
 */
export function FeatureMetadataBar({
  documentId,
  metadata,
}: Readonly<FeatureMetadataBarProps>) {
  return (
    <MetadataPanel variant="bar">
      <DocumentTypeBadge type={DocumentType.Feature} />
      <StatusMetadataSection
        assignee={metadata.assignee}
        layout="horizontal"
        onAssigneeChange={metadata.handleAssigneeChange}
        onStatusChange={metadata.handleStatusChange}
        status={metadata.status}
        teamMembers={metadata.teamMembers}
      />
      <Select
        onValueChange={(v) => metadata.handlePriorityChange(v as Priority)}
        value={metadata.priority}
      >
        <SelectTrigger
          className="min-w-0 justify-start gap-1 *:last:hidden"
          size="sm"
        >
          <SelectValue>
            <span className="inline-flex items-center gap-1.5">
              <PriorityIcon priority={metadata.priority} />
              {PRIORITY_LABELS[metadata.priority]}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              <span className="inline-flex items-center gap-1.5">
                <PriorityIcon priority={value as Priority} />
                {label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <AttachFilesButton documentId={documentId} />
    </MetadataPanel>
  );
}
