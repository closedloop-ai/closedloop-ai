import type { Priority } from "@repo/api/src/types/common";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { AttachFilesButton } from "@/components/document-editor/attach-files-button";
import { MetadataPanel } from "@/components/document-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/document-editor/status-metadata-section";
import { TargetRepositoryFields } from "@/components/document-editor/target-repository-fields";
import type { useDocumentMetadata } from "@/hooks/document-editing/use-document-metadata";
import { PRIORITY_LABELS } from "@/lib/project-constants";

export type PlanMetadataBarProps = {
  documentId: string;
  metadata: ReturnType<typeof useDocumentMetadata>;
};

export function PlanMetadataBar({
  documentId,
  metadata,
}: Readonly<PlanMetadataBarProps>) {
  return (
    <MetadataPanel variant="bar">
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
          className="min-w-0 justify-start gap-1 bg-transparent *:last:hidden dark:bg-transparent"
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
      <TargetRepositoryFields
        layout="horizontal"
        onTargetBranchBlur={metadata.handleTargetBranchBlur}
        onTargetBranchChange={metadata.handleTargetBranchChange}
        onTargetRepoBlur={metadata.handleTargetRepoBlur}
        onTargetRepoChange={metadata.handleTargetRepoChange}
        separator={false}
        targetBranch={metadata.targetBranch}
        targetRepo={metadata.targetRepo}
        title=""
      />
      <AttachFilesButton documentId={documentId} />
    </MetadataPanel>
  );
}
