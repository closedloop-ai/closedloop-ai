"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import type { DocumentType } from "@repo/api/src/types/document";
import type { DocumentStatusMutationCapability } from "@repo/api/src/types/document-status-mutation";
import type { TagSummary } from "@repo/api/src/types/tag";
import { TagEntityType } from "@repo/api/src/types/tag";
import { priorityTriggerLabel } from "@repo/app/documents/components/artifact-field-menus";
import { ArtifactRepositoriesSummary } from "@repo/app/documents/components/artifact-repositories-summary";
import { AttachFilesButton } from "@repo/app/documents/components/attach-files-button";
import { StatusMetadataSection } from "@repo/app/documents/components/status-metadata-section";
import type { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import {
  useFeatureFlagEnabled,
  useFeatureFlagEnabledOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import {
  DEFAULT_PRIORITY,
  PRIORITY_LABELS,
} from "@repo/app/shared/lib/priority-constants";
import { TagPicker } from "@repo/app/tags/components/tag-picker";
import { Button } from "@repo/design-system/components/ui/button";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
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
import type { ReactNode } from "react";

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
> & { statusMutation?: DocumentStatusMutationCapability };

export type DocumentMetadataBarProps = {
  documentId: string;
  documentType: DocumentType;
  metadata: DocumentMetadataBarView;
  /**
   * When true (default), renders the `ArtifactRepositoriesSummary` chip.
   * Feature passes false — Features don't expose repos at the document level.
   */
  showRepositories?: boolean;
  /**
   * When true (default), shows the tags and the Add tag picker. The Issue
   * page's status strip passes false: its tags are on the Details tab
   * (Nerys, 2026-10-21, ISS-12576).
   */
  showTags?: boolean;
  /** Drawn first, before the status, e.g. the issue's slug. */
  leading?: ReactNode;
  /** Read-only facts drawn after priority, e.g. an issue's due date. */
  children?: ReactNode;
  tags?: TagSummary[];
  /** Merged onto the bar, e.g. a host toolbar that owns the row's padding. */
  className?: string;
};

export function DocumentMetadataBar({
  documentId,
  documentType,
  metadata,
  showRepositories = true,
  showTags = true,
  leading,
  children,
  tags,
  className,
}: Readonly<DocumentMetadataBarProps>) {
  const tagsEnabled = useFeatureFlagEnabled("artifact-tags");
  // ISS-9665: the API now reports an unset priority as `null`. Flag off, this
  // bar keeps showing the `Medium` the serializer used to fold it to; flag on,
  // it says so — with a WORD, not a missing glyph (WCAG 1.4.1). Setting a
  // priority stays available in both states; CLEARING one is the artifact
  // row/grid menu's affordance, not this select's.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const priority =
    metadata.priority ?? (unsetPriorityEnabled ? null : DEFAULT_PRIORITY);
  const priorityOptions = usePriorityOptions();

  return (
    <MetadataPanel className={className} variant="bar">
      {leading}
      <StatusMetadataSection
        artifactId={documentId}
        assignee={metadata.assignee}
        documentType={documentType}
        layout="horizontal"
        onAssigneeChange={metadata.handleAssigneeChange}
        onStatusChange={metadata.handleStatusChange}
        status={metadata.status}
        statusMutation={metadata.statusMutation}
        teamMembers={metadata.teamMembers}
      />
      <Select
        onValueChange={(v) => metadata.handlePriorityChange(v as Priority)}
        // `""`, not `undefined`: Radix treats an undefined `value` as
        // UNCONTROLLED and keeps its own internal selection, so a rejected
        // write rolling `priority` back to unset would leave the trigger
        // showing a value the server never accepted. The empty string is the
        // documented controlled "no selection" value and renders the
        // placeholder below.
        value={priority ?? ""}
      >
        <SelectTrigger
          aria-label={priorityTriggerLabel(priority)}
          className="min-w-0 justify-start gap-1 *:last:hidden"
          size="sm"
        >
          {/* An unset priority arrives as the `""` above, which matches no
              `SelectItem`, so Radix renders the PLACEHOLDER and never the
              children — the unset display has to live in the placeholder, not
              in a branch inside them. */}
          <SelectValue
            placeholder={
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true">
                  <GridEmptyValue />
                </span>
                {NO_PRIORITY_LABEL}
              </span>
            }
          >
            {priority ? (
              <span className="inline-flex items-center gap-1.5">
                <PriorityIcon priority={priority} />
                {PRIORITY_LABELS[priority]}
              </span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {priorityOptions.map((value) => (
            <SelectItem key={value} value={value}>
              <span className="inline-flex items-center gap-1.5">
                <PriorityIcon priority={value} />
                {PRIORITY_LABELS[value]}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
      {showRepositories ? (
        <ArtifactRepositoriesSummary snapshot={metadata.repositorySnapshot} />
      ) : null}
      {tagsEnabled && showTags ? (
        <TagPicker
          appliedTags={tags ?? []}
          entityId={documentId}
          entityType={TagEntityType.Artifact}
          surface={ArtifactStatusEditSurface.Detail}
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
