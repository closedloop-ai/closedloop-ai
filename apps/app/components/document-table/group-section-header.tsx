"use client";

import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { GroupByMode, type GroupSectionDescriptor } from "@/lib/group-by";
import { DOCUMENT_STATUS_TO_ICON } from "@/lib/project-constants";

type GroupSectionHeaderProps = Readonly<{
  icon: ReactNode;
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
}>;

export function GroupSectionHeader({
  icon,
  label,
  count,
  isOpen,
  onToggle,
}: GroupSectionHeaderProps) {
  return (
    <button
      className="flex w-full items-center gap-2.5 border-b bg-muted/50 py-2.5 pr-4 pl-[18px] font-medium text-sm hover:bg-accent/50"
      onClick={onToggle}
      type="button"
    >
      {isOpen ? (
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      {icon}
      <span>{label}</span>
      <span className="text-muted-foreground text-xs">{count}</span>
    </button>
  );
}

/** Icon matching a section's grouping mode (status / priority / assignee). */
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
