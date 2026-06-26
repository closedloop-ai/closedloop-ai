"use client";

import { Label } from "@repo/design-system/components/ui/label";
import { MetadataSection } from "@repo/design-system/components/ui/metadata-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { type ComponentProps, useId } from "react";

type StatusMetadataOption = {
  value: string;
  label: string;
  iconStatus: ComponentProps<typeof StatusIcon>["status"];
};

export type StatusMetadataSectionProps = {
  status: string;
  assignee: User | null;
  teamMembers: User[];
  onStatusChange: (status: string) => void;
  onAssigneeChange: (user: User | null) => void;
  options: StatusMetadataOption[];
  className?: string;
  layout?: "horizontal" | "vertical";
};

export function StatusMetadataSection({
  status,
  assignee,
  teamMembers,
  onStatusChange,
  onAssigneeChange,
  options,
  className,
  layout = "vertical",
}: Readonly<StatusMetadataSectionProps>) {
  const statusId = useId();

  const statusOptions = options.map((statusOption) => (
    <SelectItem key={statusOption.value} value={statusOption.value}>
      <span className="inline-flex items-center gap-1.5">
        <StatusIcon size={16} status={statusOption.iconStatus} />
        {statusOption.label}
      </span>
    </SelectItem>
  ));

  const content =
    layout === "horizontal" ? (
      <>
        <Select onValueChange={onStatusChange} value={status}>
          <SelectTrigger
            className="min-w-0 justify-start gap-1 [&>:last-child]:hidden"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>{statusOptions}</SelectContent>
        </Select>
        <UserSelectPopover
          className="h-8 w-auto min-w-[7rem] px-3"
          disabled={teamMembers.length === 0}
          onSelect={onAssigneeChange}
          placeholder="Select assignee..."
          users={teamMembers}
          value={assignee}
        />
      </>
    ) : (
      <>
        <div className="space-y-2">
          <Label htmlFor={statusId}>Status</Label>
          <Select onValueChange={onStatusChange} value={status}>
            <SelectTrigger
              className="min-w-0 justify-start bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent [&>:last-child]:hidden"
              id={statusId}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{statusOptions}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Assignee</Label>
          <UserSelectPopover
            className="bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
            disabled={teamMembers.length === 0}
            onSelect={onAssigneeChange}
            placeholder="Select assignee..."
            users={teamMembers}
            value={assignee}
          />
        </div>
      </>
    );

  return (
    <MetadataSection className={className} layout={layout}>
      {content}
    </MetadataSection>
  );
}
