"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { DocumentType } from "@repo/api/src/types/document";
import type { TagSummary } from "@repo/api/src/types/tag";
import { TagEntityType } from "@repo/api/src/types/tag";
import { ArtifactRepositoriesSummary } from "@repo/app/documents/components/artifact-repositories-summary";
import { AttachFilesButton } from "@repo/app/documents/components/attach-files-button";
import { DocumentTypeBadge } from "@repo/app/documents/components/document-type-badge";
import { StatusMetadataSection } from "@repo/app/documents/components/status-metadata-section";
import type { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { TagPicker } from "@repo/app/tags/components/tag-picker";
import { Button } from "@repo/design-system/components/ui/button";
import { MetadataPanel } from "@repo/design-system/components/ui/metadata-panel";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { TagIcon } from "lucide-react";

/**
 * The slice of `useDocumentMetadata`'s result this bar actually reads. Derived
 * from the hook (so the field types can't drift) but narrowed to these fields
 * only, so unrelated changes to the hook aren't breaking changes for callers.
 */
export type DocumentMetadataBarView = Pick<
  ReturnType<typeof useDocumentMetadata>,
  | "assignee"
  | "handleAssigneeChange"
  | "handlePriorityChange"
  | "handleStatusChange"
  | "priority"
  | "repositorySnapshot"
  | "status"
  | "teamMembers"
>;

export type DocumentMetadataBarProps = {
  documentId: string;
  documentType: DocumentType;
  metadata: DocumentMetadataBarView;
  /**
   * When true (default), renders the `ArtifactRepositoriesSummary` chip.
   * Feature passes false — Features don't expose repos at the document level.
   */
  showRepositories?: boolean;
  tags?: TagSummary[];
};

export function DocumentMetadataBar({
  documentId,
  documentType,
  metadata,
  showRepositories = true,
  tags,
}: Readonly<DocumentMetadataBarProps>) {
  const tagsEnabled = useFeatureFlagEnabled("artifact-tags");

  return (
    <MetadataPanel variant="bar">
      <DocumentTypeBadge type={documentType} />
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
      {showRepositories ? (
        <ArtifactRepositoriesSummary snapshot={metadata.repositorySnapshot} />
      ) : null}
      {tagsEnabled ? (
        <TagPicker
          appliedTags={tags ?? []}
          entityId={documentId}
          entityType={TagEntityType.Artifact}
          trigger={
            <Button className="gap-1.5" size="sm" variant="outline">
              <TagIcon className="h-4 w-4" />
              Add tag
            </Button>
          }
        />
      ) : null}
      <AttachFilesButton documentId={documentId} />
    </MetadataPanel>
  );
}
