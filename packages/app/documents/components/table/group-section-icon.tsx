"use client";

import {
  GroupByMode,
  type GroupSectionDescriptor,
} from "@repo/app/documents/lib/group-by";
import { DOCUMENT_STATUS_TO_ICON } from "@repo/app/projects/lib/project-constants";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { CircleDashedIcon } from "lucide-react";
import type { ReactNode } from "react";

export function sectionIcon(descriptor: GroupSectionDescriptor): ReactNode {
  if (descriptor.mode === GroupByMode.Status && descriptor.status) {
    return (
      <StatusIcon
        size={16}
        status={DOCUMENT_STATUS_TO_ICON[descriptor.status]}
      />
    );
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
