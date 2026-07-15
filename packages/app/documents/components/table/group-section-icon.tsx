"use client";

import type {
  DocumentStatus,
  FeatureStatus,
} from "@repo/api/src/types/document";
import {
  DocumentType,
  FeatureStatus as FeatureStatusValue,
} from "@repo/api/src/types/document";
import { ArtifactStatusIcon } from "@repo/app/documents/components/artifact-status-icon";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { FeatureStatusIcon } from "@repo/app/documents/components/feature-status-icon";
import {
  GroupByMode,
  type GroupSectionDescriptor,
} from "@repo/app/documents/lib/group-by";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { CircleDashedIcon } from "lucide-react";
import type { ReactNode } from "react";

const DOCUMENT_TYPES = new Set<string>([
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Template,
]);

export function sectionIcon(descriptor: GroupSectionDescriptor): ReactNode {
  if (descriptor.mode === GroupByMode.Status && descriptor.status) {
    const { status, artifactType } = descriptor;
    // Render the icon for the group's artifact type — Documents and Features
    // diverge on IN_REVIEW (PRD-495). IN_REVIEW is shared, so render the same
    // canonical Feature form used by ArtifactStatusIcon instead of depending on
    // whichever artifact type was encountered first in the group. Fall back to
    // the status-dispatched icon for branch/session groups (whose statuses
    // aren't Document/Feature values).
    if (status === FeatureStatusValue.InReview) {
      return (
        <FeatureStatusIcon size={16} status={FeatureStatusValue.InReview} />
      );
    }
    if (artifactType === DocumentType.Feature) {
      return <FeatureStatusIcon size={16} status={status as FeatureStatus} />;
    }
    if (artifactType && DOCUMENT_TYPES.has(artifactType)) {
      return <DocumentStatusIcon size={16} status={status as DocumentStatus} />;
    }
    return <ArtifactStatusIcon size={16} status={status} />;
  }
  if (descriptor.mode === GroupByMode.Priority) {
    if (descriptor.priority) {
      return <PriorityIcon priority={descriptor.priority} size={16} />;
    }
    return <CircleDashedIcon className="h-4 w-4 text-muted-foreground" />;
  }
  return (
    <AssigneeAvatar
      assignee={descriptor.assignee ?? null}
      className="size-4"
      disableLink
      disableTooltip
    />
  );
}
